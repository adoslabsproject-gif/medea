/**
 * Test R7 — filenameFromContentDisposition con ext-value RFC 5987 completo
 * (`filename*=charset'lang'value`), non solo il caso `UTF-8''`.
 */
import { describe, it, expect } from 'vitest';
import { filenameFromContentDisposition } from './response-reader.js';

describe('R7 — filename* RFC 5987 (charset/lang)', () => {
  it('🚨 UTF-8 con language tag → value estratto e decodato', () => {
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8'it'fattura%20mese.pdf")).toBe('fattura mese.pdf');
  });

  it('🚨 charset NON UTF-8 (iso-8859-1) → value comunque estratto (non ignorato)', () => {
    // Prima del fix il regex matchava solo UTF-8'' → questo cadeva sul plain o si rompeva.
    expect(filenameFromContentDisposition("attachment; filename*=iso-8859-1'en'rates.txt")).toBe('rates.txt');
  });

  it('UTF-8 senza language → simbolo decodato', () => {
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8''%E2%82%AC.pdf")).toBe('€.pdf');
  });

  it('plain filename="x.pdf" → estratto', () => {
    expect(filenameFromContentDisposition('attachment; filename="report.pdf"')).toBe('report.pdf');
  });

  it('🚨 path traversal nel filename → basename (no ../)', () => {
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd")).toBe('passwd');
  });

  it('header assente/senza filename → undefined', () => {
    expect(filenameFromContentDisposition(null)).toBeUndefined();
    expect(filenameFromContentDisposition('inline')).toBeUndefined();
  });
});
