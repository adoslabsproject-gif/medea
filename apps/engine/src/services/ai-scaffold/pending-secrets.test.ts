/**
 * Test 2026-grade — analyzePendingSecrets.
 *
 * Pure function: no DB, copre raccolta + dedupe + sorting + nested shapes.
 */
import { describe, it, expect } from 'vitest';
import { analyzePendingSecrets } from './pending-secrets.js';

describe('analyzePendingSecrets — base cases', () => {
  it('no secrets referenced → array vuoto', () => {
    const r = analyzePendingSecrets({
      nodes: [{ id: 'a', config: { url: 'https://example.com', method: 'GET' } }],
      configuredSecrets: new Set(),
    });
    expect(r).toEqual([]);
  });

  it('un secret referenziato + non configurato → reportato', () => {
    const r = analyzePendingSecrets({
      nodes: [{ id: 'http', config: { url: '{{secrets.API_URL}}' } }],
      configuredSecrets: new Set(),
    });
    expect(r).toEqual([
      { name: 'API_URL', referencedBy: ['http'], fields: ['url'] },
    ]);
  });

  it('secret gia\\` configurato → escluso (case-sensitive)', () => {
    const r = analyzePendingSecrets({
      nodes: [{ id: 'http', config: { url: '{{secrets.API_URL}}' } }],
      configuredSecrets: new Set(['API_URL']),
    });
    expect(r).toEqual([]);
  });

  it('case sensitivity: api_url != API_URL', () => {
    const r = analyzePendingSecrets({
      nodes: [{ id: 'http', config: { url: '{{secrets.API_URL}}' } }],
      configuredSecrets: new Set(['api_url']),
    });
    expect(r).toHaveLength(1);
    expect(r[0]?.name).toBe('API_URL');
  });
});

describe('analyzePendingSecrets — dedupe + sorting', () => {
  it('stesso secret in N nodi → uno solo nella response con referencedBy[N]', () => {
    const r = analyzePendingSecrets({
      nodes: [
        { id: 'n1', config: { token: '{{secrets.OPENAI_API_KEY}}' } },
        { id: 'n2', config: { apiKey: '{{secrets.OPENAI_API_KEY}}' } },
        { id: 'n3', config: { auth: 'Bearer {{secrets.OPENAI_API_KEY}}' } },
      ],
      configuredSecrets: new Set(),
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({
      name: 'OPENAI_API_KEY',
      referencedBy: ['n1', 'n2', 'n3'],
      fields: ['apiKey', 'auth', 'token'],
    });
  });

  it('multi-secret → output ordinato alfabeticamente per name', () => {
    const r = analyzePendingSecrets({
      nodes: [
        { id: 'n1', config: {
          a: '{{secrets.ZULU}}',
          b: '{{secrets.ALPHA}}',
          c: '{{secrets.MIKE}}',
        } },
      ],
      configuredSecrets: new Set(),
    });
    expect(r.map((p) => p.name)).toEqual(['ALPHA', 'MIKE', 'ZULU']);
  });

  it('referencedBy + fields ordinati alfabeticamente', () => {
    const r = analyzePendingSecrets({
      nodes: [
        { id: 'zebra', config: { z_field: '{{secrets.X}}' } },
        { id: 'alpha', config: { a_field: '{{secrets.X}}' } },
        { id: 'mike',  config: { m_field: '{{secrets.X}}' } },
      ],
      configuredSecrets: new Set(),
    });
    expect(r[0]?.referencedBy).toEqual(['alpha', 'mike', 'zebra']);
    expect(r[0]?.fields).toEqual(['a_field', 'm_field', 'z_field']);
  });
});

describe('analyzePendingSecrets — pattern edge cases', () => {
  it('spazi nel template {{ secrets.X }} → riconosciuto', () => {
    const r = analyzePendingSecrets({
      nodes: [{ id: 'n', config: { url: '{{ secrets.SLACK_TOKEN }}' } }],
      configuredSecrets: new Set(),
    });
    expect(r[0]?.name).toBe('SLACK_TOKEN');
  });

  it('reference SBAGLIATA {{secret.X}} (singular) → ignorata', () => {
    const r = analyzePendingSecrets({
      nodes: [{ id: 'n', config: { url: '{{secret.X}}' } }],
      configuredSecrets: new Set(),
    });
    expect(r).toEqual([]);
  });

  it('reference {{$node.X.json.y}} → non confuso con secret', () => {
    const r = analyzePendingSecrets({
      nodes: [{ id: 'n', config: {
        url: '{{$node.web.json.url}}',
        auth: 'Bearer {{secrets.API_KEY}}',
      } }],
      configuredSecrets: new Set(),
    });
    expect(r).toHaveLength(1);
    expect(r[0]?.name).toBe('API_KEY');
  });

  it('character non legali in nome → stoppa al primo invalido', () => {
    // `{{secrets.HAS-DASH}}` non è BCP-secret-name valid → solo `HAS` matcha?
    // No: la regex richiede [A-Za-z_][A-Za-z0-9_]* → "HAS" matcha, "-DASH}}" rifiutato
    const r = analyzePendingSecrets({
      nodes: [{ id: 'n', config: { url: '{{secrets.HAS-DASH}}' } }],
      configuredSecrets: new Set(),
    });
    // Il match parziale non lo riconosciamo come secret valido perché la regex
    // richiede `\}\}` di chiusura → ZERO match
    expect(r).toEqual([]);
  });
});

describe('analyzePendingSecrets — nested values', () => {
  it('valore array stringhe → secrets estratti', () => {
    const r = analyzePendingSecrets({
      nodes: [{ id: 'n', config: {
        // Cast oltre `string` per simulare config con nested array
        recipients: ['{{secrets.EMAIL_TO}}', 'fixed@x.com'] as unknown as string,
      } }],
      configuredSecrets: new Set(),
    });
    expect(r.map((p) => p.name)).toEqual(['EMAIL_TO']);
  });

  it('valore oggetto annidato → secrets estratti', () => {
    const r = analyzePendingSecrets({
      nodes: [{ id: 'n', config: {
        headers: { Authorization: 'Bearer {{secrets.JWT}}' } as unknown as string,
      } }],
      configuredSecrets: new Set(),
    });
    expect(r.map((p) => p.name)).toEqual(['JWT']);
  });

  it('null / undefined / number / boolean → ignorati', () => {
    const r = analyzePendingSecrets({
      nodes: [{ id: 'n', config: {
        n: null as unknown as string,
        u: undefined as unknown as string,
        i: 42 as unknown as string,
        b: false as unknown as string,
        s: '{{secrets.VALID}}',
      } }],
      configuredSecrets: new Set(),
    });
    expect(r[0]?.name).toBe('VALID');
  });
});
