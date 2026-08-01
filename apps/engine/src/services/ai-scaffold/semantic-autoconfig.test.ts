/**
 * Test semantic-autoconfig — auto-config deterministica (#8 strato A).
 *
 * Anti-greensmoke: ogni trasformazione safe verificata + i NON-interventi
 * (secret, expression, valore già presente/canonico, no-default, defId ignoto)
 * + immutabilità dell'input.
 */
import { describe, it, expect } from 'vitest';
import { buildCatalogSpec } from './catalog-spec.js';
import { applyDeterministicAutoConfig } from './semantic-autoconfig.js';
import type { NodeCatalogEntry } from './node-catalog.js';

const CATALOG: NodeCatalogEntry[] = [
  {
    defId: 'action_http_request', type: 'action', label: 'HTTP', description: '',
    fields: [
      { key: 'url', label: 'URL', type: 'text', required: true }, // NO default → resta al repair
      { key: 'method', label: 'Method', type: 'select', required: true, options: ['GET', 'POST'], defaultValue: 'GET' },
      { key: 'timeout', label: 'Timeout', type: 'number', required: false, defaultValue: '30' },
      { key: 'verifySsl', label: 'Verify', type: 'boolean', required: false, defaultValue: 'true' },
      { key: 'apiKey', label: 'Key', type: 'secret', required: true, defaultValue: 'NOPE' }, // secret → mai riempito
    ],
  },
];
const SPEC = buildCatalogSpec(CATALOG);

function run(nodes: { id: string; defId: string; config?: Record<string, unknown> }[]) {
  return applyDeterministicAutoConfig(nodes, SPEC);
}

describe('fill_default', () => {
  it('riempie un required mancante che HA un default (method → GET)', () => {
    const r = run([{ id: 'n', defId: 'action_http_request', config: { url: 'https://x' } }]);
    expect(r.nodes[0]!.config!.method).toBe('GET');
    expect(r.applied).toContainEqual({ kind: 'fill_default', nodeId: 'n', defId: 'action_http_request', key: 'method', value: 'GET' });
  });

  it('🚨 coerce number: defaultValue "30" → 30 (numero, non stringa)', () => {
    const r = run([{ id: 'n', defId: 'action_http_request', config: { url: 'https://x' } }]);
    expect(r.nodes[0]!.config!.timeout).toBe(30);
  });

  it('🚨 coerce boolean: defaultValue "true" → true (boolean)', () => {
    const r = run([{ id: 'n', defId: 'action_http_request', config: { url: 'https://x' } }]);
    expect(r.nodes[0]!.config!.verifySsl).toBe(true);
  });

  it('🚨 NON riempie i SECRET (pending) anche se hanno un default', () => {
    const r = run([{ id: 'n', defId: 'action_http_request', config: { url: 'https://x' } }]);
    expect('apiKey' in r.nodes[0]!.config!).toBe(false);
    expect(r.applied.some((f) => f.key === 'apiKey')).toBe(false);
  });

  it('🚨 NON riempie un required SENZA default (url resta mancante → al repair)', () => {
    const r = run([{ id: 'n', defId: 'action_http_request', config: {} }]);
    expect('url' in r.nodes[0]!.config!).toBe(false);
    expect(r.applied.some((f) => f.key === 'url')).toBe(false);
  });

  it('🚨 NON sovrascrive un valore GIÀ presente', () => {
    const r = run([{ id: 'n', defId: 'action_http_request', config: { url: 'https://x', timeout: 99 } }]);
    expect(r.nodes[0]!.config!.timeout).toBe(99);
    expect(r.applied.some((f) => f.key === 'timeout')).toBe(false);
  });

  it.each([undefined, null, ''])('valore vuoto (%s) → trattato come mancante e riempito', (empty) => {
    const r = run([{ id: 'n', defId: 'action_http_request', config: { url: 'https://x', method: empty as unknown } }]);
    expect(r.nodes[0]!.config!.method).toBe('GET');
  });
});

describe('normalize_enum', () => {
  it('🚨 "get" → "GET" (case-fix al valore canonico)', () => {
    const r = run([{ id: 'n', defId: 'action_http_request', config: { url: 'https://x', method: 'get' } }]);
    expect(r.nodes[0]!.config!.method).toBe('GET');
    expect(r.applied).toContainEqual({ kind: 'normalize_enum', nodeId: 'n', defId: 'action_http_request', key: 'method', value: 'GET', previous: 'get' });
  });

  it('"Post" → "POST"', () => {
    const r = run([{ id: 'n', defId: 'action_http_request', config: { url: 'https://x', method: 'Post' } }]);
    expect(r.nodes[0]!.config!.method).toBe('POST');
  });

  it('valore già canonico → nessun intervento', () => {
    const r = run([{ id: 'n', defId: 'action_http_request', config: { url: 'https://x', method: 'POST' } }]);
    expect(r.applied.some((f) => f.kind === 'normalize_enum')).toBe(false);
  });

  it('🚨 valore enum NON riconducibile (PATCH) → NON inventato (resta, al validatore)', () => {
    const r = run([{ id: 'n', defId: 'action_http_request', config: { url: 'https://x', method: 'PATCH' } }]);
    expect(r.nodes[0]!.config!.method).toBe('PATCH');
    expect(r.applied.some((f) => f.kind === 'normalize_enum')).toBe(false);
  });

  it('🚨 espressione su enum → MAI toccata (method intatto; nessuna fix SU method)', () => {
    const r = run([{ id: 'n', defId: 'action_http_request', config: { url: 'https://x', method: '{{ vars.m }}' } }]);
    expect(r.nodes[0]!.config!.method).toBe('{{ vars.m }}');
    expect(r.applied.some((f) => f.key === 'method')).toBe(false); // né normalize né fill su method
  });
});

describe('robustezza & immutabilità', () => {
  it('defId sconosciuto → nodo intatto, nessuna fix', () => {
    const r = run([{ id: 'n', defId: 'mistero', config: { x: 1 } }]);
    expect(r.nodes[0]!.config).toEqual({ x: 1 });
    expect(r.applied).toEqual([]);
  });

  it('config assente (undefined) → riempie i default senza crashare', () => {
    const r = run([{ id: 'n', defId: 'action_http_request' }]);
    expect(r.nodes[0]!.config!.method).toBe('GET');
    expect(r.nodes[0]!.config!.timeout).toBe(30);
  });

  it('🚨 NON muta l\'input (config originale invariata)', () => {
    const input = [{ id: 'n', defId: 'action_http_request', config: { url: 'https://x' } }];
    const snapshot = JSON.stringify(input);
    applyDeterministicAutoConfig(input, SPEC);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('preserva campi extra del nodo (x/y/label)', () => {
    const r = applyDeterministicAutoConfig(
      [{ id: 'n', defId: 'action_http_request', config: { url: 'https://x' }, x: 5, y: 7, label: 'L' }],
      SPEC,
    );
    expect(r.nodes[0]).toMatchObject({ x: 5, y: 7, label: 'L' });
  });
});
