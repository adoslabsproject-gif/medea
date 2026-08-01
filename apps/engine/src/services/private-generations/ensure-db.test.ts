import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger.js';
import { ensureGenerationsDb, __resetEnsureDbCache } from './ensure-db.js';
import { CREATE_GENERATIONS_TABLE_SQL, GENERATIONS_DB_NAME } from './schema.js';
import type { DbStudioPort, CreateEmbeddedDb } from './types.js';

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

function makeDeps(over: { existing?: { id: string; name: string }[] } = {}) {
  const executeRaw = vi.fn().mockResolvedValue({ ok: true });
  const list = vi.fn().mockReturnValue(over.existing ?? []);
  const dbStudio = { list, executeRaw } as unknown as DbStudioPort;
  const createEmbeddedDb: CreateEmbeddedDb = vi.fn(async (name) => ({ id: 'new-db-id', name }));
  return { dbStudio, createEmbeddedDb, tenantId: 't1', list, executeRaw, createEmbeddedDb_: createEmbeddedDb as ReturnType<typeof vi.fn> };
}

describe('ensureGenerationsDb', () => {
  beforeEach(() => __resetEnsureDbCache());

  it('crea il DB quando assente e applica il DDL', async () => {
    const d = makeDeps({ existing: [] });
    const id = await ensureGenerationsDb(d);
    expect(d.createEmbeddedDb_).toHaveBeenCalledWith(GENERATIONS_DB_NAME);
    expect(id).toBe('new-db-id');
    expect(d.executeRaw).toHaveBeenCalledWith('new-db-id', CREATE_GENERATIONS_TABLE_SQL, { dryRun: false, rowLimit: 0 }, 't1');
  });

  it('riusa il DB esistente (NON ne crea un altro) e riapplica il DDL idempotente', async () => {
    const d = makeDeps({ existing: [{ id: 'exist-1', name: GENERATIONS_DB_NAME }] });
    const id = await ensureGenerationsDb(d);
    expect(id).toBe('exist-1');
    expect(d.createEmbeddedDb_).not.toHaveBeenCalled();
    expect(d.executeRaw).toHaveBeenCalledWith('exist-1', CREATE_GENERATIONS_TABLE_SQL, { dryRun: false, rowLimit: 0 }, 't1');
  });

  it('ignora database con nome diverso', async () => {
    const d = makeDeps({ existing: [{ id: 'other', name: 'qualcos-altro' }] });
    const id = await ensureGenerationsDb(d);
    expect(id).toBe('new-db-id'); // ne crea uno nuovo, non riusa "other"
  });

  it('memoizza per tenant: la 2ª chiamata non rifa list/create/DDL', async () => {
    const d = makeDeps({ existing: [] });
    await ensureGenerationsDb(d);
    await ensureGenerationsDb(d);
    expect(d.list).toHaveBeenCalledTimes(1);
    expect(d.createEmbeddedDb_).toHaveBeenCalledTimes(1);
    // 1 CREATE TABLE + 1 migrazione ALTER (additiva) = 2; la 2ª ensure è memoizzata (0).
    expect(d.executeRaw).toHaveBeenCalledTimes(2);
  });

  it('tenant diversi → cache separata', async () => {
    const a = makeDeps({ existing: [{ id: 'a-db', name: GENERATIONS_DB_NAME }] });
    const b = makeDeps({ existing: [{ id: 'b-db', name: GENERATIONS_DB_NAME }] });
    expect(await ensureGenerationsDb({ ...a, tenantId: 'A' })).toBe('a-db');
    expect(await ensureGenerationsDb({ ...b, tenantId: 'B' })).toBe('b-db');
  });

  it('migrazione "colonna già presente" → ignorata in silenzio (esito atteso, no warn)', async () => {
    loggerMock.warn.mockClear();
    const d = makeDeps({ existing: [{ id: 'db1', name: GENERATIONS_DB_NAME }] });
    d.executeRaw.mockReset().mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('duplicate column name: conversation_id'));
    await expect(ensureGenerationsDb({ ...d, tenantId: 'T1' })).resolves.toBe('db1');
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('migrazione con errore REALE → loggata (non silenziata) ma non blocca', async () => {
    loggerMock.warn.mockClear();
    const d = makeDeps({ existing: [{ id: 'db2', name: GENERATIONS_DB_NAME }] });
    d.executeRaw.mockReset().mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('disk I/O error'));
    await expect(ensureGenerationsDb({ ...d, tenantId: 'T2' })).resolves.toBe('db2');
    expect(loggerMock.warn).toHaveBeenCalled();
  });
});
