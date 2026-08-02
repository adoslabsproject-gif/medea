/**
 * Categoria TOPICA di un nodo (email, http, database, italia, …) — derivata
 * dall'id + type del NodeDef.
 *
 * L'euristica nasce come replica di quella del portal web di provenienza. In
 * Medea il portal non esiste: qui questa è la fonte unica, e il catalogo che
 * legge il modello si costruisce da qui.
 *
 * ⚠️ Coerenza garantita da `category-parity.test.ts`: gli override espliciti
 * devono essere davvero applicati da `inferCategory` e usare solo categorie
 * dichiarate in `CATEGORY_LABELS`.
 *
 * @module services/catalog-retrieval/category
 */

/** Override espliciti dove l'euristica per-substring sbaglierebbe. */
export const EXPLICIT_CATEGORY: Readonly<Record<string, string>> = {
  // transform — manipolazione dati
  action_array: 'transform',
  action_json: 'transform',
  action_text: 'transform',
  action_template: 'transform',
  action_datetime: 'transform',
  action_number: 'transform',
  action_aggregate: 'transform',
  action_set_fields: 'transform',
  action_coalesce: 'transform',
  action_filter: 'transform',
  action_diff: 'transform',
  action_mock_data: 'transform',
  action_markdown: 'transform',
  action_generate_chart: 'transform',
  // files — formati documento
  action_csv: 'files',
  // http / web
  action_html_extract: 'http',
  action_url: 'http',
  action_api_response: 'http',
  // italia — validazioni con checksum nazionali
  action_validate: 'italia',
  // utility — crypto/id (security primitives)
  action_crypto: 'utility',
  action_uuid: 'utility',
  action_jwt: 'utility',
  // integrations — bridge cross-tenant FlowForge↔FlowForge
  action_tenant_collab: 'integrations',
};

export type CatalogCategory =
  | 'triggers'
  | 'logic'
  | 'transform'
  | 'email'
  | 'files'
  | 'http'
  | 'database'
  | 'ai'
  | 'italia'
  | 'integrations'
  | 'utility';

/** Etichette human-readable per la mappa categorie mostrata al modello. */
export const CATEGORY_LABELS: Readonly<Record<CatalogCategory, string>> = {
  triggers: 'Trigger (avvio del workflow: webhook, cron, email, form…)',
  logic: 'Logica (if/switch/loop/merge/wait/subworkflow)',
  transform: 'Trasformazione dati (array, json, testo, date, aggregazioni, filtri)',
  email: 'Email (invio/ricezione SMTP/IMAP, personalizzazione, MX)',
  files: 'File e documenti (PDF, Excel, CSV, lettura/scrittura)',
  http: 'HTTP e web (fetch, webhook response, scraping, API)',
  database: 'Database del tenant (query, insert, update, RAG vettoriale)',
  ai: 'AI e agenti (LLM, classificazione, estrazione, summary, analisi)',
  italia: 'Italia (PEC, SDI/FatturaPA, validazioni CF/P.IVA/IBAN)',
  integrations: 'Integrazioni esterne (Slack, GitHub, Notion, Shopify, …)',
  utility: 'Utility (crypto, uuid, jwt, primitive varie)',
};

/** Categoria di un nodo a partire dal suo id e dal suo tipo. */
export function inferCategory(id: string, type: string): CatalogCategory {
  const explicit = EXPLICIT_CATEGORY[id];
  if (explicit) return explicit as CatalogCategory;
  if (id.startsWith('integration_')) return 'integrations';
  if (id.startsWith('italia_')) return 'italia';
  if (type === 'trigger') return 'triggers';
  if (type === 'logic') return 'logic';
  if (id.includes('email') || id.includes('mail')) return 'email';
  if (id.includes('pdf') || id.includes('xlsx') || id.includes('file')) return 'files';
  if (
    id.includes('http') ||
    id.includes('webhook') ||
    id.includes('fetch_url') ||
    id.includes('web_search')
  )
    return 'http';
  if (id.includes('db_')) return 'database';
  if (id.includes('ai_') || id.includes('liara')) return 'ai';
  // Community/custom node prefissati restano in integrations per default utile.
  if (id.startsWith('community_') || id.startsWith('custom_')) return 'integrations';
  return 'utility';
}
