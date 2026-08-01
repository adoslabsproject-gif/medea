/**
 * Test del LOOP DI REPAIR del node-generator (l'elevazione "opera d'arte"):
 * genera → valida (AST + coerenza) → se rotto, ricorregge mirato → rivalida.
 * LLM mockato con SEQUENZA di risposte (niente modello reale → niente greensmoke).
 *
 * Copre: repair di un problema di QUALITÀ (no_return) e di SICUREZZA (process.env);
 * esaurimento tentativi → throw "validation"/"forbidden" (mai emettere codice rotto);
 * propagazione dei warning di coerenza; e validateQuality in isolamento.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@flowforge/core-schema', async () => {
  const { z } = await import('zod');
  // Schema permissivo MA che PRESERVA configFields (passthrough) → la coerenza
  // def↔executor è testabile davvero.
  return {
    NodeDefSchema: z.object({ id: z.string(), type: z.string(), label: z.string() }).passthrough(),
  };
});

import { NodeGeneratorService, type GeneratedNode } from './node-generator.service.js';

interface FakeLlm { complete: ReturnType<typeof vi.fn> }
/** LLM che ritorna le risposte in sequenza (l'ultima si ripete). */
function seqLlm(responses: string[]): FakeLlm {
  let i = 0;
  return { complete: vi.fn(() => Promise.resolve({ text: responses[Math.min(i++, responses.length - 1)] })) };
}
const fence = (o: unknown): string => '```json\n' + JSON.stringify(o) + '\n```';
const def = { id: 'n', type: 'action', label: 'N' };
const GOOD_EXEC = 'async function execute(config, input, context) { return { output: 1, durationMs: 0 }; }';

describe('generate — loop di repair', () => {
  it('🚨 1° output con no_return → repair → 2° valido → ritorna il nodo riparato', async () => {
    const llm = seqLlm([
      fence({ def, executorSource: 'async function execute(config, input, context) { const x = 1; }', rationale: 'r' }),
      fence({ def, executorSource: GOOD_EXEC, rationale: 'r2' }),
    ]);
    const svc = new NodeGeneratorService(llm as never);
    const node = await svc.generate({ description: 'a long enough description' });
    expect(node.rationale).toBe('r2');
    expect(llm.complete).toHaveBeenCalledTimes(2); // 1 gen + 1 repair
    // il prompt di repair menziona il problema specifico
    const repairMsg = (llm.complete.mock.calls[1]![0] as { messages: { content: string }[] }).messages[1]!.content;
    expect(repairMsg).toMatch(/return/u);
  });

  it('🚨 SICUREZZA riparabile: 1° process.env → repair → 2° pulito → ritorna', async () => {
    const llm = seqLlm([
      fence({ def, executorSource: 'async function execute(c,i,x){ return process.env.X; }', rationale: 'r' }),
      fence({ def, executorSource: GOOD_EXEC, rationale: 'ok' }),
    ]);
    const svc = new NodeGeneratorService(llm as never);
    const node = await svc.generate({ description: 'a long enough description' });
    expect(node.rationale).toBe('ok');
  });

  it('🚨 qualità MAI risolta → throw "validation" (mai emette nodo rotto)', async () => {
    const llm = seqLlm([fence({ def, executorSource: 'async function execute(config, input, context) { const x = 1; }', rationale: 'r' })]);
    const svc = new NodeGeneratorService(llm as never);
    await expect(svc.generate({ description: 'a long enough description' })).rejects.toThrow(/validation/u);
    // 1 gen + MAX_REPAIR_ATTEMPTS (2) = 3 chiamate
    expect(llm.complete).toHaveBeenCalledTimes(3);
  });

  it('🚨 SICUREZZA mai risolta → throw "forbidden" (→ route 422), mai emessa', async () => {
    const llm = seqLlm([fence({ def, executorSource: 'async function execute(c,i,x){ return process.env.X; }', rationale: 'r' })]);
    const svc = new NodeGeneratorService(llm as never);
    await expect(svc.generate({ description: 'a long enough description' })).rejects.toThrow(/forbidden/u);
  });

  it('🚨 nodo già valido → nessun repair (1 sola chiamata)', async () => {
    const llm = seqLlm([fence({ def, executorSource: GOOD_EXEC, rationale: 'r' })]);
    const svc = new NodeGeneratorService(llm as never);
    await svc.generate({ description: 'a long enough description' });
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it('🚨 warning di coerenza (select senza options) propagato nei warnings, NON blocca', async () => {
    const defSelect = { ...def, configFields: [{ key: 'mode', type: 'select' }] };
    const llm = seqLlm([fence({ def: defSelect, executorSource: GOOD_EXEC, rationale: 'r' })]);
    const svc = new NodeGeneratorService(llm as never);
    const node = await svc.generate({ description: 'a long enough description' });
    expect(node.warnings?.some((w) => w.includes('select'))).toBe(true);
    expect(llm.complete).toHaveBeenCalledTimes(1); // warning non innesca repair
  });

  it('🚨 coerenza ERROR (config key non dichiarata) → innesca repair', async () => {
    const llm = seqLlm([
      fence({ def, executorSource: 'async function execute(config, input, context) { return { v: config.missing }; }', rationale: 'r' }),
      fence({ def, executorSource: GOOD_EXEC, rationale: 'fixed' }),
    ]);
    const svc = new NodeGeneratorService(llm as never);
    const node = await svc.generate({ description: 'a long enough description' });
    expect(node.rationale).toBe('fixed');
    expect(llm.complete).toHaveBeenCalledTimes(2);
  });
});

describe('validateQuality (metodo pubblico)', () => {
  it('separa executor vs coherence; sicurezza esclusa (gestita dal parse)', () => {
    const svc = new NodeGeneratorService({ complete: vi.fn() } as never);
    const node: GeneratedNode = {
      def: { id: 'n', type: 'action', label: 'N', configFields: [{ key: 'url', type: 'text' }] } as never,
      executorSource: 'async function execute(config, input, context) { return { v: config.other }; }',
      rationale: 'r',
    };
    const q = svc.validateQuality(node);
    expect(q.coherence.some((v) => v.kind === 'unknown_config_key')).toBe(true);
    // process/eval NON compaiono qui (severity security filtrata)
    expect(q.executor.every((v) => v.severity !== 'security')).toBe(true);
  });
});
