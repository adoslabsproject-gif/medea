/**
 * Test catalog-validator — il vincolo che vale per TUTTI i provider.
 *
 * Approccio anti-greensmoke: un workflow CORRETTO passa con ZERO violazioni;
 * poi, una alla volta, inietto OGNI classe di errore (defId inventato, chiave
 * config inventata, enum fuori lista, action inesistente, required mancante) e
 * pretendo ESATTAMENTE quella violazione. Più: le espressioni `{{ }}` non
 * devono mai produrre falsi positivi su enum/required.
 */
import { describe, it, expect } from 'vitest';
import { buildCatalogSpec } from './catalog-spec.js';
import {
  validateNodesAgainstCatalog,
  validateNodesAgainstCatalogEntries,
  describeViolation,
  type CatalogViolation,
  type ScaffoldNodeLike,
} from './catalog-validator.js';
import type { NodeCatalogEntry } from './node-catalog.js';

const CATALOG: NodeCatalogEntry[] = [
  {
    defId: 'action_http_request',
    type: 'action',
    label: 'HTTP',
    description: '',
    fields: [
      { key: 'url', label: 'URL', type: 'text', required: true },
      {
        key: 'method',
        label: 'Method',
        type: 'select',
        required: true,
        options: ['GET', 'POST', 'PUT', 'DELETE'],
      },
      { key: 'apiKey', label: 'API Key', type: 'secret', required: true },
      { key: 'timeout', label: 'Timeout', type: 'number', required: false },
    ],
  },
  {
    defId: 'community_telegram',
    type: 'action',
    label: 'Telegram',
    description: '',
    fields: [{ key: 'botToken', label: 'Token', type: 'secret', required: true }],
    actions: [
      {
        id: 'send_message',
        label: 'Send',
        fields: [
          { key: 'chatId', label: 'Chat', type: 'text', required: true },
          { key: 'text', label: 'Text', type: 'textarea', required: true },
        ],
      },
      {
        id: 'get_updates',
        label: 'Get',
        fields: [{ key: 'limit', label: 'Limit', type: 'number', required: false }],
      },
    ],
  },
];
const SPEC = buildCatalogSpec(CATALOG);

function v(nodes: ScaffoldNodeLike[]): CatalogViolation[] {
  return validateNodesAgainstCatalog(nodes, SPEC);
}

describe('✅ workflow CORRETTO → zero violazioni', () => {
  it('http valido (url + method enum + timeout; secret apiKey omesso = pending)', () => {
    expect(
      v([
        {
          id: 'n1',
          defId: 'action_http_request',
          config: { url: 'https://x', method: 'GET', timeout: 30 },
        },
      ]),
    ).toEqual([]);
  });

  it('multi-azione valido (__action noto + suoi campi; botToken secret pending)', () => {
    expect(
      v([
        {
          id: 'n1',
          defId: 'community_telegram',
          config: { __action: 'send_message', chatId: '123', text: 'ciao' },
        },
      ]),
    ).toEqual([]);
  });

  it('expression al posto di un enum → NESSUNA violazione (risolta a runtime)', () => {
    expect(
      v([
        {
          id: 'n1',
          defId: 'action_http_request',
          config: { url: '{{ $json.u }}', method: '{{ vars.m }}' },
        },
      ]),
    ).toEqual([]);
  });
});

describe('🚨 unknown_def', () => {
  it('defId inventato → unknown_def, e basta (no altri controlli su un nodo senza spec)', () => {
    const out = v([{ id: 'n1', defId: 'action_inventato', config: { foo: 1 } }]);
    expect(out).toEqual([{ kind: 'unknown_def', nodeId: 'n1', defId: 'action_inventato' }]);
  });
});

describe('🚨 unknown_config_key', () => {
  it('chiave di config inesistente → unknown_config_key', () => {
    const out = v([
      {
        id: 'n1',
        defId: 'action_http_request',
        config: { url: 'https://x', method: 'GET', bogus: 1 },
      },
    ]);
    expect(out).toContainEqual({
      kind: 'unknown_config_key',
      nodeId: 'n1',
      defId: 'action_http_request',
      key: 'bogus',
    });
  });
  it('__action/__resource NON sono chiavi sconosciute (meta-keys)', () => {
    const out = v([
      {
        id: 'n1',
        defId: 'community_telegram',
        config: { __action: 'send_message', __resource: 'msg', chatId: 'c', text: 't' },
      },
    ]);
    expect(out.filter((x) => x.kind === 'unknown_config_key')).toEqual([]);
  });
});

