/**
 * Test make-llm-repair + repair-prompt — la riparazione LLM con `dispatch`
 * INIETTATO. Verifica parsing robusto, fail-soft, e la costruzione del prompt.
 */
import { describe, it, expect, vi } from 'vitest';
import { makeLlmRepairFn, type StructuredDispatch } from './make-llm-repair.js';
import { buildRepairPrompt, REPAIR_RESPONSE_SCHEMA } from './repair-prompt.js';
import type { CatalogViolation } from './catalog-validator.js';

const NODES = [{ id: 'n1', defId: 'action_http_request', config: { method: 'GET' } }];
const VIOLATIONS: CatalogViolation[] = [
  { kind: 'missing_required', nodeId: 'n1', defId: 'action_http_request', key: 'url' },
];

describe('buildRepairPrompt', () => {
  it('include SOLO i nodi con violazioni + i messaggi del validatore', () => {
    const p = buildRepairPrompt({ nodes: [...NODES, { id: 'n2', defId: 'x', config: {} }], violations: VIOLATIONS, goal: 'chiama una API' });
    expect(p.user).toContain('n1');
    expect(p.user).not.toContain('"n2"'); // n2 non ha violazioni
    expect(p.user).toContain('url'); // messaggio del validatore
    expect(p.user).toContain('chiama una API'); // goal
    expect(p.schema).toBe(REPAIR_RESPONSE_SCHEMA);
  });

  it('senza goal → nessuna riga goal', () => {
    const p = buildRepairPrompt({ nodes: NODES, violations: VIOLATIONS });
    expect(p.user).not.toMatch(/Goal del workflow/u);
  });
});

describe('makeLlmRepairFn — parsing & fail-soft', () => {
  function repairWith(dispatch: StructuredDispatch) {
    return makeLlmRepairFn({ dispatch, goal: 'g' });
  }

  it('🚨 risposta valida {fixes} → RepairedNode[]', async () => {
    const fn = repairWith(async () => JSON.stringify({ fixes: [{ id: 'n1', config: { url: 'https://x' } }] }));
    const out = await fn({ nodes: NODES, violations: VIOLATIONS });
    expect(out).toEqual([{ id: 'n1', config: { url: 'https://x' } }]);
  });

  it('risposta in fence ```json → parsata', async () => {
    const fn = repairWith(async () => '```json\n{"fixes":[{"id":"n1","config":{"url":"https://y"}}]}\n```');
    const out = await fn({ nodes: NODES, violations: VIOLATIONS });
    expect(out).toEqual([{ id: 'n1', config: { url: 'https://y' } }]);
  });

  it('🚨 JSON illeggibile → [] (fail-soft, no throw)', async () => {
    const fn = repairWith(async () => 'mi dispiace non posso');
    await expect(fn({ nodes: NODES, violations: VIOLATIONS })).resolves.toEqual([]);
  });

  it('🚨 dispatch lancia (LLM giù) → [] (fail-soft)', async () => {
    const fn = repairWith(vi.fn(async () => { throw new Error('Liara 502'); }));
    await expect(fn({ nodes: NODES, violations: VIOLATIONS })).resolves.toEqual([]);
  });

  it('🚨 scarta entry malformate (id mancante / config non-oggetto / array)', async () => {
    const fn = repairWith(async () => JSON.stringify({ fixes: [
      { id: 'n1', config: { url: 'ok' } },
      { config: { x: 1 } },            // no id
      { id: 'n2', config: 'stringa' },  // config non-oggetto
      { id: 'n3', config: [1, 2] },     // array
    ] }));
    const out = await fn({ nodes: NODES, violations: VIOLATIONS });
    expect(out).toEqual([{ id: 'n1', config: { url: 'ok' } }]);
  });

  it('fixes assente / non-array → []', async () => {
    expect(await repairWith(async () => '{}')({ nodes: NODES, violations: VIOLATIONS })).toEqual([]);
    expect(await repairWith(async () => '{"fixes":"x"}')({ nodes: NODES, violations: VIOLATIONS })).toEqual([]);
  });

  it('il dispatch riceve system+user+schema dal prompt builder', async () => {
    const dispatch = vi.fn<StructuredDispatch>(async () => '{"fixes":[]}');
    await makeLlmRepairFn({ dispatch, goal: 'salva in DB' })({ nodes: NODES, violations: VIOLATIONS });
    expect(dispatch).toHaveBeenCalledOnce();
    const arg = dispatch.mock.calls[0]![0];
    expect(arg.schema).toBe(REPAIR_RESPONSE_SCHEMA);
    expect(arg.user).toContain('salva in DB');
    expect(arg.system).toContain('riparatore');
  });
});
