/**
 * Test semantic-repair — loop validatore→riparazione, con RepairFn INIETTATA
 * (niente modello reale → niente greensmoke). Verifica convergenza, terminazione
 * (bounded), non-innesco su violazioni non riparabili, e immutabilità.
 */
import { describe, it, expect, vi } from 'vitest';
import { runSemanticRepair, type RepairFn } from './semantic-repair.js';
import type { CatalogViolation } from './catalog-validator.js';
import type { NodeCatalogEntry } from './node-catalog.js';

const CATALOG: NodeCatalogEntry[] = [
  {
    defId: 'action_http_request',
    type: 'action',
    label: 'HTTP',
    description: '',
    fields: [
      { key: 'url', label: 'URL', type: 'text', required: true }, // required, NO default
      {
        key: 'method',
        label: 'Method',
        type: 'select',
        required: true,
        options: ['GET', 'POST'],
        defaultValue: 'GET',
      },
    ],
  },
];

interface NodeIn {
  id: string;
  defId: string;
  config: Record<string, unknown>;
}
/** nodo http con la config data. */
function http(config: Record<string, unknown>): NodeIn[] {
  return [{ id: 'n', defId: 'action_http_request', config }];
}
/** una violazione ha la `key`? (type-guard sull'unione). */
function hasKey(v: CatalogViolation, key: string): boolean {
  return 'key' in v && v.key === key;
}

describe('deterministico-only (nessuna RepairFn)', () => {
  it('riempie i default; le violazioni senza default restano (url)', async () => {
    const r = await runSemanticRepair(http({}), { catalog: CATALOG });
    expect(r.rounds).toBe(0);
    expect(r.nodes[0]!.config.method).toBe('GET'); // default riempito
    expect(r.remaining).toEqual([
      { kind: 'missing_required', nodeId: 'n', defId: 'action_http_request', key: 'url' },
    ]);
    expect(r.applied.some((f) => f.key === 'method')).toBe(true);
  });

  it('workflow già valido → zero violazioni, zero round', async () => {
    const r = await runSemanticRepair(http({ url: 'https://x', method: 'GET' }), {
      catalog: CATALOG,
    });
    expect(r.remaining).toEqual([]);
    expect(r.rounds).toBe(0);
  });
});

describe('con RepairFn iniettata', () => {
  it('🚨 il repair riempie `url` mancante → convergenza (remaining vuoto, rounds=1)', async () => {
    const repair = vi.fn<RepairFn>(async ({ violations }) => {
      expect(violations.some((v) => hasKey(v, 'url'))).toBe(true);
      return [{ id: 'n', config: { url: 'https://api.example.com' } }];
    });
    const r = await runSemanticRepair(http({}), { catalog: CATALOG, repair });
    expect(r.rounds).toBe(1);
    expect(r.remaining).toEqual([]);
    expect(r.nodes[0]!.config).toMatchObject({ url: 'https://api.example.com', method: 'GET' });
    expect(repair).toHaveBeenCalledOnce();
  });

  it('🚨 bounded: un repair che NON risolve si ferma a maxRounds (no loop infinito)', async () => {
    const repair: RepairFn = vi.fn(async () => [{ id: 'n', config: { method: 'GET' } }]); // non tocca url
    const r = await runSemanticRepair(http({}), { catalog: CATALOG, repair, maxRounds: 3 });
    expect(r.rounds).toBe(3);
    expect(r.remaining.some((v) => hasKey(v, 'url'))).toBe(true);
    expect(repair).toHaveBeenCalledTimes(3);
  });

  it('repair che ritorna [] → stop immediato (rounds=1), violazioni intatte', async () => {
    const repair: RepairFn = vi.fn(async () => []);
    const r = await runSemanticRepair(http({}), { catalog: CATALOG, repair, maxRounds: 5 });
    expect(r.rounds).toBe(1);
    expect(r.remaining.some((v) => hasKey(v, 'url'))).toBe(true);
  });

  it('🚨 NON innesca il repair se le violazioni NON sono riparabili (solo unknown_def)', async () => {
    const repair: RepairFn = vi.fn(async () => []);
    const r = await runSemanticRepair([{ id: 'n', defId: 'def_inesistente', config: {} }], {
      catalog: CATALOG,
      repair,
    });
    expect(repair).not.toHaveBeenCalled();
    expect(r.rounds).toBe(0);
    expect(r.remaining).toEqual([{ kind: 'unknown_def', nodeId: 'n', defId: 'def_inesistente' }]);
  });

  it("🚨 NON muta l'input", async () => {
    const input = http({});
    const snapshot = JSON.stringify(input);
    await runSemanticRepair(input, {
      catalog: CATALOG,
      repair: async () => [{ id: 'n', config: { url: 'x' } }],
    });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('applied accumula le fix deterministiche di TUTTI i round (repair lascia enum mal-cased)', async () => {
    // il repair mette method="post" (case sbagliato) + url → il deterministico normalizza post→POST
    const repair: RepairFn = async () => [
      { id: 'n', config: { url: 'https://x', method: 'post' } },
    ];
    const r = await runSemanticRepair(http({}), { catalog: CATALOG, repair });
    expect(r.remaining).toEqual([]);
    expect(r.nodes[0]!.config.method).toBe('POST'); // normalizzato dopo il repair
    expect(r.applied.some((f) => f.kind === 'normalize_enum')).toBe(true);
  });
});
