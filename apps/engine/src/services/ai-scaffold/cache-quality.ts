/**
 * Qualità del template-cache: SOLO i workflow che la LLM ha prodotto PULITI
 * meritano di diventare template (riproposti su cache-hit).
 *
 * Se l'auto-fix ha dovuto SANARE la STRUTTURA del grafo (merge mancante, fan-in
 * inserito, nodi duplicati merge-ati), la LLM aveva prodotto un grafo INCOMPLETO/
 * sbagliato → bassa qualità → NON cachare; e se una entry cached richiede questo
 * heal su retrieval, EVICTARLA (così il "template merda" smette di tornare).
 * I fix TRIVIALI (placeholder→secret, id→picker) NON pregiudicano la qualità.
 *
 * Bug origine: "Sitemap Crawler Full-Site Audit" (2026-06-11) — la LLM dimenticava
 * il nodo merge, l'auto-fix lo ricreava, ma il workflow finiva cachato e veniva
 * ri-proposto ad ogni richiesta simile come se fosse un template valido.
 *
 * Modulo PURO → testabile in isolamento, single source of truth per le due
 * decisioni (save-gate fresh-gen + evict su cache-hit).
 */

/** Tipi di auto-fix che indicano un grafo LLM strutturalmente incompleto/errato. */
export const STRUCTURAL_FIX_TYPES: ReadonlySet<string> = new Set([
  'orphan_edge_healed', // edge verso un nodo merge mai emesso
  'fan_in_merge_inserted', // N branch convergenti senza aggregator
  'merge_duplicate_nodes', // nodi identici duplicati dalla LLM
]);

/** True se uno dei fix applicati è STRUTTURALE. */
export function hasStructuralFix(appliedFixTypes: readonly string[]): boolean {
  return appliedFixTypes.some((t) => STRUCTURAL_FIX_TYPES.has(t));
}

/**
 * Un workflow è cache-worthy SOLO se non ha richiesto heal strutturali E non ha
 * warning del quality-gate. I fix triviali sono tollerati.
 */
export function isWorkflowCacheWorthy(
  appliedFixTypes: readonly string[],
  qualityWarningsCount: number,
): boolean {
  return !hasStructuralFix(appliedFixTypes) && qualityWarningsCount === 0;
}

/** Una entry cached va EVICTATA se, ri-validata su retrieval, richiede heal strutturali. */
export function shouldEvictCachedEntry(retrievalFixTypes: readonly string[]): boolean {
  return hasStructuralFix(retrievalFixTypes);
}
