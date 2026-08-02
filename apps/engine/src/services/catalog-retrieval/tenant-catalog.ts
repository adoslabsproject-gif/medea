/**
 * Catalogo ESEGUIBILE del tenant = nodi di sistema + community installati +
 * custom node PRIVATI del tenant (creati nell'editor, status runnable).
 *
 * Il gap chiuso qui (owner 2026-06-12): buildNodeCatalog includeva sistema +
 * community ma NON i custom node privati (tabella custom_nodes) → Liara non li
 * conosceva nella chat. Ora i custom runnable entrano nel catalogo e — grazie
 * alla RAG auto-derivata — il retriever li embedda e li recupera DA SOLO. Crei
 * "Calcola sconto fedeltà", lo pubblichi nel workspace, e Liara lo trova.
 *
 * "Runnable" = gli stessi status che l'engine accetta a dispatch
 * (custom-nodes/runtime-loader RUNNABLE_STATUSES): published_priv e
 * marketplace_published. I draft/candidate NON sono eseguibili → restano fuori
 * (Liara non deve proporre un nodo che fallirebbe l'esecuzione).
 *
 * @module services/catalog-retrieval/tenant-catalog
 */

import type { NodeCatalogEntry } from '@/services/ai-scaffold/node-catalog.js';
import { buildNodeCatalog } from '@/services/ai-scaffold/node-catalog.js';
import { listCustomNodes, customNodeDefId } from '@/services/custom-nodes/index.js';
import { logger } from '@/lib/logger.js';

/** Status di un custom node ESEGUIBILE dall'engine — allineato a runtime-loader. */
const RUNNABLE_CUSTOM_STATUSES = new Set(['published_priv', 'marketplace_published']);

/**
 * I custom node RUNNABLE del tenant come NodeCatalogEntry. Per il retrieval
 * bastano defId + label + description + categoria: i configFields completi si
 * recuperano on-demand al momento dell'uso. Fail-soft: se la query DB esplode,
 * ritorna [] (il catalogo base resta valido) — mai un crash della chat.
 */
export async function listRunnableCustomEntries(workspaceId: string): Promise<NodeCatalogEntry[]> {
  try {
    const { items } = await listCustomNodes({ workspaceId, filter: { limit: 200 } });
    return items
      .filter((n) => RUNNABLE_CUSTOM_STATUSES.has(n.status))
      .map(
        (n): NodeCatalogEntry => ({
          defId: customNodeDefId(n.slug),
          type: 'action', // i custom node sono action nel workflow
          label: n.displayName,
          description: n.description ?? n.displayName,
          fields: [],
        }),
      );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), workspaceId },
      '[tenant-catalog] custom nodes non caricati — solo catalogo base',
    );
    return [];
  }
}

/**
 * Catalogo eseguibile COMPLETO del tenant: base (sistema + community) + custom
 * privati runnable. È la fonte di verità del retriever per la chat.
 */
export async function buildTenantCatalog(workspaceId: string): Promise<NodeCatalogEntry[]> {
  const base = buildNodeCatalog();
  const custom = await listRunnableCustomEntries(workspaceId);
  if (custom.length === 0) return base;
  // De-dup difensivo (un custom non dovrebbe collidere col namespace base).
  const byDefId = new Map<string, NodeCatalogEntry>();
  for (const e of base) byDefId.set(e.defId, e);
  for (const e of custom) byDefId.set(e.defId, e);
  return Array.from(byDefId.values());
}
