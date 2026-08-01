/**
 * Bug-bounty UNIT — executors/jsonata.ts (audit coverage 2026-06-12: 6%).
 * Executor PURO (jsonata reale, zero I/O). Si pinna: compile-error e
 * eval-error → Error con prefisso chiaro, input stringa → JSON.parse
 * best-effort, e SOPRATTUTTO le bindings $node (il bug Esempio 2026-05:
 * bindings vuote → $node.X.json.field = undefined → fallback errato).
 */
import { describe, it, expect } from 'vitest';
import { jsonataExecutor } from './jsonata.js';

const ctx = (nodeOutputs: Record<string, unknown> = {}) => ({
  workflowId: 'wf', runId: 'r', nodeId: 'n', tenantId: 't', userId: 'u',
  defId: 'logic_transform', secrets: {}, llmProviders: [], nodeOutputs,
}) as unknown as Parameters<typeof jsonataExecutor>[2];

const run = (config: Record<string, unknown>, input: unknown, nodeOutputs: Record<string, unknown> = {}) =>
  jsonataExecutor(config as never, input as never, ctx(nodeOutputs));

describe('jsonata — validazione e compile', () => {
  it('expression mancante → throw esplicito', async () => {
    await expect(run({}, {})).rejects.toThrow(/missing required "expression"/);
  });

  it('expression sintatticamente rotta → "JSONata compile error" (non eval)', async () => {
    await expect(run({ expression: '$foo(' }, {})).rejects.toThrow(/compile error/);
  });
});

describe('jsonata — trasformazione', () => {
  it('proietta un campo dall input oggetto', async () => {
    const res = await run({ expression: 'name' }, { name: 'Mario', age: 40 });
    expect(res.output).toBe('Mario');
  });

  it('input STRINGA JSON → parse best-effort prima dell eval', async () => {
    const res = await run({ expression: 'a + b' }, '{"a":2,"b":3}');
    expect(res.output).toBe(5);
  });

  it('input stringa NON-JSON → resta stringa (no throw)', async () => {
    const res = await run({ expression: '$' }, 'non-json{{');
    expect(res.output).toBe('non-json{{');
  });

  it('trasformazione complessa: filtro + map su array (JSONata ritorna una sequence)', async () => {
    const res = await run(
      { expression: 'items[price > 10].name' },
      { items: [{ name: 'a', price: 5 }, { name: 'b', price: 20 }, { name: 'c', price: 30 }] },
    );
    // QUIRK jsonata: il risultato multi-valore è una "sequence" (array con
    // flag interno `sequence:true`) — i valori sono corretti, lo spread la
    // normalizza ad array semplice.
    expect([...(res.output as string[])]).toEqual(['b', 'c']);
  });
});

describe('jsonata — bindings $node (anti-regressione bug Esempio)', () => {
  it('$node.<id>.json.<field> risolve dagli output dei nodi precedenti', async () => {
    const res = await run(
      { expression: '$node.contact_discovery.json.domain' },
      {},
      { contact_discovery: { domain: 'example.it' } },
    );
    expect(res.output).toBe('example.it');
  });

  it('REGRESSIONE: senza nodeOutputs $node.X è undefined (non crasha, ma documenta che richiede le bindings)', async () => {
    const res = await run({ expression: '$node.x.json.y' }, {}, {});
    expect(res.output).toBeUndefined();
  });

  it('il wrapper .json è intenzionale: $node.X (senza .json) NON è il payload diretto', async () => {
    const res = await run({ expression: '$node.x.json' }, {}, { x: { a: 1 } });
    expect(res.output).toEqual({ a: 1 });
  });
});

describe('jsonata — eval error', () => {
  it('errore a runtime nell espressione → "JSONata eval error"', async () => {
    // $number su un oggetto non castabile → eval error
    await expect(run({ expression: '$number($)' }, { not: 'a number' })).rejects.toThrow(/eval error/);
  });
});

describe('🚨🚨 jsonata — timeboxing (anti-DoS CPU)', () => {
  it('ricorsione non-terminante → throw (profondità/timeout), NON hang', async () => {
    // funzione che richiama se stessa all'infinito: il timebox la ferma.
    // Timeout abbassato a 500ms via env → test veloce e deterministico (il default
    // di prod è 5s e coinciderebbe col testTimeout di vitest sotto carico).
    process.env.FLOWFORGE_JSONATA_TIMEOUT_MS = '500';
    try {
      const expr = '( $f := function($x){ $f($x) }; $f(1) )';
      await expect(run({ expression: expr }, {})).rejects.toThrow(/profondità massima|timeout|eval error/u);
    } finally {
      delete process.env.FLOWFORGE_JSONATA_TIMEOUT_MS;
    }
  });

  it('espressione normale resta veloce e corretta (il guard non penalizza l\'happy path)', async () => {
    const t0 = Date.now();
    const res = await run({ expression: '$sum([1,2,3,4,5])' }, {});
    expect(res.output).toBe(15);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
