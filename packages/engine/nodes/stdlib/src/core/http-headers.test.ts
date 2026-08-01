import { describe, it, expect } from 'vitest';
import { buildRequestHeaders } from './http-headers.js';
import { ValidationError } from './node-error.js';

describe('buildRequestHeaders — merge case-insensitive + precedenza', () => {
  it('vuoto → Headers vuoto', () => {
    const h = buildRequestHeaders({});
    expect([...h.keys()]).toEqual([]);
  });

  it('base → impostati', () => {
    const h = buildRequestHeaders({ base: { 'X-Foo': 'bar', Accept: 'application/json' } });
    expect(h.get('X-Foo')).toBe('bar');
    expect(h.get('Accept')).toBe('application/json');
  });

  it('auth VINCE sui base (stesso nome)', () => {
    const h = buildRequestHeaders({ base: { Authorization: 'old' }, auth: { Authorization: 'Bearer new' } });
    expect(h.get('Authorization')).toBe('Bearer new');
  });

  it('contentTypeDefault applicato SOLO se assente', () => {
    expect(buildRequestHeaders({ contentTypeDefault: 'application/json' }).get('Content-Type')).toBe('application/json');
    // già presente (stesso case) → NON sovrascritto
    expect(buildRequestHeaders({ base: { 'Content-Type': 'text/xml' }, contentTypeDefault: 'application/json' }).get('Content-Type')).toBe('text/xml');
  });

  it('⭐ CASE-INSENSITIVE: base "content-type" lowercase → il default NON aggiunge un duplicato', () => {
    // Esattamente il bug latente di openapi (headers["Content-Type"] ?? default).
    const h = buildRequestHeaders({ base: { 'content-type': 'application/xml' }, contentTypeDefault: 'application/json' });
    expect(h.get('Content-Type')).toBe('application/xml'); // .get è case-insensitive
    // UN SOLO header content-type (niente doppione).
    const ctKeys = [...h.keys()].filter((k) => k.toLowerCase() === 'content-type');
    expect(ctKeys).toHaveLength(1);
  });

  it('auth con case diverso dal base → sovrascrive (non duplica)', () => {
    const h = buildRequestHeaders({ base: { authorization: 'a' }, auth: { Authorization: 'b' } });
    expect(h.get('Authorization')).toBe('b');
    expect([...h.keys()].filter((k) => k.toLowerCase() === 'authorization')).toHaveLength(1);
  });

  it('contentTypeDefault vuoto/undefined → nessun Content-Type', () => {
    expect(buildRequestHeaders({ contentTypeDefault: '' }).has('Content-Type')).toBe(false);
    expect(buildRequestHeaders({ contentTypeDefault: undefined }).has('Content-Type')).toBe(false);
  });

  it('output è un Headers passabile a fetch (init.headers)', () => {
    const h = buildRequestHeaders({ auth: { Authorization: 'Bearer t' } });
    expect(h).toBeInstanceOf(Headers);
  });
});

describe('NF2 — nome/valore header malformato → ValidationError (mai TypeError grezzo)', () => {
  it('🚨 nome header con spazi (es. da headersJson utente) → ValidationError tipizzato', () => {
    // Headers.set lancerebbe un TypeError nudo; la dottrina #7 vuole un errore tipizzato.
    expect(() => buildRequestHeaders({ base: { 'X Bad Name': 'v' } })).toThrow(ValidationError);
    expect(() => buildRequestHeaders({ base: { 'X Bad Name': 'v' } })).toThrow(/Header non valido/u);
  });

  it('🚨 nome header con carattere di controllo → ValidationError', () => {
    expect(() => buildRequestHeaders({ base: { 'X--ctrl': 'v' } })).toThrow(ValidationError);
  });

  it('🚨 valore header con newline (CRLF injection) → ValidationError, NON TypeError', () => {
    let caught: unknown;
    try { buildRequestHeaders({ base: { 'X-Foo': 'val\r\nInjected: evil' } }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught).not.toBeInstanceOf(TypeError);
  });

  it('🚨 nome malformato nell\'AUTH (apiKeyHeaderName user-input) → ValidationError', () => {
    expect(() => buildRequestHeaders({ auth: { 'bad header': 'k' } })).toThrow(ValidationError);
  });

  it('header validi → nessun throw (regressione: il wrapper non rompe il caso buono)', () => {
    expect(() => buildRequestHeaders({ base: { 'X-Ok': 'v' }, auth: { Authorization: 'Bearer t' } })).not.toThrow();
  });
});
