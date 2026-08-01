import { describe, it, expect } from 'vitest';
import { resolveDatabaseId, remapNodeDatabaseIds, localWritableDbs } from './scaffold-table-provision.js';

describe('localWritableDbs — le tabelle workflow vanno SOLO in DB locali (bug NHA read-only)', () => {
  it('🚨 mix locale+remoto → SOLO i locali (embedded), default = primo locale', () => {
    const r = localWritableDbs([
      { id: 'nha', connection: { embedded: false } },   // remoto NHA (read-only)
      { id: 'loc1', connection: { embedded: true } },   // locale
      { id: 'loc2', connection: { embedded: true } },
    ]);
    expect([...r.ids].sort()).toEqual(['loc1', 'loc2']);
    expect(r.defaultId).toBe('loc1');
  });

  it('🚨 SOLO remoto (caso senza1dio: unico DB = NHA) → vuoto + default undefined → il caller crea on-demand', () => {
    const r = localWritableDbs([{ id: 'nha', connection: { embedded: false } }]);
    expect(r.ids.size).toBe(0);
    expect(r.defaultId).toBeUndefined();
  });

  it('🚨 connection assente / embedded undefined → ESCLUSO (non scrivibile a colpo sicuro)', () => {
    const r = localWritableDbs([{ id: 'a' }, { id: 'b', connection: {} }, { id: 'c', connection: { embedded: true } }]);
    expect([...r.ids]).toEqual(['c']);
  });

  it('lista vuota → vuoto', () => {
    const r = localWritableDbs([]);
    expect(r.ids.size).toBe(0);
    expect(r.defaultId).toBeUndefined();
  });

  it('🔒 contract: un remoto NON è mai un id valido per resolveDatabaseId → la tabella NON ci finisce', () => {
    const dbs = [{ id: 'nha-remote', connection: { embedded: false } }, { id: 'local-1', connection: { embedded: true } }];
    const { ids, defaultId } = localWritableDbs(dbs);
    // lo scaffold ha messo l'id del remoto → resolve NON lo onora, ripiega sul locale
    expect(resolveDatabaseId('nha-remote', ids, defaultId)).toBe('local-1');
  });
});

describe('resolveDatabaseId — self-heal del databaseId fake dello scaffold', () => {
  const valid = new Set(['real-1', 'real-2']);

  it('id richiesto VALIDO → usa quello', () => {
    expect(resolveDatabaseId('real-2', valid, 'real-1')).toBe('real-2');
  });

  it('id richiesto FAKE (non esiste) → fallback al default', () => {
    expect(resolveDatabaseId('QhktHRtIKHL5aniYhgRvz', valid, 'real-1')).toBe('real-1');
  });

  it('nessun id richiesto → default', () => {
    expect(resolveDatabaseId(undefined, valid, 'real-1')).toBe('real-1');
  });

  it('id fake + nessun default → undefined (il chiamante crea un DB)', () => {
    expect(resolveDatabaseId('fake', valid, undefined)).toBeUndefined();
  });
});

describe('remapNodeDatabaseIds — i nodi puntano al DB reale (runtime-safe)', () => {
  it('rimappa config.databaseId fake → reale e conta i nodi corretti', () => {
    const nodes = [
      { id: 'db1', config: { databaseId: 'fake', table: 't' } },
      { id: 'db2', config: { databaseId: 'fake' } },
      { id: 'http', config: { url: 'x' } }, // niente databaseId → invariato
    ];
    const remap = new Map([['fake', 'real-1']]);
    const count = remapNodeDatabaseIds(nodes, remap);
    expect(count).toBe(2);
    expect(nodes[0]!.config.databaseId).toBe('real-1');
    expect(nodes[1]!.config.databaseId).toBe('real-1');
    expect((nodes[2]!.config as Record<string, unknown>).databaseId).toBeUndefined();
  });

  it('remap vuoto → nessuna modifica (early return)', () => {
    const nodes = [{ id: 'db', config: { databaseId: 'fake' } }];
    expect(remapNodeDatabaseIds(nodes, new Map())).toBe(0);
    expect(nodes[0]!.config.databaseId).toBe('fake');
  });

  it('id non nella remap → invariato (non tocca i DB validi)', () => {
    const nodes = [{ id: 'db', config: { databaseId: 'real-2' } }];
    remapNodeDatabaseIds(nodes, new Map([['fake', 'real-1']]));
    expect(nodes[0]!.config.databaseId).toBe('real-2');
  });

  it('nodi senza config / config non-oggetto → no crash', () => {
    const nodes = [{ id: 'x' }, null, { id: 'y', config: null }];
    expect(() => remapNodeDatabaseIds(nodes, new Map([['fake', 'real']]))).not.toThrow();
  });
});

/**
 * provisionDeclaredTables (2026-07-06) — orchestratore estratto da
 * routes/workflows.ts e riusato da /templates/:id/instantiate. DbStudio
 * iniettato (fake in-memory) → comportamentale, niente rete/fs.
 */
