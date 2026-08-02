/**
 * Test bug-bounty — action_mock_data. Era SENZA test (gap gate).
 * Copre: determinismo con seed (claim "RIPRODUCIBILE"), clamp 1-1000, schema default,
 * formati IT (phone +39), e l'UUID v4 CONFORME (version 4 + variant 8/9/a/b) — la
 * description dice "uuid (v4)", quindi lo verifico (no aspirazionale).
 */
import { describe, it, expect } from 'vitest';
import { mockDataNode } from './mock.js';

const mock = mockDataNode.executor!;
const ctx = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} } as never;
const run = async (cfg: Record<string, unknown>) =>
  (await mock(cfg, undefined, ctx)).output as {
    items: Record<string, unknown>[];
    count: number;
    seed: string | null;
  };

describe('action_mock_data', () => {
  it('🚨 stesso seed → output IDENTICO (riproducibilità)', async () => {
    const a = await run({ seed: 'test-x', count: 5, schema: { nome: 'fullName', n: 'integer' } });
    const b = await run({ seed: 'test-x', count: 5, schema: { nome: 'fullName', n: 'integer' } });
    expect(a.items).toEqual(b.items);
  });

  it('seed diversi → output diverso (quasi sempre)', async () => {
    const a = await run({ seed: 'aaa', count: 5, schema: { n: 'integer' } });
    const b = await run({ seed: 'bbb', count: 5, schema: { n: 'integer' } });
    expect(a.items).not.toEqual(b.items);
  });

  it('count clampato 1..1000', async () => {
    expect((await run({ count: 0 })).count).toBe(1);
    expect((await run({ count: 99999 })).count).toBe(1000);
  });

  it('schema vuoto → default { id, nome, email, citta }', async () => {
    const r = await run({ count: 1 });
    expect(Object.keys(r.items[0]!).sort()).toEqual(['citta', 'email', 'id', 'nome']);
  });

  it('phone formato +39 italiano', async () => {
    const r = await run({ seed: 's', count: 1, schema: { tel: 'phone' } });
    expect(String(r.items[0]!.tel)).toMatch(/^\+39 3\d/);
  });

  it('🚨 uuid è un v4 CONFORME (version 4 + variant 8/9/a/b)', async () => {
    const r = await run({ seed: 's', count: 20, schema: { id: 'uuid' } });
    const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const it of r.items) expect(String(it.id)).toMatch(v4);
  });

  it("seed nullo riportato come null nell'output", async () => {
    expect((await run({ count: 1 })).seed).toBeNull();
  });
});
