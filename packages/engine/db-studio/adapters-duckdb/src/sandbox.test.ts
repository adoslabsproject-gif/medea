/**
 * Bug-bounty test — FS-escape sandbox del motore DuckDB embedded.
 *
 * DuckDB gira IN-PROCESS dentro il container del tenant (come SQLite). Senza
 * il sandbox `enable_external_access=false`, il raw-SQL del DB Studio può
 * leggere/scrivere file arbitrari dell'host:
 *   - `read_text('/etc/hosts')`     → esfiltrazione lettura
 *   - `read_csv('/etc/passwd')`     → esfiltrazione lettura
 *   - `COPY (…) TO '/tmp/x.csv'`    → scrittura arbitraria
 *   - `ATTACH 'altro.db'`           → montaggio DB esterno
 *
 * Questi test ISTANZIANO l'adapter reale ed eseguono gli attacchi: devono
 * essere TUTTI bloccati. In parallelo verificano che le operazioni legittime
 * (CREATE/INSERT/SELECT, multi-statement atomico, file DB persistente) NON
 * regrediscano. Non è source-inspection: è comportamento end-to-end.
 *
 * Break-and-restore manuale verificato: rimuovendo DUCKDB_SANDBOX_CONFIG da
 * connect(), `read_text('/etc/hosts')` ritorna il contenuto del file host e
 * questi test falliscono → il test becca davvero il bug.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '@medea/engine-db-studio-core';
import { DuckDbAdapter } from './index.js';

function makeDb(database?: string): Database {
  const now = new Date().toISOString();
  return {
    id: 'test-duck',
    tenantId: 'tenant-a',
    name: 'duck-sandbox-test',
    connection: { engine: 'duckdb', embedded: true, ...(database ? { database } : {}) },
    tables: [],
    relations: [],
    createdAt: now,
    updatedAt: now,
  };
}

const adapters: DuckDbAdapter[] = [];
async function connect(database?: string): Promise<DuckDbAdapter> {
  const a = new DuckDbAdapter();
  await a.connect(makeDb(database));
  adapters.push(a);
  return a;
}

afterEach(async () => {
  while (adapters.length) {
    const a = adapters.pop();
    if (a)
      await a.disconnect().catch(() => {
        /* ignore */
      });
  }
});

describe('DuckDB sandbox — lettura file host bloccata', () => {
  it('read_text() su un file host esistente è rifiutato (no esfiltrazione)', async () => {
    const a = await connect();
    // /etc/hosts esiste su Linux container e macOS dev → target stabile.
    await expect(a.executeRaw(`SELECT content FROM read_text('/etc/hosts')`)).rejects.toThrow(
      /Permission|file system|external access|not allowed/i,
    );
  });

  it('read_csv() su un file host reale è rifiutato anche se il file esiste', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duck-escape-'));
    const csv = join(dir, 'secret.csv');
    writeFileSync(csv, 'a,b\n1,2\n');
    try {
      const a = await connect();
      await expect(a.executeRaw(`SELECT * FROM read_csv('${csv}')`)).rejects.toThrow(
        /Permission|file system|external access|not allowed/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('DuckDB sandbox — scrittura file host bloccata', () => {
  it('COPY (…) TO file host è rifiutato e NON crea il file (no exfil su disco)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duck-escape-'));
    const out = join(dir, 'exfil.csv');
    try {
      const a = await connect();
      await expect(
        a.executeRaw(`COPY (SELECT 42 AS x) TO '${out}' (HEADER, DELIMITER ',')`),
      ).rejects.toThrow(/Permission|file system|external access|not allowed/i);
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('DuckDB sandbox — ATTACH/estensioni bloccati', () => {
  it('ATTACH di un DB file esterno è rifiutato con errore di dominio chiaro', async () => {
    const a = await connect();
    // 2° layer assertSafeRawStatement → messaggio FlowForge prima del motore.
    await expect(a.executeRaw(`ATTACH '/tmp/other.duckdb' AS other`)).rejects.toThrow(
      /ATTACH\/DETACH non consentito|Permission|external access/i,
    );
  });

  it('INSTALL/LOAD di estensioni native da disco è rifiutato', async () => {
    const a = await connect();
    await expect(a.executeRaw(`INSTALL '/tmp/evil.duckdb_extension'`)).rejects.toThrow(
      /Permission|file system|external access|not allowed|Cannot/i,
    );
  });

  it('il re-enable via SET enable_external_access=true è bloccato (lock_configuration)', async () => {
    const a = await connect();
    await expect(a.executeRaw(`SET enable_external_access=true`)).rejects.toThrow(
      /Cannot change configuration|locked|Invalid Input/i,
    );
  });
});

describe('DuckDB sandbox — nessuna regressione sulle operazioni legittime', () => {
  it('CREATE/INSERT/SELECT in-memory funziona normalmente', async () => {
    const a = await connect();
    await a.executeRaw(`CREATE TABLE t (id INTEGER, v TEXT)`);
    await a.executeRaw(`INSERT INTO t VALUES (1, 'uno'), (2, 'due')`);
    const res = (await a.executeRaw(`SELECT count(*) AS n FROM t`)) as {
      rows: { n: number | bigint }[];
    };
    expect(Number(res.rows[0]?.n)).toBe(2);
  });

  it('multi-statement atomico (rollback su errore) resta integro', async () => {
    const a = await connect();
    await a.executeRaw(`CREATE TABLE t2 (id INTEGER PRIMARY KEY)`);
    // Secondo statement viola la PK → tutta la batch rolla indietro.
    await expect(
      a.executeRaw(`INSERT INTO t2 VALUES (1); INSERT INTO t2 VALUES (1);`),
    ).rejects.toThrow();
    const res = (await a.executeRaw(`SELECT count(*) AS n FROM t2`)) as {
      rows: { n: number | bigint }[];
    };
    expect(Number(res.rows[0]?.n)).toBe(0);
  });

  it('un database DuckDB su FILE persistente continua ad aprirsi e a scrivere', async () => {
    // Il file del DB primario è aperto dal driver, NON via SQL → il sandbox
    // enable_external_access=false non deve impedirne l'uso.
    const dir = mkdtempSync(join(tmpdir(), 'duck-persist-'));
    const file = join(dir, 'data.duckdb');
    try {
      const a1 = await connect(file);
      await a1.executeRaw(`CREATE TABLE persisted (k TEXT)`);
      await a1.executeRaw(`INSERT INTO persisted VALUES ('survives')`);
      await a1.disconnect();
      adapters.pop(); // già disconnesso

      const a2 = await connect(file);
      const res = (await a2.executeRaw(`SELECT k FROM persisted`)) as { rows: { k: string }[] };
      expect(res.rows[0]?.k).toBe('survives');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
