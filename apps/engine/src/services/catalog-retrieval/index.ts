/**
 * Catalog retrieval — barrel + factory + formattazione per il prompt.
 *
 * Sostituisce l'iniezione del catalogo COMPLETO (100k token, il bug del
 * 2026-06-12) con: mappa categorie (~200 token) + i top-k nodi rilevanti per
 * la richiesta. Provider-agnostico: il blocco finisce nel system prompt PRIMA
 * che si scelga il modello → vale identico per Liara e per i BYOK
 * (ChatGPT/Gemini/Claude in Settings → AI Providers).
 *
 * @module services/catalog-retrieval
 */

import { generateEmbedding } from '@/services/ai-scaffold/template-cache/embedding-client.js';
import { CatalogRetriever, type RetrievedNode } from './retriever.js';
import { SqliteEmbeddingStore } from './embedding-store.js';
import { buildTenantCatalog } from './tenant-catalog.js';

export { CatalogRetriever, type RetrievedNode } from './retriever.js';
export { buildCatalogIndex, type CatalogRecord } from './index-builder.js';
export { inferCategory, CATEGORY_LABELS, type CatalogCategory } from './category.js';
export { buildTenantCatalog, listRunnableCustomEntries } from './tenant-catalog.js';

let cached: { retriever: CatalogRetriever; nodeCount: number; workspaceId: string } | null = null;

/**
 * Retriever del catalogo ESEGUIBILE del tenant — sistema + community + custom
 * privati runnable (buildTenantCatalog). Async perché i custom node vivono nel
 * DB. Lazy + cached per (workspaceId, nodeCount): si ricostruisce se cambia il
 * numero di nodi (install/uninstall community O publish/archive di un custom)
 * → niente catalogo stantio, niente nodo dimenticato.
 */
export async function getCatalogRetriever(workspaceId: string): Promise<CatalogRetriever> {
  const entries = await buildTenantCatalog(workspaceId);
  if (cached?.workspaceId === workspaceId && cached.nodeCount === entries.length) {
    return cached.retriever;
  }
  // Store persistente content-addressed: i vettori sopravvivono al processo,
  // re-embed solo dei nodi col testo cambiato (vedi embedding-store.ts).
  const retriever = new CatalogRetriever(entries, generateEmbedding, new SqliteEmbeddingStore());
  cached = { retriever, nodeCount: entries.length, workspaceId };
  return retriever;
}

/** Reset cache — per i test e per gli hook install/publish nodo. */
export function resetCatalogRetriever(): void {
  cached = null;
}

/**
 * Formatta il blocco catalogo per il system prompt: mappa categorie (così il
 * modello sa COSA esiste) + i nodi rilevanti recuperati (così sa QUALI usare
 * subito). Il modello può chiedere all'utente o, in fase agentica (Fase 2),
 * navigare le altre categorie on-demand.
 */
export function formatCatalogForPrompt(
  retriever: CatalogRetriever,
  retrieved: readonly RetrievedNode[],
): string {
  const categories = retriever
    .categoryMap()
    .map((c) => `  • ${c.category} — ${c.label} (${String(c.count)} nodi)`)
    .join('\n');
  const nodes = retrieved
    .map((n) => `- ${n.defId} (${n.type}, ${n.category}): ${n.shortDesc}`)
    .join('\n');

  // CONTRATTI DI OUTPUT — grounding anti-allucinazione: per i nodi che lo
  // dichiarano, l'AI vede i valori REALI prodotti (incluso il comportamento sugli
  // edge-case, es. partnerId NULL su miss) invece di indovinarli. È la differenza
  // tra "lo so dal contratto" e "lo deduco" (causa delle allucinazioni di dettaglio).
  const withContract = retrieved.filter((n) => n.outputContract);
  const contractBlock =
    withContract.length === 0
      ? ''
      : [
          '',
          "CONTRATTI DI OUTPUT DEI NODI (valori REALI — NON inventare; se un nodo NON è elencato qui, NON dedurre i suoi output: di' all'utente di verificarli):",
          ...withContract.map((n) => {
            const oc = n.outputContract!;
            const lines = oc.fields.map((f) => `    • ${f.name}: ${f.type} — ${f.desc}`);
            const notes = oc.notes ? [`    note: ${oc.notes}`] : [];
            return [`  ${n.defId}:`, ...lines, ...notes].join('\n');
          }),
        ].join('\n');

  return [
    'FAMIGLIE DI NODI DISPONIBILI (il catalogo completo è accessibile — chiedi se ti serve un nodo non elencato sotto):',
    categories,
    '',
    'NODI PIÙ PERTINENTI ALLA RICHIESTA (usa questi defId; non inventarne):',
    nodes ||
      '  (nessun nodo particolarmente pertinente — chiedi un chiarimento o indica una categoria)',
    contractBlock,
  ].join('\n');
}
