import { describe, it, expect, vi } from 'vitest';
import { saveGeneration, rateGeneration, listGenerations, listConversations, getConversation, getGeneration, deleteConversation, type RepoDeps } from './repository.js';
import { GENERATIONS_TABLE } from './schema.js';
import type { BlobStorePort, DbStudioPort } from './types.js';

function makeDeps(over: { queryResult?: unknown; rawResult?: unknown } = {}) {
  const insert = vi.fn().mockResolvedValue({ ok: true });
  const updateRow = vi.fn().mockResolvedValue({ ok: true });
  const query = vi.fn().mockResolvedValue(over.queryResult ?? { rows: [] });
  const executeRaw = vi.fn().mockResolvedValue(over.rawResult ?? { rows: [] });
  const writeBuffer = vi.fn(async (b: Buffer) => ({ ref: 'a'.repeat(64), size: b.length }));
  const dbStudio = { insert, updateRow, query, list: vi.fn(), executeRaw } as unknown as DbStudioPort;
  const blobStore = { writeBuffer, read: vi.fn() } as unknown as BlobStorePort;
  const deps: RepoDeps = { dbStudio, blobStore, tenantId: 't1', dbId: 'db1' };
  return { deps, insert, updateRow, query, executeRaw, writeBuffer };
}

describe('saveGeneration', () => {
  const input = { kind: 'image' as const, prompt: 'a cat', mime: 'image/png', bytes: Buffer.from('PNG-DATA') };

  it('scrive il blob e inserisce la riga con media_ref + metadati', async () => {
    const { deps, insert, writeBuffer } = makeDeps();
    const res = await saveGeneration(deps, { ...input, negative: 'blur', seed: 42, width: 1024, height: 768, checkpoint: 'm.ckpt', params: { steps: 28 } });
    expect(writeBuffer).toHaveBeenCalledWith(input.bytes);
    expect(res).toMatchObject({ mediaRef: 'a'.repeat(64), size: 8 });
    const [dbId, table, row, tenantId] = insert.mock.calls[0]!;
    expect(dbId).toBe('db1');
    expect(table).toBe(GENERATIONS_TABLE);
    expect(tenantId).toBe('t1');
    expect(row).toMatchObject({
      kind: 'image', prompt: 'a cat', negative: 'blur', seed: 42, width: 1024, height: 768,
      checkpoint: 'm.ckpt', mime: 'image/png', media_ref: 'a'.repeat(64), size_bytes: 8, rating: null,
      params: JSON.stringify({ steps: 28 }),
    });
    expect(typeof row.id).toBe('string');
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('campi opzionali assenti → null (non undefined)', async () => {
    const { deps, insert } = makeDeps();
    await saveGeneration(deps, input);
    const row = insert.mock.calls[0]![2] as Record<string, unknown>;
    expect(row.negative).toBeNull();
    expect(row.params).toBeNull();
    expect(row.seed).toBeNull();
  });

  it('NON inserisce se i byte sono vuoti (e non scrive blob)', async () => {
    const { deps, insert, writeBuffer } = makeDeps();
    await expect(saveGeneration(deps, { ...input, bytes: Buffer.alloc(0) })).rejects.toThrow(/vuoto/);
    expect(writeBuffer).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('🔓 AMMETTE prompt vuoto (anima/i2v/img2img: il media è il dato che conta) — bug 2026-06-18', () => {
    // Anti-regressione: l'obbligo di prompt faceva fallire il salvataggio di un
    // video i2v "anima" (nessun testo) → 21 min di GPU persi. Ora si salva.
    const { deps, insert } = makeDeps();
    return expect(saveGeneration(deps, { ...input, prompt: '   ' }))
      .resolves.toMatchObject({ mediaRef: 'a'.repeat(64) })
      .then(() => { expect(insert).toHaveBeenCalled(); });
  });
});

describe('rateGeneration', () => {
  it('aggiorna via updateRow PARAMETRIZZATO (where id, patch rating)', async () => {
    const { deps, updateRow } = makeDeps();
    await rateGeneration(deps, 'gen-1', 'up');
    expect(updateRow).toHaveBeenCalledWith('db1', GENERATIONS_TABLE, { id: 'gen-1' }, { rating: 'up' }, 't1');
  });

  it('rating null azzera il voto', async () => {
    const { deps, updateRow } = makeDeps();
    await rateGeneration(deps, 'gen-1', null);
    expect(updateRow).toHaveBeenCalledWith('db1', GENERATIONS_TABLE, { id: 'gen-1' }, { rating: null }, 't1');
  });

  it('rifiuta rating non valido (anti-injection / valore arbitrario)', async () => {
    const { deps, updateRow } = makeDeps();
    await expect(rateGeneration(deps, 'gen-1', 'love' as unknown as 'up')).rejects.toThrow(/non valido/);
    expect(updateRow).not.toHaveBeenCalled();
  });

  it('rifiuta id vuoto', async () => {
    const { deps } = makeDeps();
    await expect(rateGeneration(deps, '  ', 'up')).rejects.toThrow(/id/);
  });
});

describe('listGenerations', () => {
  it('interroga ordinato per created_at desc con limit clampato', async () => {
    const { deps, query } = makeDeps();
    await listGenerations(deps, 9999); // > 500 → clamp 500
    const [dbId, spec, tenantId] = query.mock.calls[0]!;
    expect(dbId).toBe('db1');
    expect(tenantId).toBe('t1');
    expect(spec).toMatchObject({ table: GENERATIONS_TABLE, orderBy: [{ column: 'created_at', direction: 'desc' }], limit: 500 });
  });

  it('limit < 1 → clamp a 1', async () => {
    const { deps, query } = makeDeps();
    await listGenerations(deps, 0);
    expect((query.mock.calls[0]![1] as { limit: number }).limit).toBe(1);
  });

  it('mappa le righe e normalizza rating sconosciuto → null', async () => {
    const { deps } = makeDeps({ queryResult: { rows: [
      { id: '1', created_at: '2026-01-01T00:00:00Z', kind: 'image', prompt: 'p', negative: null, seed: 5, rating: 'weird', mime: 'image/png', media_ref: 'r', size_bytes: 10 },
    ] } });
    const out = await listGenerations(deps);
    expect(out[0]).toMatchObject({ id: '1', seed: 5, rating: null, mime: 'image/png' });
  });

  it('estrae le righe anche dalla forma statementResults', async () => {
    const { deps } = makeDeps({ queryResult: { statementResults: [{ rows: [{ id: 'x', rating: 'up' }] }] } });
    const out = await listGenerations(deps);
    expect(out).toHaveLength(1);
    expect(out[0]?.rating).toBe('up');
  });

  it('risultato malformato (non-oggetto) → lista vuota, niente crash', async () => {
    const { deps } = makeDeps({ queryResult: 'boom' });
    await expect(listGenerations(deps)).resolves.toEqual([]);
  });
});

describe('conversazioni', () => {
  it('saveGeneration salva conversation_id', async () => {
    const { deps, insert } = makeDeps();
    await saveGeneration(deps, { kind: 'image', prompt: 'p', mime: 'image/png', bytes: Buffer.from('X'), conversationId: 'c-abc' });
    expect((insert.mock.calls[0]![2] as Record<string, unknown>).conversation_id).toBe('c-abc');
  });

  it('listConversations raggruppa e mappa (id/count/last/title)', async () => {
    const { deps, executeRaw } = makeDeps({ rawResult: { rows: [{ id: 'c1', n: 3, last: '2026-01-02', title: 'un gatto' }] } });
    const out = await listConversations(deps);
    expect(executeRaw.mock.calls[0]![1]).toMatch(/GROUP BY conversation_id/);
    expect(out[0]).toEqual({ id: 'c1', count: 3, lastAt: '2026-01-02', title: 'un gatto' });
  });

  it('getConversation valida l\'id e mappa gli elementi', async () => {
    const { deps, executeRaw } = makeDeps({ rawResult: { rows: [{ id: 'g1', created_at: 't', kind: 'video', prompt: 'p', media_ref: 'r', mime: 'video/mp4', rating: 'up' }] } });
    const out = await getConversation(deps, 'c-1');
    expect(executeRaw.mock.calls[0]![1]).toContain("conversation_id = 'c-1'");
    expect(out[0]).toMatchObject({ id: 'g1', kind: 'video', rating: 'up' });
  });

  it('getConversation RIFIUTA id con injection (no SQL arbitrario)', async () => {
    const { deps, executeRaw } = makeDeps();
    await expect(getConversation(deps, "x'; DROP TABLE generations;--")).rejects.toThrow(/non valido/);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('deleteConversation valida + esegue DELETE per conversation_id', async () => {
    const { deps, executeRaw } = makeDeps();
    await deleteConversation(deps, 'c-9');
    expect(executeRaw.mock.calls[0]![1]).toBe("DELETE FROM generations WHERE conversation_id = 'c-9'");
  });

  it('deleteConversation RIFIUTA id non valido', async () => {
    const { deps, executeRaw } = makeDeps();
    await expect(deleteConversation(deps, 'bad id with spaces')).rejects.toThrow(/non valido/);
    expect(executeRaw).not.toHaveBeenCalled();
  });
});

describe('getGeneration (sorgente estensione video)', () => {
  it('ritorna prompt/mime/kind + params parsati', async () => {
    const { deps } = makeDeps({ rawResult: { rows: [{ prompt: 'p', mime: 'video/mp4', media_ref: 'ref1', kind: 'video', params: JSON.stringify({ width: 480, height: 480, length: 25 }) }] } });
    const g = await getGeneration(deps, 'g-1');
    expect(g).toMatchObject({ prompt: 'p', mime: 'video/mp4', kind: 'video', mediaRef: 'ref1' });
    expect(g?.params).toEqual({ width: 480, height: 480, length: 25 });
  });
  it('params malformati → {} (no crash)', async () => {
    const { deps } = makeDeps({ rawResult: { rows: [{ prompt: 'p', mime: 'video/mp4', media_ref: 'r', kind: 'video', params: '{bad' }] } });
    expect((await getGeneration(deps, 'g-1'))?.params).toEqual({});
  });
  it('nessuna riga → null', async () => {
    const { deps } = makeDeps({ rawResult: { rows: [] } });
    expect(await getGeneration(deps, 'g-1')).toBeNull();
  });
  it('🔒 id con injection → throw (no SQL arbitrario)', async () => {
    const { deps, executeRaw } = makeDeps();
    await expect(getGeneration(deps, "x'; DROP TABLE generations;--")).rejects.toThrow(/non valido/);
    expect(executeRaw).not.toHaveBeenCalled();
  });
});
