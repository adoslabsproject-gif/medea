/**
 * Test 2026-grade — RunsArchiveService (cold-storage gzip + HMAC + path safe).
 *
 * 🚨 INTEGRITY: HMAC-SHA256 firma archivio; download endpoint verifica.
 * 🚨 ATOMIC: .tmp + rename evita archivi tronchi se kill -9 mid-write.
 * 🚨 PATH-TRAVERSAL: archivePathSafe rifiuta `../` e basename non whitelisted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '@/lib/logger.js';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { first } from '@/__testkit__/assert.js';

let sqliteInstance: Database.Database;
const drizzleDelete = vi.fn(() => ({ where: () => Promise.resolve() }));
const getDatabaseMock = vi.fn(() => ({
  sqlite: sqliteInstance,
  db: { delete: drizzleDelete },
}));
vi.mock('@/storage/db.js', () => ({ getDatabase: getDatabaseMock }));

vi.mock('@/storage/schema.js', () => ({
  runs: {
    workflowId: 'workflow_id',
    startedAt: 'started_at',
  },
}));

let tmpDir: string;
let ssoSecret: string | undefined = 'hmac-test-secret-key-at-least-32-characters-long';
vi.mock('@/config.js', () => ({
  loadConfig: () => ({
    FLOWFORGE_DATA_DIR: tmpDir,
    FLOWFORGE_SSO_SECRET: ssoSecret,
  }),
}));

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = await mkdtemp(join(tmpdir(), 'ff-runs-archive-'));
  sqliteInstance = new Database(':memory:');
  sqliteInstance.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT
    );
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      run_verbosity TEXT
    );
  `);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const { archiveOldRuns, listArchives, archivePathSafe, archiveAllWorkflows } = await import('./runs-archive.service.js');

describe('🚨 archiveOldRuns — guards', () => {
  it('🚨 olderThanDays <= 0 → null (no-op)', async () => {
    expect(await archiveOldRuns('wf-1', 0)).toBeNull();
    expect(await archiveOldRuns('wf-1', -5)).toBeNull();
  });

  it('🚨 zero runs candidate → null (early exit)', async () => {
    expect(await archiveOldRuns('wf-empty', 30)).toBeNull();
  });

  it('🚨 runs recenti (più giovani della cutoff) NON archiviati', async () => {
    const recent = new Date(Date.now() - 1 * 24 * 3600_000).toISOString(); // 1 giorno fa
    sqliteInstance.prepare('INSERT INTO runs (id, workflow_id, started_at, status) VALUES (?,?,?,?)').run('r1', 'wf-x', recent, 'ok');
    expect(await archiveOldRuns('wf-x', 30)).toBeNull();
    // Row ancora presente
    expect(sqliteInstance.prepare('SELECT COUNT(*) as n FROM runs').get()).toEqual({ n: 1 });
  });
});

describe('🚨 archiveOldRuns — happy path', () => {
  beforeEach(() => {
    const old1 = new Date(Date.now() - 60 * 24 * 3600_000).toISOString(); // 60gg fa
    const old2 = new Date(Date.now() - 45 * 24 * 3600_000).toISOString();
    sqliteInstance.prepare('INSERT INTO runs (id, workflow_id, started_at, status, payload) VALUES (?,?,?,?,?)').run('r1', 'wf-A', old1, 'ok', '{"data":"v1"}');
    sqliteInstance.prepare('INSERT INTO runs (id, workflow_id, started_at, status, payload) VALUES (?,?,?,?,?)').run('r2', 'wf-A', old2, 'ok', '{"data":"v2"}');
  });

  it('🚨 archivia + file gz su disco con extension corretta', async () => {
    const res = await archiveOldRuns('wf-A', 30);
    expect(res).not.toBeNull();
    expect(res!.archived).toBe(2);
    expect(res!.filename).toMatch(/^runs-\d{4}-\d{2}-[A-Za-z0-9_-]+\.jsonl\.gz$/u);
    expect(res!.sizeBytes).toBeGreaterThan(0);
    expect(res!.hash).toMatch(/^[a-f0-9]{64}$/u);

    const archiveDir = join(tmpDir, 'archives', 'wf-A');
    const files = await readdir(archiveDir);
    expect(files.filter((f) => f.endsWith('.jsonl.gz'))).toHaveLength(1);
    expect(files.find((f) => f.endsWith('.tmp'))).toBeUndefined(); // atomic rename
  });

  it('🚨 contenuto gz decompresso = JSONL row originali', async () => {
    const res = await archiveOldRuns('wf-A', 30);
    const gz = readFileSync(join(tmpDir, 'archives', 'wf-A', res!.filename));
    const content = gunzipSync(gz).toString('utf8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(2);
    const r1 = JSON.parse(first(lines, 'jsonl-lines'));
    expect(r1.id).toBe('r1');
    expect(r1.payload).toBe('{"data":"v1"}');
  });

  it('🚨 DELETE source rows dopo archivio', async () => {
    await archiveOldRuns('wf-A', 30);
    expect(drizzleDelete).toHaveBeenCalled();
  });

  it('🚨 HMAC determinstico (stesso input → stesso hash)', async () => {
    // L'HMAC è calcolato su SELECT * (started_at incluso). Per testare DAVVERO
    // il determinismo serve input BYTE-identico tra le due archiviazioni: uso
    // timestamp FISSI (non Date.now(), che drifterebbe di ms tra res1 e res2).
    // Devono restare < cutoff (now-30gg) per essere archiviati: gen/feb 2026 ok.
    const TS1 = '2026-01-01T00:00:00.000Z';
    const TS2 = '2026-02-01T00:00:00.000Z';
    const seed = (): void => {
      sqliteInstance.exec(`DELETE FROM runs WHERE workflow_id='wf-A'`);
      sqliteInstance.prepare('INSERT INTO runs (id, workflow_id, started_at, status, payload) VALUES (?,?,?,?,?)').run('r1', 'wf-A', TS1, 'ok', '{"data":"v1"}');
      sqliteInstance.prepare('INSERT INTO runs (id, workflow_id, started_at, status, payload) VALUES (?,?,?,?,?)').run('r2', 'wf-A', TS2, 'ok', '{"data":"v2"}');
    };
    seed();
    const res1 = await archiveOldRuns('wf-A', 30);
    seed();
    const res2 = await archiveOldRuns('wf-A', 30);
    expect(res1!.hash).toBe(res2!.hash);
  });

  it('🚨 log info batch archived', async () => {
    await archiveOldRuns('wf-A', 30);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-A', archived: 2 }),
      '[runs-archive] batch archived',
    );
  });
});

describe('🚨 archiveHmacKey — fail-fast (mai firma con chiave nota)', () => {
  const OLD_ENV = process.env.NODE_ENV;
  const seedOld = (wf: string): void => {
    const old = new Date(Date.now() - 60 * 24 * 3600_000).toISOString();
    sqliteInstance.prepare('INSERT INTO runs (id, workflow_id, started_at, status, payload) VALUES (?,?,?,?,?)').run('s1', wf, old, 'ok', '{"x":1}');
  };
  afterEach(() => {
    process.env.NODE_ENV = OLD_ENV;
    ssoSecret = 'hmac-test-secret-key-at-least-32-characters-long';
  });

  it('🚨 production + FLOWFORGE_SSO_SECRET assente → THROW (no fallback hard-coded)', async () => {
    process.env.NODE_ENV = 'production';
    ssoSecret = undefined;
    seedOld('wf-nosecret');
    await expect(archiveOldRuns('wf-nosecret', 30)).rejects.toThrow(/FLOWFORGE_SSO_SECRET OBBLIGATORIO/);
    // Nessun archivio scritto: il throw avviene PRIMA del write
    expect(listArchives('wf-nosecret')).toEqual([]);
  });

  it('🚨 production + secret < 32 char → THROW (anti weak key)', async () => {
    process.env.NODE_ENV = 'production';
    ssoSecret = 'troppo-corto';
    seedOld('wf-weak');
    await expect(archiveOldRuns('wf-weak', 30)).rejects.toThrow(/OBBLIGATORIO/);
  });

  it('🚨 production + secret valido (>=32) → archivia senza throw', async () => {
    process.env.NODE_ENV = 'production';
    ssoSecret = 'a'.repeat(48);
    seedOld('wf-prod-ok');
    const res = await archiveOldRuns('wf-prod-ok', 30);
    expect(res).not.toBeNull();
    expect(res!.hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('🚨 secret valido cambia → HMAC cambia (la chiave è davvero usata)', async () => {
    const TS = '2026-01-01T00:00:00.000Z';
    const seedFixed = (): void => {
      sqliteInstance.exec(`DELETE FROM runs WHERE workflow_id='wf-key'`);
      sqliteInstance.prepare('INSERT INTO runs (id, workflow_id, started_at, status, payload) VALUES (?,?,?,?,?)').run('k1', 'wf-key', TS, 'ok', '{"x":1}');
    };
    ssoSecret = 'key-alpha-padded-to-thirty-two-chars-aaaa';
    seedFixed();
    const a = await archiveOldRuns('wf-key', 30);
    ssoSecret = 'key-bravo-padded-to-thirty-two-chars-bbbb';
    seedFixed();
    const b = await archiveOldRuns('wf-key', 30);
    expect(a!.hash).not.toBe(b!.hash); // chiave diversa → firma diversa
  });
});

describe('🚨 listArchives', () => {
  it('🚨 nessuna dir → []', () => {
    expect(listArchives('no-such-workflow')).toEqual([]);
  });

  it('🚨 archivi esistenti → list ordinata desc per createdAt', async () => {
    const old = new Date(Date.now() - 60 * 24 * 3600_000).toISOString();
    sqliteInstance.prepare('INSERT INTO runs (id, workflow_id, started_at, status) VALUES (?,?,?,?)').run('x', 'wf-A', old, 'ok');
    await archiveOldRuns('wf-A', 30);
    const list = listArchives('wf-A');
    expect(list).toHaveLength(1);
    const a = first(list, 'archives');
    expect(a.filename).toMatch(/\.jsonl\.gz$/u);
    expect(a.sizeBytes).toBeGreaterThan(0);
    expect(a.hash).toBe(''); // ricalcolato on-demand
  });

  it('🚨 file non .jsonl.gz nella dir → filtrati', async () => {
    const dir = join(tmpDir, 'archives', 'wf-mixed');
    await import('node:fs/promises').then((m) => m.mkdir(dir, { recursive: true }));
    await import('node:fs/promises').then((m) => m.writeFile(join(dir, 'README.md'), '# notes'));
    await import('node:fs/promises').then((m) => m.writeFile(join(dir, 'broken.txt'), 'foo'));
    expect(listArchives('wf-mixed')).toEqual([]);
  });
});

describe('🚨 archivePathSafe — security guards', () => {
  it('🚨 filename con .. → null', () => {
    expect(archivePathSafe('wf-1', '../etc/passwd')).toBeNull();
  });

  it('🚨 filename con / → null', () => {
    expect(archivePathSafe('wf-1', 'subdir/file.jsonl.gz')).toBeNull();
  });

  it('🚨 filename con backslash (Windows path) → null', () => {
    expect(archivePathSafe('wf-1', 'subdir\\file.jsonl.gz')).toBeNull();
  });

  it('🚨 filename non match whitelist regex → null', () => {
    expect(archivePathSafe('wf-1', 'evil.exe')).toBeNull();
    expect(archivePathSafe('wf-1', 'runs-2026-06-XYZ.gz')).toBeNull(); // .gz senza .jsonl
    expect(archivePathSafe('wf-1', 'random.jsonl.gz')).toBeNull(); // no runs- prefix
  });

  it('🚨 filename whitelisted → path completo', () => {
    const p = archivePathSafe('wf-1', 'runs-2026-06-abc123.jsonl.gz');
    expect(p).toContain('wf-1');
    expect(p).toMatch(/runs-2026-06-abc123\.jsonl\.gz$/u);
  });

  it('🚨 nanoid 8-char hyphen-safe → valid', () => {
    const p = archivePathSafe('wf-1', 'runs-2026-06-_aBcD-3X.jsonl.gz');
    expect(p).not.toBeNull();
  });
});

describe('🚨 archiveAllWorkflows', () => {
  it('🚨 scansiona TUTTI i workflows non-silent', async () => {
    sqliteInstance.exec(`INSERT INTO workflows VALUES ('wf-1', NULL)`);
    sqliteInstance.exec(`INSERT INTO workflows VALUES ('wf-2', 'verbose')`);
    sqliteInstance.exec(`INSERT INTO workflows VALUES ('wf-silent', 'silent')`);
    const old = new Date(Date.now() - 60 * 24 * 3600_000).toISOString();
    sqliteInstance.prepare('INSERT INTO runs (id, workflow_id, started_at, status) VALUES (?,?,?,?)').run('r1', 'wf-1', old, 'ok');
    const summary = await archiveAllWorkflows(30);
    expect(summary.workflowsScanned).toBe(2); // wf-silent escluso
    expect(summary.workflowsArchived).toBeGreaterThanOrEqual(1);
    expect(summary.totalRows).toBeGreaterThanOrEqual(1);
  });

  it('🚨 workflow fail in batch → continua + warn log', async () => {
    sqliteInstance.exec(`INSERT INTO workflows VALUES ('wf-good', NULL)`);
    sqliteInstance.exec(`INSERT INTO workflows VALUES ('wf-bad', NULL)`);
    const old = new Date(Date.now() - 60 * 24 * 3600_000).toISOString();
    sqliteInstance.prepare('INSERT INTO runs (id, workflow_id, started_at, status) VALUES (?,?,?,?)').run('r1', 'wf-good', old, 'ok');
    sqliteInstance.prepare('INSERT INTO runs (id, workflow_id, started_at, status) VALUES (?,?,?,?)').run('r2', 'wf-bad', old, 'ok');
    // Simula failure su wf-bad facendo throw mid-process via getDatabase
    let callCount = 0;
    drizzleDelete.mockImplementation(() => {
      callCount++;
      if (callCount === 2) throw new Error('fake DELETE error');
      return { where: () => Promise.resolve() };
    });
    const summary = await archiveAllWorkflows(30);
    expect(summary.workflowsScanned).toBe(2);
    // wf-good archiviato, wf-bad fallisce ma non blocca
    expect(summary.workflowsArchived).toBeGreaterThanOrEqual(1);
    expect(loggerMock.warn).toHaveBeenCalled();
  });
});
