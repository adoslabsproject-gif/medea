import { describe, it, expect } from 'vitest';
import { fitToModel, normalizeDims, resolveOutputDims, DIM_MIN, DIM_MAX, DIM_MULTIPLE, DEFAULT_AREA_BUDGET } from './fit-dims.js';

const isValidSide = (v: number): boolean => v >= DIM_MIN && v <= DIM_MAX && v % DIM_MULTIPLE === 0;

describe('fitToModel — preserva il FORMATO della sorgente (anti-crop/stretch)', () => {
  it('landscape 16:9 (1920×1080) → aspect preservato entro tolleranza snap', () => {
    const d = fitToModel(1920, 1080);
    expect(d.width).toBeGreaterThan(d.height);
    expect(Math.abs(d.width / d.height - 16 / 9)).toBeLessThan(0.05);
    expect(isValidSide(d.width) && isValidSide(d.height)).toBe(true);
  });

  it('ANTI-REGRESSIONE: portrait 9:16 (1080×1920) NON diventa landscape', () => {
    // È il bug che il fix risolve: una foto verticale che usciva 832×480 (orizz.)
    // veniva tagliata. MUTATION: se fitToModel ignorasse l'aspect → width>height → rosso.
    const d = fitToModel(1080, 1920);
    expect(d.height).toBeGreaterThan(d.width);
    expect(Math.abs(d.width / d.height - 9 / 16)).toBeLessThan(0.05);
    expect(isValidSide(d.width) && isValidSide(d.height)).toBe(true);
  });

  it('quadrato (1000×1000) → width ≈ height', () => {
    const d = fitToModel(1000, 1000);
    expect(d.width).toBe(d.height);
    expect(isValidSide(d.width)).toBe(true);
  });

  it('area risultante vicina al budget (entro 2× per via dello snap a 16)', () => {
    const d = fitToModel(1600, 900);
    const area = d.width * d.height;
    expect(area).toBeGreaterThan(DEFAULT_AREA_BUDGET / 2);
    expect(area).toBeLessThan(DEFAULT_AREA_BUDGET * 2);
  });

  it('budget custom maggiore (720p) → dimensioni più grandi', () => {
    const small = fitToModel(1920, 1080, 832 * 480);
    const big = fitToModel(1920, 1080, 1280 * 720);
    expect(big.width * big.height).toBeGreaterThan(small.width * small.height);
  });
});

describe('fitToModel — bug-bounty edge cases (input rotti)', () => {
  it.each([
    ['zero width', 0, 1080],
    ['zero height', 1920, 0],
    ['negative', -100, -50],
    ['NaN', NaN, 1080],
    ['Infinity', Infinity, 1080],
    ['both NaN', NaN, NaN],
  ])('%s → quadrato fallback con lati validi (no crash, no NaN)', (_label, w, h) => {
    const d = fitToModel(w, h);
    expect(Number.isFinite(d.width) && Number.isFinite(d.height)).toBe(true);
    expect(isValidSide(d.width) && isValidSide(d.height)).toBe(true);
  });

  it('aspect estremo panoramico (5000×200, 25:1) → lati clampati, mai fuori range', () => {
    const d = fitToModel(5000, 200);
    expect(d.width).toBe(DIM_MAX);   // clampato al massimo
    expect(d.height).toBe(DIM_MIN);  // clampato al minimo
    expect(isValidSide(d.width) && isValidSide(d.height)).toBe(true);
  });

  it('aspect estremo verticale (200×5000) → lati clampati specularmente', () => {
    const d = fitToModel(200, 5000);
    expect(d.width).toBe(DIM_MIN);
    expect(d.height).toBe(DIM_MAX);
  });

  it('areaBudget invalido (0/NaN) → fallback al budget di default', () => {
    expect(fitToModel(1920, 1080, 0)).toEqual(fitToModel(1920, 1080));
    expect(fitToModel(1920, 1080, NaN)).toEqual(fitToModel(1920, 1080));
  });
});

describe('normalizeDims — rete server (snap 16 + clamp, rispetta aspect scelto)', () => {
  it('snappa al multiplo di 16 più vicino', () => {
    expect(normalizeDims(833, 481)).toEqual({ width: 832, height: 480 });
  });
  it('clampa sopra il massimo e sotto il minimo', () => {
    expect(normalizeDims(5000, 10)).toEqual({ width: DIM_MAX, height: DIM_MIN });
  });
  it.each([
    ['NaN', NaN, 480],
    ['zero', 0, 480],
    ['negative', -800, 480],
  ])('%s → fallback al lato minimo (no crash)', (_l, w, h) => {
    const d = normalizeDims(w, h);
    expect(d.width).toBe(DIM_MIN);
    expect(isValidSide(d.height)).toBe(true);
  });
});

describe('resolveOutputDims — selettore server (sorgente nota vince sul form)', () => {
  it('con dimensioni sorgente valide → deriva dal formato (ignora il form)', () => {
    // form chiede landscape, ma la sorgente è verticale → deve vincere il verticale.
    const d = resolveOutputDims(1080, 1920, 832, 480);
    expect(d).toEqual(fitToModel(1080, 1920));
    expect(d.height).toBeGreaterThan(d.width);
  });

  it.each([
    ['srcW mancante', undefined, 1920],
    ['srcH mancante', 1080, undefined],
    ['srcW zero', 0, 1920],
    ['srcH NaN', 1080, NaN],
  ])('%s → ricade sul form normalizzato', (_l, sw, sh) => {
    const d = resolveOutputDims(sw, sh, 833, 481);
    expect(d).toEqual(normalizeDims(833, 481));
  });

  it('garanzia anti-taglio: una sorgente verticale NON produce mai output orizzontale', () => {
    // MUTATION: se resolveOutputDims usasse il form invece della sorgente →
    // width(832)>height(480) → rosso. È il cuore della feature.
    const d = resolveOutputDims(720, 1280, 832, 480);
    expect(d.height).toBeGreaterThan(d.width);
  });
});

describe('fitToModel — GUARD self-contained / iniettabile nel client', () => {
  // page.ts inietta `fitToModel.toString()` nello script client come UNICA fonte
  // di verità. Se la funzione riferisse simboli esterni (DIM_MAX, snapSide…),
  // l'iniezione fallirebbe a runtime nel browser → foto tagliate silenziosamente.
  // Questo test PROVA l'iniettabilità ricostruendo la funzione in isolamento.
  // MUTATION: se fitToModel usasse una costante module-level → ReferenceError → rosso.
  it('ricostruita da toString() in contesto isolato dà risultati IDENTICI', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- verifica reale di iniettabilità: ricostruisce la funzione come farebbe il client
    const injected = new Function(`return (${fitToModel.toString()})`)() as typeof fitToModel;
    for (const [w, h] of [[1920, 1080], [1080, 1920], [1000, 1000], [5000, 200], [0, 0]]) {
      expect(injected(w!, h!)).toEqual(fitToModel(w!, h!));
    }
  });

  it('il sorgente serializzato non referenzia simboli module-level', () => {
    const src = fitToModel.toString();
    expect(src).not.toMatch(/\bDIM_(MULTIPLE|MIN|MAX)\b/);
    expect(src).not.toMatch(/\bsnapSide\b/);
    expect(src).not.toMatch(/\bDEFAULT_AREA_BUDGET\b/);
  });
});