import { provisionDeclaredTables, type DbStudioLike, type DeclaredTable } from './scaffold-table-provision.js';

function fakeLog() {
  return { info: () => undefined, warn: () => undefined };
}

function fakeDbStudio(opts: {
  existingDbs?: { id: string; connection?: { embedded?: boolean } }[];
  failMigrationWith?: string;
} = {}) {
  const migrations: { dbId: string; actions: unknown[] }[] = [];
  const inserts: { dbId: string; table: string; row: Record<string, unknown> }[] = [];
  const created: string[] = [];
  const studio: DbStudioLike = {
    list: () => opts.existingDbs ?? [],
    create: (input) => { created.push(input.name); return { id: 'db-ondemand', connection: { embedded: true } }; },
    applyMigration: (dbId, actions) => {
      if (opts.failMigrationWith !== undefined) throw new Error(opts.failMigrationWith);
      migrations.push({ dbId, actions });
    },
    insert: (dbId, table, row) => { inserts.push({ dbId, table, row }); },
  };
  return { studio, migrations, inserts, created };
}

const TBL: DeclaredTable = {
  databaseId: 'placeholder_db',
  name: 'demo_table',
  columns: [{ name: 'id', type: 'integer', primaryKey: true, nullable: false }],
  seedRows: [{ id: 1 }, { id: 2 }],
};

describe('provisionDeclaredTables', () => {
  it('DB locale esistente: crea la tabella lì, remap placeholder→id reale, seed inserite', async () => {
    const { studio, migrations, inserts } = fakeDbStudio({ existingDbs: [{ id: 'db-local', connection: { embedded: true } }] });
    const res = await provisionDeclaredTables(studio, 't1', [TBL], fakeLog());
    expect(res.tablesCreated).toEqual([{ name: 'demo_table', ok: true }]);
    expect(res.dbRemap.get('placeholder_db')).toBe('db-local');
    expect(migrations[0]!.dbId).toBe('db-local');
    expect(inserts).toHaveLength(2);
    expect(res.seededRows).toBe(2);
  });

  it('🚨 nessun DB nel tenant → crea workflow_data on-demand e lo usa', async () => {
    const { studio, migrations, created } = fakeDbStudio();
    const res = await provisionDeclaredTables(studio, 't1', [TBL], fakeLog());
    expect(created).toEqual(['workflow_data']);
    expect(migrations[0]!.dbId).toBe('db-ondemand');
    expect(res.dbRemap.get('placeholder_db')).toBe('db-ondemand');
  });

  it('🚨 DB ESTERNO (non-embedded) ignorato: le tabelle NON vanno su DB altrui', async () => {
    const { studio, migrations } = fakeDbStudio({ existingDbs: [{ id: 'db-remoto', connection: { embedded: false } }] });
    await provisionDeclaredTables(studio, 't1', [TBL], fakeLog());
    expect(migrations[0]!.dbId).toBe('db-ondemand'); // NON db-remoto
  });

  it('🚨 tabella già esistente → ok idempotente ma seedRows SALTATE (mai toccare dati del tenant)', async () => {
    const { studio, inserts } = fakeDbStudio({
      existingDbs: [{ id: 'db-local', connection: { embedded: true } }],
      failMigrationWith: 'table demo_table already exists',
    });
    const res = await provisionDeclaredTables(studio, 't1', [TBL], fakeLog());
    expect(res.tablesCreated).toEqual([{ name: 'demo_table', ok: true }]);
    expect(inserts).toHaveLength(0);
    expect(res.seededRows).toBe(0);
  });

  it('errore SQL vero → ok:false con errore, non throw (best-effort)', async () => {
    const { studio } = fakeDbStudio({
      existingDbs: [{ id: 'db-local', connection: { embedded: true } }],
      failMigrationWith: 'syntax error near CREATE',
    });
    const res = await provisionDeclaredTables(studio, 't1', [TBL], fakeLog());
    expect(res.tablesCreated[0]).toMatchObject({ name: 'demo_table', ok: false });
    expect(res.tablesCreated[0]!.error).toContain('syntax error');
  });

  it('seed row che fallisce non blocca le altre (best-effort per riga)', async () => {
    const { studio } = fakeDbStudio({ existingDbs: [{ id: 'db-local', connection: { embedded: true } }] });
    let call = 0;
    studio.insert = () => { call += 1; if (call === 1) throw new Error('boom'); };
    const res = await provisionDeclaredTables(studio, 't1', [TBL], fakeLog());
    expect(res.seededRows).toBe(1); // la seconda riga entra comunque
  });

  it('lista vuota → no-op senza toccare DbStudio', async () => {
    const { studio, migrations, created } = fakeDbStudio();
    const res = await provisionDeclaredTables(studio, 't1', [], fakeLog());
    expect(res.tablesCreated).toHaveLength(0);
    expect(migrations).toHaveLength(0);
    expect(created).toHaveLength(0);
  });
});
