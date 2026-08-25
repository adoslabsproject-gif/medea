/**
 * Catalogo RETRIEVED per il wizard/scaffold (RAG Fase 2).
 *
 * Lo scaffold genera un workflow COMPLETO config-inclusa: a differenza della
 * chat gli servono i CAMPI dei nodi (required/enum/pattern), non solo nome +
 * descrizione breve. Quindi qui: recupera i nodi rilevanti al goal E ne allega
 * la spec completa (formatScaffoldEntry, la stessa forma del catalogo completo).
 *
 * Design "core + retrieval":
 *   • CORE_DEFIDS sempre presenti (trigger/logic/primitive che servono in quasi
 *     ogni workflow) — garantisce le fondamenta anche se il retrieval del goal
 *     non le pesca. Passati come inUseDefIds → in cima, mai esclusi.
 *   • top-k retrieved per il GOAL (semantico + lessicale) → i nodi del dominio
 *     specifico (email, pdf, slack, db, italia, …).
 *
 * Fail-soft: se il retrieval esplode, il chiamante (singleshot.service) passa
 * undefined a buildSingleshotPrompt → fallback al catalogo COMPLETO. Mai peggio
 * di prima.
 *
 * @module services/catalog-retrieval/scaffold-catalog
 */

import type { NodeCatalogEntry } from '@/services/ai-scaffold/node-catalog.js';
import { formatScaffoldEntry } from '@/services/ai-scaffold/prompt.js';
import { buildTenantCatalog } from './tenant-catalog.js';
import { getCatalogRetriever } from './index.js';

/** Quanti nodi del dominio recuperare per il goal (oltre ai core). */
const SCAFFOLD_RETRIEVE_K = 45;

/**
 * Nodi FONDAMENTALI presenti in quasi ogni workflow — garantiti nel prompt a
 * prescindere dal retrieval del goal. Trigger comuni, controllo di flusso,
 * primitive HTTP/codice/file/db/email/risposta. Un defId qui non nel catalogo
 * del tenant viene semplicemente ignorato (no crash).
 *
 * Quel "no crash" ha nascosto per mesi due voci inesistenti — `logic_filter`
 * (il nodo si chiama `action_filter`) e `agent_chat` (non esiste): venivano
 * filtrate via, e il modello non vedeva mai il nodo per filtrare. Corretto il
 * 2026-08-05; la lista è tenuta identica a quella del desktop
 * (`features/workflows/scaffold/run.ts`), che ha il guard test.
 */
export const SCAFFOLD_CORE_DEFIDS: readonly string[] = [
  'trigger_manual',
  'trigger_webhook',
  'trigger_cron',
  'trigger_imap',
  'trigger_form',
  'logic_if',
  'logic_switch',
  'logic_loop',
  'logic_merge',
  'logic_wait',
  'action_filter',
  'action_http',
  'action_run_js',
  'action_run_python',
  'action_set_fields',
  'action_template',
  'action_json',
  'action_file_write',
  'action_send_email',
  'action_webhook_respond',
  'db_query',
  'db_insert',
  'db_update',
  'agent_extractor',
];

/**
 * Recupera gli ENTRY del subset scaffold (core + top-k retrieved per il goal),
 * deduplicati, mappati ai NodeCatalogEntry COMPLETI (con fields). FONTE UNICA
 * del subset: lo usano sia il prompt (formatScaffoldCatalogEntries) sia la
 * GRAMMATICA vincolata (#1, grammatica sul subset RAG, non sul full-catalog) →
 * prompt e grammatica restano allineati (zero drift). Async (retrieval semantico
 * + custom node del tenant dal DB).
 */
export async function buildScaffoldCatalogEntries(
  workspaceId: string,
  goal: string,
): Promise<NodeCatalogEntry[]> {
  const entries = await buildTenantCatalog(workspaceId);
  const byDefId = new Map<string, NodeCatalogEntry>(entries.map((e) => [e.defId, e]));

  const retriever = await getCatalogRetriever(workspaceId);
  const retrieved = await retriever.retrieve(goal, {
    k: SCAFFOLD_RETRIEVE_K,
    inUseDefIds: SCAFFOLD_CORE_DEFIDS.filter((d) => byDefId.has(d)),
  });

  // retrieve() già mette i core (inUseDefIds) in cima + dedup. Mappiamo ai
  // NodeCatalogEntry COMPLETI (con fields); saltiamo i defId non nel catalogo.
  const out: NodeCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const r of retrieved) {
    if (seen.has(r.defId)) continue;
    const entry = byDefId.get(r.defId);
    if (!entry) continue;
    seen.add(r.defId);
    out.push(entry);
  }
  return out;
}

/** Formatta gli entry del subset nel blocco catalogo per il prompt scaffold. */
export function formatScaffoldCatalogEntries(entries: NodeCatalogEntry[]): string {
  return entries.map(formatScaffoldEntry).join('\n');
}

/**
 * Blocco catalogo (testo) per lo scaffold: core + top-k retrieved, con i campi
 * config. Wrapper su buildScaffoldCatalogEntries (mantiene la firma storica).
 */
export async function buildScaffoldCatalogText(workspaceId: string, goal: string): Promise<string> {
  return formatScaffoldCatalogEntries(await buildScaffoldCatalogEntries(workspaceId, goal));
}
