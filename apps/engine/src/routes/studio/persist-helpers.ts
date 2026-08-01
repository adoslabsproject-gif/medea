/**
 * Helper di persistenza per le generazioni studio.
 *
 * `width`/`height` viaggiano dentro `params` (sia per le immagini sia per i video)
 * ma la tabella `generations` ha colonne dedicate `width`/`height`: vanno PROMOSSE
 * esplicitamente, altrimenti restano NULL (era il bug: il finalizer salvava i
 * params come JSON ma non popolava le colonne).
 *
 * @module routes/studio/persist-helpers
 */

export interface PromotedDims {
  width?: number;
  height?: number;
}

/** Estrae width/height numerici da `params` per le colonne dedicate (undefined se assenti/non numerici). */
export function dimsFromParams(params: Record<string, unknown> | undefined): PromotedDims {
  const out: PromotedDims = {};
  const w = params?.width;
  const h = params?.height;
  if (typeof w === 'number' && Number.isFinite(w)) out.width = w;
  if (typeof h === 'number' && Number.isFinite(h)) out.height = h;
  return out;
}
