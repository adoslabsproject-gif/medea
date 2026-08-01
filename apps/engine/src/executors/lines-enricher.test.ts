/**
 * Test 2026-grade — executors/lines-enricher.ts (PDF lines enrichment).
 *
 * 🚨 PURE FUNCTION: zero I/O, zero dipendenze esterne — bug = silenzioso
 *    enrichment sbagliato → validate fallisce → flow va su error_alert.
 *
 * 🚨 SECURITY REGEX: codes contengono char special (./*+?) — devono essere
 *    escapati nel pattern, altrimenti . matcha qualsiasi char → false match.
 *
 * 🚨 PASSTHROUGH input: tutti i campi originali preservati (order_number,
 *    totale_imponibile, ecc.). Solo `lines` sovrascritto. Mutilare paylod
 *    rompe il validate downstream (bug noto produzione).
 *
 * 🚨 INCLUDE PATTERN regex invalida → skip silente (no crash flow).
 *
 * 🚨 EXCLUDE PREFIX case-insensitive con trim (whitespace tollerante).
 *
 * 🚨 SUB-DESCRIPTION lookup: trova code → next line. Se next line contiene
 *    UN ALTRO code → reject (è la prossima order line, non sub-desc).
 */
import { describe, it, expect } from 'vitest';
import {
  findSubDescription,
  codeMatchesIncludePattern,
  subDescIsExcluded,
  linesEnrichExecutor,
} from './lines-enricher.js';

describe('🚨 findSubDescription — PDF line lookup', () => {
  it('🚨 happy: code trovato → next line ritornata trimmed', () => {
    const text = `Header\nVAL-123 Valvola standard\n  descrizione aggiuntiva DN50\nVAL-456 Altra valvola`;
    expect(findSubDescription(text, 'VAL-123', ['VAL-123', 'VAL-456']))
      .toBe('descrizione aggiuntiva DN50');
  });

  it('🚨 code non trovato → "" vuoto', () => {
    expect(findSubDescription('totalmente altro testo', 'GHOST-999', ['GHOST-999'])).toBe('');
  });

  it('🚨 productCode vuoto → "" early return', () => {
    expect(findSubDescription('qualunque testo', '', ['x'])).toBe('');
  });

  it('🚨 SECURITY: code con regex char "." → escapato', () => {
    const text = `V.123 prima valvola\n  sub desc per V.123\nV.456 seconda`;
    expect(findSubDescription(text, 'V.123', ['V.123', 'V.456']))
      .toBe('sub desc per V.123');
    // Verifica che "." NON ha matchato qualsiasi char
    expect(findSubDescription(text, 'V.XYZ', ['V.123', 'V.XYZ'])).toBe('');
  });

  it('🚨 SECURITY: code con regex char "*+?" → escapati', () => {
    const text = `A*B prima\n  sub desc\nC+D altra`;
    expect(findSubDescription(text, 'A*B', ['A*B', 'C+D'])).toBe('sub desc');
  });

  it('🚨 code è ULTIMA linea → "" (no next line)', () => {
    const text = `header\nVAL-LAST`;
    expect(findSubDescription(text, 'VAL-LAST', ['VAL-LAST'])).toBe('');
  });

  it('🚨 next line VUOTA → "" (trim filter)', () => {
    const text = `VAL-1\n\nVAL-2`;
    expect(findSubDescription(text, 'VAL-1', ['VAL-1', 'VAL-2'])).toBe('');
  });

  it('🚨 next line CONTAINS ALTRO code → "" (è la prossima order line)', () => {
    const text = `VAL-1 prima\nVAL-2 seconda subito dopo`;
    expect(findSubDescription(text, 'VAL-1', ['VAL-1', 'VAL-2'])).toBe('');
  });

  it('🚨 next line contiene proprio codice nel testo → comunque accettata', () => {
    // Il check escluda solo "altri" codes — il proprio code può comparire
    const text = `VAL-1 prima\n  ulteriore desc VAL-1 codice ripetuto`;
    expect(findSubDescription(text, 'VAL-1', ['VAL-1']))
      .toBe('ulteriore desc VAL-1 codice ripetuto');
  });

  it('🚨 CRLF line endings supportati', () => {
    const text = `VAL-1\r\n  sub desc CRLF\r\nVAL-2`;
    expect(findSubDescription(text, 'VAL-1', ['VAL-1', 'VAL-2'])).toBe('sub desc CRLF');
  });

  it('🚨 word boundary: VAL-12 NON matcha VAL-123', () => {
    const text = `VAL-123 prima\n  desc\nVAL-12 secondo`;
    expect(findSubDescription(text, 'VAL-12', ['VAL-12', 'VAL-123'])).toBe('');
    // VAL-123 dovrebbe trovare la sua sub
    expect(findSubDescription(text, 'VAL-123', ['VAL-12', 'VAL-123'])).toBe('desc');
  });
});

