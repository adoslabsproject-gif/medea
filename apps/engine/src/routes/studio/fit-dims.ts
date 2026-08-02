/**
 * fit-dims — calcolo dimensioni output rispettando il FORMATO della sorgente.
 *
 * PROBLEMA: per i2v (foto → video) ed extend (video caricato) il modello Wan
 * genera a `width`×`height` fissi del form (default 832×480). Se l'aspect ratio
 * del file caricato è diverso (verticale, quadrato, panoramico) → ComfyUI deve
 * adattare la sorgente alle dimensioni richieste → CROP o STRETCH → foto tagliata
 * o distorta. L'utente spesso NON conosce il formato del file che carica.
 *
 * SOLUZIONE: dall'aspect ratio reale della sorgente si derivano width/height che
 * (1) preservano le proporzioni (niente crop/stretch), (2) rispettano i vincoli
 * del modello (lati multipli di 16, range [256,1280]), (3) restano entro un
 * budget di area (px) per non far esplodere VRAM/tempo di render.
 *
 * `fitToModel` è SELF-CONTAINED (solo Math, costanti inline, nessun riferimento a
 * simboli esterni) di proposito: la stessa identica funzione viene INIETTATA nel
 * client (via `.toString()` in page.ts) per la pre-taratura dei form → una sola
 * fonte di verità per client e server (no formula duplicata che diverge). Il test
 * `fit-dims.test.ts` ASSERISCE questa proprietà (guard anti-drift): vedi
 * "self-contained / iniettabile".
 */

/** Vincoli del modello Wan 2.2: lati multipli di 16, range [256, 1280]. */
export const DIM_MULTIPLE = 16;
export const DIM_MIN = 256;
export const DIM_MAX = 1280;
/** Budget area default (px) ≈ 832×480 (480p) — bilanciamento qualità/VRAM/tempo. */
export const DEFAULT_AREA_BUDGET = 832 * 480;

export interface Dims {
  width: number;
  height: number;
}

/**
 * Snappa un valore al multiplo di 16 più vicino e lo clampa a [256, 1280].
 * Usata server-side per normalizzare dimensioni già scelte (form manuale).
 */
function snapSide(v: number): number {
  const snapped = Math.round(v / DIM_MULTIPLE) * DIM_MULTIPLE;
  return Math.min(DIM_MAX, Math.max(DIM_MIN, snapped));
}

/**
 * Normalizza dimensioni arbitrarie ai vincoli del modello (mult 16 + range).
 * Edge-safe: NaN/∞/≤0 → fallback al lato minimo. NON preserva aspect (è per
 * valori già scelti dall'utente: rispetta la sua scelta, garantisce solo validità).
 */
export function normalizeDims(width: number, height: number): Dims {
  const w = Number.isFinite(width) && width > 0 ? width : DIM_MIN;
  const h = Number.isFinite(height) && height > 0 ? height : DIM_MIN;
  return { width: snapSide(w), height: snapSide(h) };
}

/**
 * Deriva width/height dal formato della sorgente PRESERVANDO l'aspect ratio.
 * Edge-safe: dimensioni sorgente non valide → quadrato al budget (fallback sicuro).
 *
 * ⚠️ SELF-CONTAINED: nessun riferimento a simboli esterni (DIM_*, snapSide…) —
 * costanti inline — perché viene serializzata e iniettata nel client. NON
 * introdurre dipendenze esterne qui senza aggiornare il guard test.
 */
export function fitToModel(srcW: number, srcH: number, areaBudget: number = 832 * 480): Dims {
  const MULT = 16;
  const MIN = 256;
  const MAX = 1280;
  const budget = Number.isFinite(areaBudget) && areaBudget > 0 ? areaBudget : 832 * 480;
  const snap = (v: number): number => Math.min(MAX, Math.max(MIN, Math.round(v / MULT) * MULT));
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW <= 0 || srcH <= 0) {
    const s = snap(Math.sqrt(budget));
    return { width: s, height: s };
  }
  const ar = srcW / srcH;
  const h = Math.sqrt(budget / ar);
  const w = h * ar;
  return { width: snap(w), height: snap(h) };
}

/**
 * Selettore autoritativo delle dimensioni di output (usato server-side):
 *  - se le dimensioni SORGENTE (file caricato) sono note e valide → deriva dal
 *    formato reale ({@link fitToModel}) → niente foto/video tagliati, sempre;
 *  - altrimenti → normalizza i valori del form ({@link normalizeDims}), così la
 *    scelta manuale dell'utente (o il default) resta valida per il modello.
 */
export function resolveOutputDims(
  srcW: number | undefined,
  srcH: number | undefined,
  formW: number,
  formH: number,
): Dims {
  if (
    typeof srcW === 'number' &&
    typeof srcH === 'number' &&
    Number.isFinite(srcW) &&
    Number.isFinite(srcH) &&
    srcW > 0 &&
    srcH > 0
  ) {
    return fitToModel(srcW, srcH);
  }
  return normalizeDims(formW, formH);
}