describe('🚨 invalid_enum', () => {
  it('valore enum fuori lista → invalid_enum con allowed', () => {
    const out = v([
      { id: 'n1', defId: 'action_http_request', config: { url: 'https://x', method: 'PATCH' } },
    ]);
    expect(out).toContainEqual({
      kind: 'invalid_enum',
      nodeId: 'n1',
      defId: 'action_http_request',
      key: 'method',
      value: 'PATCH',
      allowed: ['GET', 'POST', 'PUT', 'DELETE'],
    });
  });
  it('enum valido → nessuna invalid_enum', () => {
    const out = v([
      { id: 'n1', defId: 'action_http_request', config: { url: 'https://x', method: 'POST' } },
    ]);
    expect(out.filter((x) => x.kind === 'invalid_enum')).toEqual([]);
  });
});

describe('🚨 invalid_action', () => {
  it('__action inesistente → invalid_action con allowed', () => {
    const out = v([
      {
        id: 'n1',
        defId: 'community_telegram',
        config: { __action: 'fly_to_moon', botToken: '{{secrets.T}}' },
      },
    ]);
    expect(out).toContainEqual({
      kind: 'invalid_action',
      nodeId: 'n1',
      defId: 'community_telegram',
      action: 'fly_to_moon',
      allowed: ['send_message', 'get_updates'],
    });
  });
  it('__action come expression → non validato (risolto a runtime)', () => {
    const out = v([
      { id: 'n1', defId: 'community_telegram', config: { __action: '{{ vars.act }}' } },
    ]);
    expect(out.filter((x) => x.kind === 'invalid_action')).toEqual([]);
  });
});

describe('🚨 missing_required', () => {
  it('required non-secret mancante (url) → missing_required', () => {
    const out = v([{ id: 'n1', defId: 'action_http_request', config: { method: 'GET' } }]);
    expect(out).toContainEqual({
      kind: 'missing_required',
      nodeId: 'n1',
      defId: 'action_http_request',
      key: 'url',
    });
  });
  it('🚨 secret required mancante (apiKey/botToken) → NESSUNA violazione (pending)', () => {
    const out = v([
      { id: 'n1', defId: 'action_http_request', config: { url: 'https://x', method: 'GET' } },
    ]);
    expect(out.filter((x) => x.kind === 'missing_required')).toEqual([]);
  });
  it.each([undefined, null, ''])('required = %s (vuoto) → missing_required', (empty) => {
    const out = v([
      { id: 'n1', defId: 'action_http_request', config: { url: empty as unknown, method: 'GET' } },
    ]);
    expect(out.some((x) => x.kind === 'missing_required' && x.key === 'url')).toBe(true);
  });
  it('campi required di un multi-azione NON sono forzati (non sappiamo quale action)', () => {
    // send_message richiede chatId/text MA come campi-action non sono required nello spec
    const out = v([
      { id: 'n1', defId: 'community_telegram', config: { __action: 'send_message' } },
    ]);
    expect(out.filter((x) => x.kind === 'missing_required')).toEqual([]);
  });
});

describe('aggregazione + convenience + describe', () => {
  it('più nodi → tutte le violazioni accumulate', () => {
    const out = v([
      { id: 'ok', defId: 'action_http_request', config: { url: 'https://x', method: 'GET' } },
      { id: 'bad1', defId: 'nope', config: {} },
      { id: 'bad2', defId: 'action_http_request', config: { url: 'https://x', method: 'WRONG' } },
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((x) => x.kind).sort()).toEqual(['invalid_enum', 'unknown_def']);
  });

  it('validateNodesAgainstCatalogEntries: stessa risposta partendo dal catalog grezzo', () => {
    const out = validateNodesAgainstCatalogEntries(
      [{ id: 'n1', defId: 'nope', config: {} }],
      CATALOG,
    );
    expect(out).toEqual([{ kind: 'unknown_def', nodeId: 'n1', defId: 'nope' }]);
  });

  it('config assente (undefined) non crasha + segnala i required', () => {
    const out = v([{ id: 'n1', defId: 'action_http_request' }]);
    expect(out.some((x) => x.kind === 'missing_required' && x.key === 'url')).toBe(true);
    expect(out.some((x) => x.kind === 'missing_required' && x.key === 'method')).toBe(true);
  });

  it('describeViolation copre tutte le classi (messaggi non vuoti)', () => {
    const samples: CatalogViolation[] = [
      { kind: 'unknown_def', nodeId: 'n', defId: 'd' },
      { kind: 'unknown_config_key', nodeId: 'n', defId: 'd', key: 'k' },
      { kind: 'invalid_enum', nodeId: 'n', defId: 'd', key: 'k', value: 'x', allowed: ['a'] },
      { kind: 'invalid_action', nodeId: 'n', defId: 'd', action: 'a', allowed: ['b'] },
      { kind: 'missing_required', nodeId: 'n', defId: 'd', key: 'k' },
    ];
    for (const s of samples) expect(describeViolation(s).length).toBeGreaterThan(10);
  });
});
