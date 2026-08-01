/**
 * Bug-bounty del primitivo anti-XSS (escapeHtml / scriptStringLiteral).
 *
 * Funzioni pure → test deterministici al 100%. Coprono i payload classici
 * di XSS riflesso e i due contesti (markup HTML vs string literal in <script>).
 */
import { describe, it, expect } from 'vitest';
import { escapeHtml, scriptStringLiteral } from './html-escape.js';

describe('escapeHtml — contesto markup HTML', () => {
  it('escapa tutti e cinque i metacaratteri', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('neutralizza un payload <script> riflesso', () => {
    const out = escapeHtml('<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('</script>');
    expect(out).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('neutralizza un break-out di attributo (onerror)', () => {
    const out = escapeHtml('x" onerror="alert(1)');
    expect(out).not.toContain('"');
    expect(out).toContain('&quot;');
  });

  it('escapa & per primo, senza doppia-codifica delle entità reali', () => {
    // Ordine corretto: "&lt;" non deve diventare "&amp;lt;" partendo da "<".
    expect(escapeHtml('<')).toBe('&lt;');
    // Ma un "&" letterale in input DEVE diventare "&amp;".
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('lascia intatto testo senza metacaratteri ed è no-op su stringa vuota', () => {
    expect(escapeHtml('hello world 123')).toBe('hello world 123');
    expect(escapeHtml('')).toBe('');
  });
});

describe('scriptStringLiteral — contesto JS dentro <script>', () => {
  it('produce un literal quotato che round-trippa al valore originale', () => {
    const inputs = ['google', 'a"b', "a'b", 'a\\b', 'line1\nline2', '日本語'];
    for (const s of inputs) {
      const lit = scriptStringLiteral(s);
      expect(lit.startsWith('"')).toBe(true);
      // Il literal è JSON-valido e decodifica esattamente al valore di partenza.
      expect(JSON.parse(lit)).toBe(s);
    }
  });

  it('CRITICO: neutralizza la chiusura del tag </script>', () => {
    const lit = scriptStringLiteral('</script><img src=x onerror=alert(1)>');
    // Nessuna sequenza di chiusura tag letterale può sopravvivere.
    expect(lit.toLowerCase()).not.toContain('</script');
    expect(lit).not.toContain('<');
    expect(lit).toContain('\\u003c');
    // Resta comunque un literal JS corretto.
    expect(JSON.parse(lit)).toBe('</script><img src=x onerror=alert(1)>');
  });

  it('escapa i separatori di riga U+2028 / U+2029 (illegali in JS string literal)', () => {
    const lit = scriptStringLiteral(`a${String.fromCodePoint(0x2028)}b${String.fromCodePoint(0x2029)}c`);
    expect(lit).toContain('\\u2028');
    expect(lit).toContain('\\u2029');
    // Non devono restare i codepoint grezzi nel literal.
    expect(lit).not.toContain(String.fromCodePoint(0x2028));
    expect(lit).not.toContain(String.fromCodePoint(0x2029));
  });

  it('le virgolette interne non possono terminare il literal', () => {
    const lit = scriptStringLiteral('"; alert(1); "');
    // Le doppie virgolette del payload sono escapate (\"), non chiudono la stringa.
    expect(JSON.parse(lit)).toBe('"; alert(1); "');
  });
});
