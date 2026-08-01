/**
 * Bug-bounty test — transpiler espressioni n8n → FlowForge.
 *
 * Cerca i bug VERI della conversione: leading `=`, riferimenti per NOME nodo →
 * id, accesso bracket → dot (senza rompere indici numerici/chiavi con spazi),
 * template misti testo+espressione, e l'ONESTÀ sui helper non convertibili.
 */
import { describe, it, expect } from 'vitest';
import { transpileN8nExpression, transpileConfigExpressions } from './n8n-expression.js';

const NAMES = new Map<string, string>([
  ['HTTP Request', 'http_request_1'],
  ['Set', 'set_2'],
]);

describe('transpileN8nExpression — base', () => {
  it('valore letterale (no leading =) → invariato', () => {
    expect(transpileN8nExpression('https://example.com', NAMES).value).toBe('https://example.com');
    // anche se contiene {{ }} ma SENZA =, in n8n è testo letterale → non toccato
    expect(transpileN8nExpression('ciao {{ non-espr }}', NAMES).value).toBe('ciao {{ non-espr }}');
  });

  it('strip del leading = + trim dentro {{ }}', () => {
    expect(transpileN8nExpression('={{ $json.email }}', NAMES).value).toBe('{{$json.email}}');
  });

  it('template misto testo + espressione', () => {
    const r = transpileN8nExpression('=https://api.com/users/{{ $json.id }}/profile', NAMES);
    expect(r.value).toBe('https://api.com/users/{{$json.id}}/profile');
  });

  it('più blocchi {{ }} nello stesso valore', () => {
    const r = transpileN8nExpression('={{ $json.first }} {{ $json.last }}', NAMES);
    expect(r.value).toBe('{{$json.first}} {{$json.last}}');
  });
});

describe('transpileN8nExpression — riferimenti per NOME nodo → id', () => {
  it('$node["HTTP Request"].json.x → $node.<id>.json.x', () => {
    const r = transpileN8nExpression('={{ $node["HTTP Request"].json.body }}', NAMES);
    expect(r.value).toBe('{{$node.http_request_1.json.body}}');
    expect(r.warnings).toHaveLength(0);
  });

  it('apici singoli e backtick gestiti', () => {
    expect(transpileN8nExpression("={{ $node['Set'].json.x }}", NAMES).value).toBe('{{$node.set_2.json.x}}');
    expect(transpileN8nExpression('={{ $node[`Set`].json.x }}', NAMES).value).toBe('{{$node.set_2.json.x}}');
  });

  it('nodo SCONOSCIUTO → warning + nome sanitizzato (non si perde il riferimento)', () => {
    const r = transpileN8nExpression('={{ $node["Ghost Node"].json.x }}', NAMES);
    expect(r.value).toBe('{{$node.Ghost_Node.json.x}}');
    expect(r.warnings.some((w) => w.includes('Ghost Node'))).toBe(true);
  });
});

describe('transpileN8nExpression — bracket → dot (e i casi che NON vanno toccati)', () => {
  it('$json["key"] → $json.key', () => {
    expect(transpileN8nExpression('={{ $json["email"] }}', NAMES).value).toBe('{{$json.email}}');
  });

  it('indice numerico NON viene dot-izzato ($json.items[0] resta)', () => {
    expect(transpileN8nExpression('={{ $json.items[0] }}', NAMES).value).toBe('{{$json.items[0]}}');
  });

  it('chiave con SPAZI resta bracket (non dot-izzabile)', () => {
    expect(transpileN8nExpression('={{ $json["full name"] }}', NAMES).value).toBe('{{$json["full name"]}}');
  });

  it('combo: $node["Set"].json["user id"] → id risolto, chiave-spazio resta bracket', () => {
    const r = transpileN8nExpression('={{ $node["Set"].json["first"]["user id"] }}', NAMES);
    expect(r.value).toBe('{{$node.set_2.json.first["user id"]}}');
  });
});

describe('transpileN8nExpression — ONESTÀ: helper non supportati segnalati', () => {
  it.each(['$items', '$workflow', '$execution', '$runIndex', '$itemIndex', '$binary', '$prevNode'])(
    '%s → warning (non convertibile)',
    (helper) => {
      const r = transpileN8nExpression(`={{ ${helper}.foo }}`, NAMES);
      expect(r.warnings.some((w) => w.includes(helper))).toBe(true);
    },
  );

  it('$now / $today / $json / $vars / $input → supportati, nessun warning', () => {
    for (const ok of ['$now', '$today', '$json.x', '$vars.k', '$input.body']) {
      expect(transpileN8nExpression(`={{ ${ok} }}`, NAMES).warnings).toHaveLength(0);
    }
  });

  it('warning deduplicati (stesso helper 2 volte → 1 warning)', () => {
    const r = transpileN8nExpression('={{ $items.a }} {{ $items.b }}', NAMES);
    expect(r.warnings.filter((w) => w.includes('$items'))).toHaveLength(1);
  });
});

describe('transpileConfigExpressions — oggetto config intero', () => {
  it('converte tutti i valori stringa + prefissa i warning con la chiave', () => {
    const { config, warnings } = transpileConfigExpressions(
      { url: '=https://api.com/{{ $node["Set"].json.id }}', method: 'GET', body: '={{ $items.all() }}' },
      NAMES,
    );
    expect(config.url).toBe('https://api.com/{{$node.set_2.json.id}}');
    expect(config.method).toBe('GET'); // letterale invariato
    expect(warnings.some((w) => w.startsWith('body:') && w.includes('$items'))).toBe(true);
  });
});
