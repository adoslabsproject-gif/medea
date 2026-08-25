import { describe, it, expect, afterEach } from 'vitest';
import { NodeDefSchema } from '@medea/engine-core-schema';
import {
  dbNodes,
  dbQueryNode,
  dbInsertNode,
  dbInsertBatchNode,
  dbUpdateNode,
  dbDeleteNode,
} from './index.js';

describe('db workflow nodes', () => {
  it('esporta il SET ESATTO di id (7 db_ + 2 rag_)', () => {
    // Contratto per-id, non un conteggio magico: cattura sia aggiunte che
    // rimozioni e si auto-documenta. Aggiornato 2026-06-14: ai 7 storici si
    // aggiungono db_remote_ssh_query (tunnel SSH, commit f0b0124c) e
    // rag_search/rag_ingest (retrieval, commit a0a7c881). Tolto il 2026-08-06
    // db_subscribe: non aveva né executor né watcher — nessun codice lo
    // eseguiva, e `trigger_db_change` fa la stessa cosa davvero (ADR 0010).
    expect([...dbNodes].map((n) => n.def.id).sort()).toEqual([
      'db_delete',
      'db_insert',
      'db_insert_batch',
      'db_query',
      'db_remote_ssh_query',
      'db_sql_query',
      'db_update',
      'rag_ingest',
      'rag_search',
    ]);
  });

  it('every node validates against NodeDefSchema', () => {
    for (const node of dbNodes) {
      const result = NodeDefSchema.safeParse(node.def);
      if (!result.success) {
        throw new Error(`${node.def.id} failed: ${result.error.message}`);
      }
      expect(result.success).toBe(true);
    }
  });

  it('ogni id appartiene a una famiglia nota: db_ (dati) o rag_ (retrieval)', () => {
    // I nodi RAG (rag_search/rag_ingest) NON sono db_-prefissati di proposito:
    // sono una famiglia distinta. Il contratto è "namespace noto", non "db_".
    for (const node of dbNodes) {
      expect(
        /^(db_|rag_)/.test(node.def.id),
        `id "${node.def.id}" fuori dalle famiglie note db_/rag_`,
      ).toBe(true);
    }
  });

  it('query + insert nodes have executors; update/delete pending engine integration', () => {
    expect(typeof dbQueryNode.executor).toBe('function');
    expect(typeof dbInsertNode.executor).toBe('function');
    expect(dbUpdateNode.executor).toBeUndefined();
    expect(dbDeleteNode.executor).toBeUndefined();
  });

  it('delete node has a confirmation boolean (idiot-proof)', () => {
    const confirm = dbDeleteNode.def.configFields?.find((f) => f.key === 'confirmDelete');
    expect(confirm).toBeDefined();
    expect(confirm?.required).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────────
  // A3.3 stabilization contract (2026-06-05) — DB nodi portati a STABLE.
  // Contratto: description ≥150 char, IT first sentence, use case enumerato.
  // ────────────────────────────────────────────────────────────────────────
  describe('A3.3 stabilized DB contract', () => {
    const A33_STABILIZED_DB_NODES = [
      dbQueryNode,
      dbInsertNode,
      dbUpdateNode,
      dbDeleteNode,
    ];

    it('every A3.3 stabilized DB node has description ≥150 char + ≥25 distinct words + IT + Use case (anti-gaming)', () => {
      const englishVerbs =
        /^(Run|Send|Trigger|Execute|Read|Write|Get|Update|Delete|Create|Fetch|Query|Pause|Reshape|Call|Catch|Invoke|Push|Pull|Poll|Auto|Watch|Make|Build|Sleep|Wait|Receive|Calculate|Connect|Insert|Iterate)\b/;
      const offenders: string[] = [];
      for (const node of A33_STABILIZED_DB_NODES) {
        const desc = node.def.description ?? '';
        if (desc.length < 150) offenders.push(`${node.def.id}: desc ${String(desc.length)} < 150`);
        if (englishVerbs.test(desc))
          offenders.push(`${node.def.id}: EN verb start "${desc.slice(0, 40)}…"`);
        const distinctWords = new Set(desc.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
        if (distinctWords.size < 25)
          offenders.push(
            `${node.def.id}: only ${String(distinctWords.size)} distinct words (<25 = gameable)`,
          );
        if (!/use case/i.test(desc)) offenders.push(`${node.def.id}: missing use case`);
      }
      if (offenders.length > 0) throw new Error(`A3.3 DB violations:\n${offenders.join('\n')}`);
      expect(offenders).toHaveLength(0);
    });
  });
});

describe('db_insert_batch — N2 audit: forbidden tokens in childRowsExpression', () => {
  // Helper per chiamare l'executor con un'espressione e capire se passa.
  const runExpr = async (expr: string): Promise<unknown> => {
    const ctx = {
      tenantId: 't1',
      runId: 'r1',
      nodeOutputs: {},
      env: {},
    };
    return dbInsertBatchNode.executor!(
      {
        databaseId: 'db1',
        headerTable: 't',
        headerRowJson: '{"id":1}',
        childTable: 'ct',
        refColumn: 'fk',
        childRowsExpression: expr,
      },
      undefined,
      ctx as never,
    );
  };

  it('REGRESSION: eval literal → throw "forbidden token"', async () => {
    await expect(runExpr('eval("1+1")')).rejects.toThrow(/forbidden|Forbidden/);
  });

  it('REGRESSION: Function constructor → throw', async () => {
    await expect(runExpr('Function("return process")()')).rejects.toThrow(/forbidden/);
  });

  it('REGRESSION: require → throw', async () => {
    await expect(runExpr('require("fs")')).rejects.toThrow(/forbidden/);
  });

  it('REGRESSION: process.env → throw', async () => {
    await expect(runExpr('process.env.SECRET')).rejects.toThrow(/forbidden/);
  });

  it('REGRESSION: Unicode escape `\\u0065val` → decoded, blocked', async () => {
    await expect(runExpr('\\u0065val("hack")')).rejects.toThrow(/forbidden/);
  });

  it('REGRESSION: hex escape `\\x65val` → decoded, blocked', async () => {
    await expect(runExpr('\\x65val("hack")')).rejects.toThrow(/forbidden/);
  });

  it('REGRESSION: string lookup `["constructor"]` → blocked', async () => {
    await expect(runExpr('({})["constructor"]')).rejects.toThrow(/forbidden/);
  });

  it('REGRESSION: concatenation in bracket `["co"+"de"]` → blocked', async () => {
    await expect(runExpr('({})["co"+"nstructor"]')).rejects.toThrow(/forbidden/);
  });

  it('REGRESSION: fetch identifier → blocked', async () => {
    await expect(runExpr('fetch("http://evil")')).rejects.toThrow(/forbidden/);
  });

  it('REGRESSION: setTimeout → blocked', async () => {
    await expect(runExpr('setTimeout(()=>{}, 0)')).rejects.toThrow(/forbidden/);
  });

  it('REGRESSION: globalThis → blocked', async () => {
    await expect(runExpr('globalThis.process')).rejects.toThrow(/forbidden/);
  });

  it('REGRESSION: __proto__ → blocked', async () => {
    await expect(runExpr('({}).__proto__')).rejects.toThrow(/forbidden/);
  });

  it('expression > 4000 chars (JS path, not literal JSON) → throw', async () => {
    // Path JS (new Function) — espressione che NON inizia con `[`.
    // Lunga > 4000 char triggera il length check di dbAssertSafeExpression.
    await expect(runExpr('input.x' + '+0'.repeat(2100))).rejects.toThrow(/4000/);
  });

  it('expression valida `[1,2,3]` viene parsata come literal JSON (bypass new Function)', async () => {
    // childExpr che inizia con `[` → jsonParse path, no new Function, no
    // sandbox check (e nemmeno serve). Verifica che non venga falsamente
    // bloccato.
    // Il chiamato fallisce dopo (DB API non raggiungibile in test) ma NON
    // per \"forbidden token\".
    try {
      await runExpr('[{"id":1}]');
    } catch (e) {
      expect((e as Error).message).not.toMatch(/forbidden/);
    }
  });
});

describe('🚨 db_query — LIMIT sempre applicato (anti-OOM, era aspirazionale: UI 100 mai enforced)', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function captureSpec(): { specs: Record<string, unknown>[] } {
    const specs: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      specs.push(JSON.parse(init.body as string) as Record<string, unknown>);
      return { ok: true, json: async () => ({ rows: [], rowCount: 0 }) } as Response;
    }) as unknown as typeof fetch;
    return { specs };
  }
  const ctx = { tenantId: 't1', runId: 'r1', nodeOutputs: {}, env: {} };
  const run = (cfg: Record<string, unknown>) =>
    dbQueryNode.executor!({ databaseId: 'db1', table: 't', ...cfg }, undefined, ctx as never);

  it('🚨 limit ASSENTE → default 100 nello spec (NON scarica tutta la tabella)', async () => {
    const cap = captureSpec();
    await run({});
    expect(cap.specs[0]!.limit).toBe(100);
  });
  it('🚨 limit vuoto "" → default 100 (non undefined → niente query unbounded)', async () => {
    const cap = captureSpec();
    await run({ limit: '' });
    expect(cap.specs[0]!.limit).toBe(100);
  });
  it('limit esplicito valido → rispettato', async () => {
    const cap = captureSpec();
    await run({ limit: 250 });
    expect(cap.specs[0]!.limit).toBe(250);
  });
  it('🚨 limit oltre il max server (10000) → clampato a 10000', async () => {
    const cap = captureSpec();
    await run({ limit: 999999 });
    expect(cap.specs[0]!.limit).toBe(10_000);
  });
  it('🚨 limit invalido (NaN/negativo) → default 100', async () => {
    const cap = captureSpec();
    await run({ limit: 'abc' });
    expect(cap.specs[0]!.limit).toBe(100);
    const cap2 = captureSpec();
    await run({ limit: -5 });
    expect(cap2.specs[0]!.limit).toBe(100);
  });
});

