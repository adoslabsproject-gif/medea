/**
 * Forma dei dati in ingresso e in uscita da ciascun nodo.
 *
 * Un workflow può avere tutti i nodi giusti e tutti i collegamenti giusti e
 * comunque non funzionare, perché un nodo che emette una LISTA è collegato a
 * uno che si aspetta UN elemento. A runtime o va in errore o — peggio — gira
 * una volta sola sull'intero array e produce risultati senza senso.
 *
 * Le dichiarazioni sono volutamente prudenti: quello che non è classificato
 * resta `unknown` e il gate non dice nulla. Meglio tacere che bocciare un
 * nodo della community che non conosciamo.
 *
 * Port fedele di `node-shape.ts` del server: le liste devono restare
 * allineate, altrimenti lo stesso workflow riceve due giudizi diversi.
 */

export type ShapeKind = 'array' | 'scalar' | 'multi' | 'unknown';

export interface NodeShape {
  output: ShapeKind;
  input: ShapeKind;
}

/** Nodi che emettono una lista di cose, non una cosa sola. */
const ARRAY_PRODUCERS: ReadonlySet<string> = new Set([
  'action_sitemap_crawler',
  'action_recursive_spider',
  'action_distributed_crawler',
  'action_streammy_search_multichannel',
  'action_streammy_catalog',
  'action_email_harvest',
  'db_query',
  'db_subscribe',
  'action_paginate',
  'action_distinct',
  'action_group_by',
  'action_link_audit',
  'action_file_read_lines',
  'action_iptv_m3u',
]);

/** Nodi che lavorano su UN elemento per esecuzione. */
const SCALAR_CONSUMERS: ReadonlySet<string> = new Set([
  'action_seo_audit',
  'action_meta_extract',
  'action_redirect_chain',
  'action_keyword_density',
  'action_http',
  'action_stealth_browser',
  'action_vision_extract',
  'action_dash_probe',
  'action_generic_extractor',
  'agent_extractor',
  'agent_classifier',
  'agent_validator',
  'db_insert',
  'db_update',
  'db_delete',
  'action_file_write',
  'action_pdf_render',
  'action_pec_legal_archive',
  'integration_odoo_lookup_partner',
  'integration_odoo_create_lead',
  'integration_odoo_update_activity',
]);

/** Nodi nati per ricevere più ingressi e produrne uno solo. */
const AGGREGATORS: ReadonlySet<string> = new Set([
  'agent_data_analyst',
  'agent_summarizer',
  'action_aggregate',
  'flow_merge',
  'logic_merge',
  'logic_join',
  'action_iptv_m3u',
  'action_vlc_playlist',
  'action_catalog_page',
]);

/** Nodi che iterano da soli: a valle di una lista non serve un loop esplicito. */
const LOOP_BODY_PASSTHROUGH: ReadonlySet<string> = new Set(['logic_loop']);

export function getNodeShape(defId: string): NodeShape {
  let output: ShapeKind = 'unknown';
  let input: ShapeKind = 'unknown';

  if (ARRAY_PRODUCERS.has(defId)) output = 'array';
  if (AGGREGATORS.has(defId)) {
    input = 'multi';
    output = output === 'array' ? 'array' : 'scalar';
  }
  if (SCALAR_CONSUMERS.has(defId)) input = 'scalar';
  if (LOOP_BODY_PASSTHROUGH.has(defId)) {
    // Il loop legge una lista, ma il suo corpo lavora un elemento per volta.
    input = 'array';
    output = 'array';
  }
  return { input, output };
}

export function isArrayProducer(defId: string): boolean {
  return ARRAY_PRODUCERS.has(defId);
}

export function isScalarConsumer(defId: string): boolean {
  return SCALAR_CONSUMERS.has(defId);
}

export function isAggregator(defId: string): boolean {
  return AGGREGATORS.has(defId);
}

export function isLoopBodyPassthrough(defId: string): boolean {
  return LOOP_BODY_PASSTHROUGH.has(defId);
}
