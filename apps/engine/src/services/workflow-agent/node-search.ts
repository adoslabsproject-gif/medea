/**
 * node-search — ricerca keyword sul catalog per il tool `search_nodes` (#3).
 *
 * Deterministica e pura (niente embedding/IO): l'agente la usa per TROVARE il
 * nodo pertinente invece di sceglierlo alla cieca tra ~200. Scoring pesato:
 * match esatto del defId > defId-substring > label/alias > descrizione.
 *
 * @module services/workflow-agent/node-search
 */
import type { NodeCatalogEntry } from '@/services/ai-scaffold/node-catalog.js';

export interface NodeSearchHit {
  defId: string;
  type: string;
  label: string;
  description: string;
  score: number;
}

/** Tokenizza una query in parole minuscole significative (≥2 char). */
function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length >= 2);
}

function scoreEntry(entry: NodeCatalogEntry, queryTokens: string[], rawQuery: string): number {
  const defId = entry.defId.toLowerCase();
  const label = entry.label.toLowerCase();
  const desc = entry.description.toLowerCase();
  const aliases = (entry.searchAliases ?? []).map((a) => a.toLowerCase());
  let score = 0;
  if (defId === rawQuery.toLowerCase().trim()) score += 100; // match esatto
  for (const t of queryTokens) {
    if (defId.includes(t)) score += 3;
    if (label.includes(t)) score += 2;
    if (aliases.some((a) => a.includes(t))) score += 2;
    if (desc.includes(t)) score += 1;
  }
  return score;
}

/** Ritorna i nodi più pertinenti alla query (score>0), ordinati, max `limit`. */
export function searchNodes(
  catalog: NodeCatalogEntry[],
  query: string,
  limit = 8,
): NodeSearchHit[] {
  const qt = tokens(query);
  if (qt.length === 0) return [];
  const hits: NodeSearchHit[] = [];
  for (const entry of catalog) {
    const score = scoreEntry(entry, qt, query);
    if (score > 0) {
      hits.push({
        defId: entry.defId,
        type: entry.type,
        label: entry.label,
        description: entry.description,
        score,
      });
    }
  }
  // Ordine stabile: score desc, poi defId asc (determinismo).
  hits.sort((a, b) => b.score - a.score || a.defId.localeCompare(b.defId));
  return hits.slice(0, limit);
}