describe('🚨 SECURITY — databaseId path-injection verso API interna (X-Internal-Token)', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });
  const ctx = { tenantId: 't1', runId: 'r1', nodeOutputs: {}, env: {} };

  function captureUrl(): { urls: string[] } {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ rows: [], rowCount: 0 }) } as Response;
    }) as unknown as typeof fetch;
    return { urls };
  }

  it.each([
    ['path traversal verso /internal', '../../internal/egress-allowlist'],
    ['slash (sub-path)', 'db/x'],
    ['query string', 'db?admin=1'],
    ['fragment', 'db#x'],
    ['percent-encoded dot', 'db%2e%2e'],
    ['troppo lungo (>128)', 'a'.repeat(129)],
  ])("databaseId con %s → throw, NESSUN fetch all'API interna", async (_l, bad) => {
    // MUTATION: senza reqDatabaseId questi id raggiungerebbero callDbApi col
    // token interno (privilege escalation) → cap.urls non vuoto → rosso.
    const cap = captureUrl();
    await expect(
      dbQueryNode.executor!({ databaseId: bad, table: 't' }, undefined, ctx as never),
    ).rejects.toThrow(/databaseId non valido/);
    expect(cap.urls).toHaveLength(0);
  });

  it('databaseId valido → URL interno pulito, encodato, senza traversal', async () => {
    const cap = captureUrl();
    await dbQueryNode.executor!({ databaseId: 'd1-AbZ_09', table: 't' }, undefined, ctx as never);
    expect(cap.urls[0]).toContain('/api/v1/db/databases/d1-AbZ_09/query');
    expect(cap.urls[0]).not.toContain('..');
  });
});