describe('🚨 codeMatchesIncludePattern — regex include', () => {
  it('🚨 happy: pattern matcha → true', () => {
    expect(codeMatchesIncludePattern('VAL-123', ['^VAL'])).toBe(true);
  });

  it('🚨 NESSUN pattern matcha → false', () => {
    expect(codeMatchesIncludePattern('ABC-999', ['^VAL', '^XYZ'])).toBe(false);
  });

  it('🚨 lista vuota → false', () => {
    expect(codeMatchesIncludePattern('VAL-123', [])).toBe(false);
  });

  it('🚨 SECURITY: pattern regex INVALIDA → skip silent, no crash', () => {
    expect(codeMatchesIncludePattern('VAL-1', ['[unclosed-bracket'])).toBe(false);
  });

  it('🚨 trim whitespace pattern', () => {
    expect(codeMatchesIncludePattern('VAL-1', ['   ', '^VAL'])).toBe(true);
  });

  it('🚨 multiple pattern: short-circuit appena trova match', () => {
    expect(codeMatchesIncludePattern('VAL-1', ['^A', '^B', '^VAL'])).toBe(true);
  });

  it('🚨 case-sensitive default (regex senza flag i)', () => {
    expect(codeMatchesIncludePattern('val-1', ['^VAL'])).toBe(false);
  });

  it('🚨🚨 ReDoS: pattern "evil" su input patologico ritorna ISTANTANEO (RE2 lineare)', () => {
    // `(a+)+$` su una stringa di sole "a" senza match finale = catastrophic
    // backtracking con il RegExp di V8 (secondi/minuti, CPU 100%). RE2 è lineare
    // → deve completare in millisecondi. Soglia larga (500ms) ma V8 qui esploderebbe.
    const evil = '(a+)+$';
    const pathological = `${'a'.repeat(40)}!`; // 40 'a' + char che impedisce il match
    const t0 = Date.now();
    const res = codeMatchesIncludePattern(pathological, [evil]);
    const elapsed = Date.now() - t0;
    expect(res).toBe(false);
    expect(elapsed).toBeLessThan(500);
  });

  it('🚨 feature non-RE2 (backreference) → skip sicuro, niente fallback vulnerabile', () => {
    // RE2 rifiuta le backreference (richiedono backtracking) → safeUserRegex lancia
    // UnsafeRegexError, il catch lo ingoia (skip), NESSUN fallback a RegExp di V8.
    expect(codeMatchesIncludePattern('abcabc', ['(abc)\\1'])).toBe(false);
  });
});

describe('🚨 subDescIsExcluded — prefix blocklist', () => {
  it('🚨 prefix match → true', () => {
    expect(subDescIsExcluded('OMAGGIO incluso', ['OMAGGIO'])).toBe(true);
  });

  it('🚨 case-insensitive', () => {
    expect(subDescIsExcluded('omaggio incluso', ['OMAGGIO'])).toBe(true);
    expect(subDescIsExcluded('OMAGGIO incluso', ['omaggio'])).toBe(true);
  });

  it('🚨 trim whitespace nel prefix', () => {
    expect(subDescIsExcluded('OMAGGIO', ['  OMAGGIO  '])).toBe(true);
  });

  it('🚨 prefix vuoto → skip (no falso positivo)', () => {
    expect(subDescIsExcluded('Qualsiasi testo', ['', '  '])).toBe(false);
  });

  it('🚨 starts-with strict (no substring match)', () => {
    expect(subDescIsExcluded('Testo con OMAGGIO in mezzo', ['OMAGGIO'])).toBe(false);
  });

  it('🚨 empty desc → false', () => {
    expect(subDescIsExcluded('', ['OMAGGIO'])).toBe(false);
  });
});

