/**
 * memory_note executor tests.
 *
 * Coperture: set/get/append/delete/list, isolamento workflow, TTL,
 * serialization JSON, error path.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { memoryNoteExecutor, __test__ } from './memory.js';

const sqliteMem = new Database(':memory:');
// Mock getDatabase con un compat shim minimo (le 4 op che memory_note usa)
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({
    sqlite: {
      exec: (sql: string) => sqliteMem.exec(sql),
      prepare: (sql: string) => {
        const stmt = sqliteMem.prepare(sql);
        return {
          run: (...args: unknown[]) => stmt.run(...args),
          get: (...args: unknown[]) => stmt.get(...args),
          all: (...args: unknown[]) => stmt.all(...args),
        };
      },
    },
  }),
}));

const ctx = (workflowId = 'wf-test') => ({
  workflowId, runId: 'r', nodeId: 'n', tenantId: 't', userId: 'u',
  defId: 'memory_note', secrets: {}, llmProviders: [], nodeOutputs: {},
}) as unknown as Parameters<typeof memoryNoteExecutor>[2];

beforeEach(() => {
  __test__.resetSchema();
  sqliteMem.exec('DROP TABLE IF EXISTS workflow_memory');
});

describe('memory_note — operation: set + get', () => {
  it('set + get string → value retrieved', async () => {
    await memoryNoteExecutor({ operation: 'set', key: 'k1', value: 'hello' }, null, ctx());
    const r = await memoryNoteExecutor({ operation: 'get', key: 'k1' }, null, ctx());
    const out = r.output as { exists: boolean; value: string };
    expect(out.exists).toBe(true);
    expect(out.value).toBe('hello');
  });

  it('🚨 SECURITY: set valore oltre 1MB → throw (anti-DoS storage)', async () => {
    // MUTATION: senza assertValueWithinCap, una stringa enorme verrebbe scritta → no throw.
    const huge = 'x'.repeat(1_000_001);
    await expect(memoryNoteExecutor({ operation: 'set', key: 'big', value: huge }, null, ctx()))
      .rejects.toThrow(/cap di 1000000|1 MB/);
  });

  it('🚨 SECURITY: append che supera 1MB → throw (no crescita illimitata)', async () => {
    const half = 'y'.repeat(600_000);
    await memoryNoteExecutor({ operation: 'set', key: 'log', value: half }, null, ctx());
    // secondo append porterebbe il combined oltre 1MB → deve essere bloccato.
    await expect(memoryNoteExecutor({ operation: 'append', key: 'log', value: half }, null, ctx()))
      .rejects.toThrow(/cap di 1000000|1 MB/);
  });

  it('set object → serialized JSON in value', async () => {
    await memoryNoteExecutor({ operation: 'set', key: 'k2', value: { foo: 42, bar: 'x' } }, null, ctx());
    const r = await memoryNoteExecutor({ operation: 'get', key: 'k2' }, null, ctx());
    const out = r.output as { value: string };
    expect(JSON.parse(out.value)).toEqual({ foo: 42, bar: 'x' });
  });

  it('get key inesistente → exists=false, value=null', async () => {
    const r = await memoryNoteExecutor({ operation: 'get', key: 'no-such-key' }, null, ctx());
    const out = r.output as { exists: boolean; value: unknown };
    expect(out.exists).toBe(false);
    expect(out.value).toBeNull();
  });

  it('set sovrascrive valore esistente (upsert)', async () => {
    await memoryNoteExecutor({ operation: 'set', key: 'k3', value: 'v1' }, null, ctx());
    await memoryNoteExecutor({ operation: 'set', key: 'k3', value: 'v2' }, null, ctx());
    const r = await memoryNoteExecutor({ operation: 'get', key: 'k3' }, null, ctx());
    expect((r.output as { value: string }).value).toBe('v2');
  });
});

describe('memory_note — operation: append', () => {
  it('append a key esistente con separator default \\n', async () => {
    await memoryNoteExecutor({ operation: 'set', key: 'log', value: 'line1' }, null, ctx());
    await memoryNoteExecutor({ operation: 'append', key: 'log', value: 'line2' }, null, ctx());
    const r = await memoryNoteExecutor({ operation: 'get', key: 'log' }, null, ctx());
    expect((r.output as { value: string }).value).toBe('line1\nline2');
  });

  it('append con separator custom', async () => {
    await memoryNoteExecutor({ operation: 'set', key: 'csv', value: 'a' }, null, ctx());
    await memoryNoteExecutor({ operation: 'append', key: 'csv', value: 'b', appendSeparator: ',' }, null, ctx());
    await memoryNoteExecutor({ operation: 'append', key: 'csv', value: 'c', appendSeparator: ',' }, null, ctx());
    const r = await memoryNoteExecutor({ operation: 'get', key: 'csv' }, null, ctx());
    expect((r.output as { value: string }).value).toBe('a,b,c');
  });

  it('append a key inesistente → equivalente a set', async () => {
    await memoryNoteExecutor({ operation: 'append', key: 'new', value: 'first' }, null, ctx());
    const r = await memoryNoteExecutor({ operation: 'get', key: 'new' }, null, ctx());
    expect((r.output as { value: string }).value).toBe('first');
  });
});

describe('memory_note — operation: delete + list', () => {
  it('delete rimuove la key', async () => {
    await memoryNoteExecutor({ operation: 'set', key: 'k1', value: 'v1' }, null, ctx());
    await memoryNoteExecutor({ operation: 'delete', key: 'k1' }, null, ctx());
    const r = await memoryNoteExecutor({ operation: 'get', key: 'k1' }, null, ctx());
    expect((r.output as { exists: boolean }).exists).toBe(false);
  });

  it('delete key inesistente → exists=false (no throw)', async () => {
    const r = await memoryNoteExecutor({ operation: 'delete', key: 'never' }, null, ctx());
    expect((r.output as { exists: boolean }).exists).toBe(false);
  });

  it('list restituisce array keys ordinato per updated_at desc', async () => {
    await memoryNoteExecutor({ operation: 'set', key: 'first', value: '1' }, null, ctx());
    await new Promise((res) => setTimeout(res, 10));
    await memoryNoteExecutor({ operation: 'set', key: 'second', value: '2' }, null, ctx());
    const r = await memoryNoteExecutor({ operation: 'list', key: '' }, null, ctx());
    const out = r.output as { keys: string[]; count: number };
    expect(out.count).toBe(2);
    expect(out.keys[0]).toBe('second');
    expect(out.keys[1]).toBe('first');
  });
});

describe('memory_note — isolamento per workflow', () => {
  it('workflow A non vede key di workflow B', async () => {
    await memoryNoteExecutor({ operation: 'set', key: 'shared', value: 'A' }, null, ctx('wf-A'));
    await memoryNoteExecutor({ operation: 'set', key: 'shared', value: 'B' }, null, ctx('wf-B'));
    const ra = await memoryNoteExecutor({ operation: 'get', key: 'shared' }, null, ctx('wf-A'));
    const rb = await memoryNoteExecutor({ operation: 'get', key: 'shared' }, null, ctx('wf-B'));
    expect((ra.output as { value: string }).value).toBe('A');
    expect((rb.output as { value: string }).value).toBe('B');
  });

  it('list mostra solo le key del workflow corrente', async () => {
    await memoryNoteExecutor({ operation: 'set', key: 'a1', value: 'x' }, null, ctx('wf-A'));
    await memoryNoteExecutor({ operation: 'set', key: 'b1', value: 'y' }, null, ctx('wf-B'));
    const r = await memoryNoteExecutor({ operation: 'list', key: '' }, null, ctx('wf-A'));
    expect((r.output as { keys: string[] }).keys).toEqual(['a1']);
  });
});

describe('memory_note — TTL', () => {
  it('TTL 1s → dopo 1.1s la key scade (get → exists=false)', async () => {
    await memoryNoteExecutor({ operation: 'set', key: 'temp', value: 'soon-gone', ttlSeconds: 1 }, null, ctx());
    await new Promise((res) => setTimeout(res, 1100));
    const r = await memoryNoteExecutor({ operation: 'get', key: 'temp' }, null, ctx());
    expect((r.output as { exists: boolean }).exists).toBe(false);
  });

  it('TTL 60s → key vive (exists=true)', async () => {
    await memoryNoteExecutor({ operation: 'set', key: 'long', value: 'still-here', ttlSeconds: 60 }, null, ctx());
    const r = await memoryNoteExecutor({ operation: 'get', key: 'long' }, null, ctx());
    expect((r.output as { exists: boolean }).exists).toBe(true);
  });
});

describe('memory_note — validation errors', () => {
  it('operation invalida → throw', async () => {
    await expect(memoryNoteExecutor({ operation: 'rmrf', key: 'x' }, null, ctx()))
      .rejects.toThrow(/non valida/);
  });

  it('get senza key → throw', async () => {
    await expect(memoryNoteExecutor({ operation: 'get', key: '' }, null, ctx()))
      .rejects.toThrow(/"key" e\\` obbligatoria/);
  });

  it('set senza value → throw', async () => {
    await expect(memoryNoteExecutor({ operation: 'set', key: 'x' }, null, ctx()))
      .rejects.toThrow(/"value" obbligatorio/);
  });
});

describe('memory_note — NodeDef contract', () => {
  it('memoryNoteNode esportato in stdlib', async () => {
    const mod = await import('@flowforge/nodes-stdlib');
    expect(mod.memoryNoteNode.def.id).toBe('memory_note');
  });

  it('description ≥150 char', async () => {
    const mod = await import('@flowforge/nodes-stdlib');
    expect((mod.memoryNoteNode.def.description ?? '').length).toBeGreaterThanOrEqual(150);
  });

  it('operations contiene get/set/append/delete/list', async () => {
    const mod = await import('@flowforge/nodes-stdlib');
    const opField = (mod.memoryNoteNode.def.configFields ?? []).find((f) => f.key === 'operation');
    expect(opField?.options).toEqual(['get', 'set', 'append', 'delete', 'list']);
  });
});

// ── Feature ELEVATE (review 2026-06-20): get→default, list→pattern, output audit.
// Implementate (non più solo dichiarate) → testate end-to-end sull'executor.
describe('memory_note — get con valore di default', () => {
  it('🚨 key assente + default → ritorna il default, exists=false, usedDefault=true', async () => {
    const r = await memoryNoteExecutor({ operation: 'get', key: 'mancante', default: 'fallback' }, null, ctx());
    expect(r.output).toMatchObject({ exists: false, value: 'fallback', usedDefault: true });
  });
  it('key presente → usedDefault=false, ignora il default + espone expiresAt', async () => {
    await memoryNoteExecutor({ operation: 'set', key: 'k', value: 'reale', ttlSeconds: 3600 }, null, ctx());
    const r = await memoryNoteExecutor({ operation: 'get', key: 'k', default: 'fallback' }, null, ctx());
    expect(r.output).toMatchObject({ exists: true, value: 'reale', usedDefault: false });
    expect((r.output as { expiresAt: number }).expiresAt).toBeGreaterThan(Date.now());
  });
  it('key assente senza default → value=null, usedDefault=false', async () => {
    const r = await memoryNoteExecutor({ operation: 'get', key: 'x' }, null, ctx());
    expect(r.output).toMatchObject({ exists: false, value: null, usedDefault: false });
  });
});

describe('memory_note — set audit (oldValue/changed)', () => {
  it('🚨 primo set → oldValue null, changed true', async () => {
    const r = await memoryNoteExecutor({ operation: 'set', key: 'a', value: 'v1' }, null, ctx());
    expect(r.output).toMatchObject({ oldValue: null, changed: true, value: 'v1' });
  });
  it('🚨 overwrite con valore diverso → oldValue precedente, changed true', async () => {
    await memoryNoteExecutor({ operation: 'set', key: 'a', value: 'v1' }, null, ctx());
    const r = await memoryNoteExecutor({ operation: 'set', key: 'a', value: 'v2' }, null, ctx());
    expect(r.output).toMatchObject({ oldValue: 'v1', changed: true, value: 'v2' });
  });
  it('🚨 set con lo stesso valore → changed false', async () => {
    await memoryNoteExecutor({ operation: 'set', key: 'a', value: 'v1' }, null, ctx());
    const r = await memoryNoteExecutor({ operation: 'set', key: 'a', value: 'v1' }, null, ctx());
    expect(r.output).toMatchObject({ oldValue: 'v1', changed: false });
  });
});

describe('memory_note — list con pattern glob', () => {
  beforeEach(async () => {
    for (const k of ['cursor:a', 'cursor:b', 'flag:x', 'other']) {
      await memoryNoteExecutor({ operation: 'set', key: k, value: '1' }, null, ctx('wf-pat'));
    }
  });
  it('🚨 pattern "cursor:*" → solo le key che iniziano con cursor:', async () => {
    const r = await memoryNoteExecutor({ operation: 'list', pattern: 'cursor:*' }, null, ctx('wf-pat'));
    expect((r.output as { keys: string[] }).keys.sort()).toEqual(['cursor:a', 'cursor:b']);
    expect(r.output).toMatchObject({ count: 2, pattern: 'cursor:*' });
  });
  it('? = singolo carattere', async () => {
    await memoryNoteExecutor({ operation: 'set', key: 'aX', value: '1' }, null, ctx('wf-pat'));
    const r = await memoryNoteExecutor({ operation: 'list', pattern: 'a?' }, null, ctx('wf-pat'));
    expect((r.output as { keys: string[] }).keys).toEqual(['aX']);
  });
  it('🚨 metacaratteri SQL nel pattern non fanno match-spurio (% letterale)', async () => {
    await memoryNoteExecutor({ operation: 'set', key: 'a%b', value: '1' }, null, ctx('wf-pat'));
    const r = await memoryNoteExecutor({ operation: 'list', pattern: 'a%b' }, null, ctx('wf-pat'));
    // "%" del pattern utente è LETTERALE (escaped) → matcha solo "a%b", non "aXb"
    expect((r.output as { keys: string[] }).keys).toEqual(['a%b']);
  });
  it('senza pattern → tutte le key + pattern null', async () => {
    const r = await memoryNoteExecutor({ operation: 'list' }, null, ctx('wf-pat'));
    expect((r.output as { count: number }).count).toBeGreaterThanOrEqual(4);
    expect(r.output).toMatchObject({ pattern: null });
  });
});
