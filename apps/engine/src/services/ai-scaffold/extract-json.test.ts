/**
 * Test extract-json — tolleranza ai fence/prosa nell'output scaffold. Bug owner
 * 2026-06-17: Anthropic (BYOK) restituisce ```json … ``` → JSON.parse diretto
 * crashava ("Unexpected token '`'"). Liara (guided_json) dà JSON puro → invariato.
 */
import { describe, it, expect } from 'vitest';
import { stripCodeFences, firstBalancedJsonObject, parseScaffoldJson } from './extract-json.js';

describe('parseScaffoldJson', () => {
  it('JSON puro (Liara guided_json) → parse diretto', () => {
    expect(parseScaffoldJson('{"name":"wf","nodes":[]}')).toEqual({ name: 'wf', nodes: [] });
  });

  it('🚨 fence ```json (Anthropic/OpenAI) → estratto e parsato', () => {
    const raw = '```json\n{"name":"wf","nodes":[{"id":"a"}]}\n```';
    expect(parseScaffoldJson(raw)).toEqual({ name: 'wf', nodes: [{ id: 'a' }] });
  });

  it('🚨 fence senza "json" + spazi → ok', () => {
    expect(parseScaffoldJson('```\n{"x":1}\n```')).toEqual({ x: 1 });
  });

  it('🚨 prosa attorno al JSON → estrae il primo oggetto bilanciato', () => {
    const raw = 'Ecco il workflow richiesto:\n{"name":"wf","nodes":[]}\nSpero vada bene!';
    expect(parseScaffoldJson(raw)).toEqual({ name: 'wf', nodes: [] });
  });

  it('🚨 graffe dentro le stringhe non rompono il bilanciamento', () => {
    const raw = '```json\n{"tpl":"ciao {{nome}} } finto","n":1}\n```';
    expect(parseScaffoldJson(raw)).toEqual({ tpl: 'ciao {{nome}} } finto', n: 1 });
  });

  it('🚨 nessun JSON → errore chiaro', () => {
    expect(() => parseScaffoldJson('Mi dispiace, non posso aiutarti.')).toThrow(/oggetto JSON valido/u);
  });
});

describe('stripCodeFences', () => {
  it('rimuove ```json … ```', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('testo senza fence → invariato (trim)', () => {
    expect(stripCodeFences('  {"a":1}  ')).toBe('{"a":1}');
  });
});

describe('firstBalancedJsonObject', () => {
  it('estrae il primo oggetto bilanciato annidato', () => {
    expect(firstBalancedJsonObject('xx {"a":{"b":1}} yy')).toBe('{"a":{"b":1}}');
  });
  it('niente graffe → null', () => {
    expect(firstBalancedJsonObject('nessun json qui')).toBeNull();
  });
});