describe('🚨 linesEnrichExecutor — flow end-to-end', () => {
  const ctx = {} as never;

  it('🚨 happy path: enrichment applicato + count', async () => {
    const r = await linesEnrichExecutor({
      rawTextExpression: 'VAL-1 prima\n  Sub desc per 1\nVAL-2 seconda\n  Sub desc per 2',
      includeCodePatterns: '^VAL',
      excludePrefixes: '',
      linesExpression: [
        { product_code: 'VAL-1', product_description: 'Base 1' },
        { product_code: 'VAL-2', product_description: 'Base 2' },
      ],
    } as never, null, ctx);
    const out = r.output as { lines: { product_description: string }[]; enrichedCount: number };
    expect(out.enrichedCount).toBe(2);
    expect(out.lines[0]!.product_description).toBe('Base 1 — Sub desc per 1');
    expect(out.lines[1]!.product_description).toBe('Base 2 — Sub desc per 2');
  });

  it('🚨 rawText missing → throw obbligatorio', async () => {
    await expect(
      linesEnrichExecutor({ includeCodePatterns: '^X' } as never, null, ctx),
    ).rejects.toThrow(/Testo PDF grezzo/u);
  });

  it('🚨 PASSTHROUGH: tutti i campi input preservati', async () => {
    const input = {
      order_number: 'ORD-100',
      totale_imponibile: 999.99,
      is_purchase_order: true,
      lines: [{ product_code: 'VAL-1', product_description: 'B' }],
    };
    const r = await linesEnrichExecutor({
      rawTextExpression: 'VAL-1\n  Sub desc',
      includeCodePatterns: '^VAL',
    } as never, input, ctx);
    const out = r.output as { order_number: string; totale_imponibile: number; is_purchase_order: boolean; lines: { product_description: string }[] };
    expect(out.order_number).toBe('ORD-100');
    expect(out.totale_imponibile).toBe(999.99);
    expect(out.is_purchase_order).toBe(true);
    expect(out.lines[0]!.product_description).toBe('B — Sub desc');
  });

  it('🚨 separator custom override default " — "', async () => {
    const r = await linesEnrichExecutor({
      rawTextExpression: 'VAL-1\n  Sub',
      includeCodePatterns: '^VAL',
      separator: ' | ',
      linesExpression: [{ product_code: 'VAL-1', product_description: 'Base' }],
    } as never, null, ctx);
    const out = r.output as { lines: { product_description: string }[] };
    expect(out.lines[0]!.product_description).toBe('Base | Sub');
  });

  it('🚨 line senza product_code → passthrough', async () => {
    const r = await linesEnrichExecutor({
      rawTextExpression: 'nothing',
      includeCodePatterns: '^VAL',
      linesExpression: [{ product_description: 'No code line' }],
    } as never, null, ctx);
    const out = r.output as { lines: { product_description: string }[]; enrichedCount: number };
    expect(out.enrichedCount).toBe(0);
    expect(out.lines[0]!.product_description).toBe('No code line');
  });

  it('🚨 line con code NON matching include → passthrough', async () => {
    const r = await linesEnrichExecutor({
      rawTextExpression: 'XYZ-999\n  sub',
      includeCodePatterns: '^VAL',
      linesExpression: [{ product_code: 'XYZ-999', product_description: 'Base' }],
    } as never, null, ctx);
    const out = r.output as { lines: { product_description: string }[]; enrichedCount: number };
    expect(out.enrichedCount).toBe(0);
    expect(out.lines[0]!.product_description).toBe('Base');
  });

  it('🚨 sub desc in excludePrefixes → skip enrich', async () => {
    const r = await linesEnrichExecutor({
      rawTextExpression: 'VAL-1\n  OMAGGIO promozionale',
      includeCodePatterns: '^VAL',
      excludePrefixes: 'OMAGGIO\nNOTA',
      linesExpression: [{ product_code: 'VAL-1', product_description: 'Base' }],
    } as never, null, ctx);
    const out = r.output as { lines: { product_description: string }[]; enrichedCount: number };
    expect(out.enrichedCount).toBe(0);
    expect(out.lines[0]!.product_description).toBe('Base');
  });

  it('🚨 baseDesc vuoto → solo sub desc (no separator)', async () => {
    const r = await linesEnrichExecutor({
      rawTextExpression: 'VAL-1\n  Only sub',
      includeCodePatterns: '^VAL',
      linesExpression: [{ product_code: 'VAL-1', product_description: '' }],
    } as never, null, ctx);
    const out = r.output as { lines: { product_description: string }[] };
    expect(out.lines[0]!.product_description).toBe('Only sub');
  });

  it('🚨 input array diretto → usato come lines', async () => {
    const r = await linesEnrichExecutor({
      rawTextExpression: 'VAL-1\n  Sub',
      includeCodePatterns: '^VAL',
    } as never, [{ product_code: 'VAL-1', product_description: 'B' }] as never, ctx);
    const out = r.output as { lines: { product_description: string }[]; enrichedCount: number };
    expect(out.enrichedCount).toBe(1);
    expect(out.lines[0]!.product_description).toBe('B — Sub');
  });

  it('🚨 input array → passthrough vuoto (Array no spread)', async () => {
    const r = await linesEnrichExecutor({
      rawTextExpression: 'nothing',
      includeCodePatterns: '^VAL',
    } as never, [{ product_code: 'A', product_description: 'B' }] as never, ctx);
    const out = r.output as Record<string, unknown>;
    // Array input → no passthrough, solo lines + enrichedCount
    expect(Object.keys(out).sort()).toEqual(['enrichedCount', 'lines']);
  });

  it('🚨 multiple patterns include su righe diverse', async () => {
    const r = await linesEnrichExecutor({
      rawTextExpression: 'VAL-1\n  S1\nXYZ-2\n  S2',
      includeCodePatterns: '^VAL\n^XYZ',
      linesExpression: [
        { product_code: 'VAL-1', product_description: 'B1' },
        { product_code: 'XYZ-2', product_description: 'B2' },
      ],
    } as never, null, ctx);
    const out = r.output as { lines: { product_description: string }[]; enrichedCount: number };
    expect(out.enrichedCount).toBe(2);
  });

  it('🚨 durationMs ritornato', async () => {
    const r = await linesEnrichExecutor({
      rawTextExpression: 'x',
      includeCodePatterns: '',
    } as never, [] as never, ctx);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});
