/**
 * Node I/O shape catalog — quality-gate semantic foundation.
 *
 * Why
 * ───
 * Workflow validity is more than "all defIds exist + edges connect". A node
 * that emits an ARRAY (`sitemap_crawler → { urls: [...] }`) wired into a
 * node that consumes a SCALAR (`seo_audit` expects ONE url) silently
 * succeeds at structure level but fails at runtime — or worse, executes
 * once on the entire array and produces nonsense.
 *
 * This module declares, for every known defId, the SHAPE its `default`
 * output emits and the SHAPE its `default` input expects. The quality gate
 * uses these declarations to reject impossible wirings BEFORE the user is
 * told "looks good!" — and the auto-fix layer can suggest the missing
 * `logic_loop` / `flow_merge` automatically.
 *
 * Declarations are intentionally conservative:
 *   - 'array'   → the node emits / consumes a JSON array of items.
 *   - 'scalar'  → exactly one item per execution.
 *   - 'multi'   → the node is an AGGREGATOR designed to merge N inputs.
 *   - 'unknown' → no declaration yet → quality gate SKIPS this edge (no
 *                 false-positive on novel community nodes).
 *
 * Adding a new node? Drop it in `ARRAY_PRODUCERS` / `SCALAR_CONSUMERS` /
 * `AGGREGATORS` / `LOOP_BODY_PASSTHROUGH`. Tests live in
 * `node-shape.test.ts` — keep them updated.
 *
 * @module services/ai-scaffold/node-shape
 */

export type ShapeKind = 'array' | 'scalar' | 'multi' | 'unknown';

export interface NodeShape {
  /** Shape the node's default output emits (downstream readers see this). */
  output: ShapeKind;
  /** Shape the node's default input expects (upstream writer must feed this). */
  input: ShapeKind;
}

/**
 * Nodes that emit `{ items: [...] }` / `{ rows: [...] }` / `{ urls: [...] }`
 * — anything that's an array-of-things, NOT a single item.
 */
const ARRAY_PRODUCERS: ReadonlySet<string> = new Set([
  // web extraction
  'action_sitemap_crawler',
  'action_recursive_spider',
  'action_distributed_crawler',
  // search / multi-channel
  'action_streammy_search_multichannel',
  'action_streammy_catalog',
  'action_email_harvest',
  // database
  'db_query',
  'db_subscribe',
  // generic
  'action_paginate',
  'action_distinct',
  'action_group_by',
  // SEO suite (link audit & redirect chain emit an array)
  'action_link_audit',
  // CSV / file batch
  'action_file_read_lines',
  // streammy IPTV
  'action_iptv_m3u',
]);

/**
 * Nodes whose default input expects a SINGLE item — feeding them an array
 * either crashes or applies once-to-the-whole-array semantics that the user
 * never wanted.
 */
const SCALAR_CONSUMERS: ReadonlySet<string> = new Set([
  // SEO single-page
  'action_seo_audit',
  'action_meta_extract',
  'action_redirect_chain',
  'action_keyword_density',
  // web extraction single-url
  'action_http',
  'action_stealth_browser',
  'action_vision_extract',
  'action_dash_probe',
  'action_generic_extractor',
  // single agents (extractor/classifier emit on ONE input)
  'agent_extractor',
  'agent_classifier',
  'agent_validator',
  // single-record DB writes
  'db_insert',
  'db_update',
  'db_delete',
  // file write single
  'action_file_write',
  // pdf single
  'action_pdf_render',
  'action_pec_legal_archive',
  // Odoo single
  'integration_odoo_lookup_partner',
  'integration_odoo_create_lead',
  'integration_odoo_update_activity',
]);

/**
 * Aggregator nodes — designed to receive MULTIPLE inputs (fan-in) and
 * produce ONE merged output. They never need an upstream `flow_merge`.
 */
const AGGREGATORS: ReadonlySet<string> = new Set([
  'agent_data_analyst',
  'agent_summarizer',
  'action_aggregate',
  'flow_merge',      // alias vocabolario scaffold (→ logic_merge a runtime)
  'logic_merge',     // defId merge REALE (executor registrato)
  'logic_join',
  'action_iptv_m3u',           // packager of many streams into one m3u
  'action_vlc_playlist',
  'action_catalog_page',
]);

/**
 * Nodes that, when downstream of an array producer, transparently iterate
 * (each iteration is a scalar). They DO NOT need an explicit `logic_loop`
 * wrapper — quality gate must treat the path through them as "loop-equivalent".
 */
const LOOP_BODY_PASSTHROUGH: ReadonlySet<string> = new Set([
  'logic_loop',
  // future: logic_map, logic_filter — they all preserve array semantics
]);

/**
 * Returns the I/O shape for a defId. Unknown nodes get
 * `{ input: 'unknown', output: 'unknown' }` so the quality gate doesn't
 * false-positive on community nodes we haven't classified yet.
 */
export function getNodeShape(defId: string): NodeShape {
  let output: ShapeKind = 'unknown';
  let input: ShapeKind = 'unknown';

  if (ARRAY_PRODUCERS.has(defId)) output = 'array';
  if (AGGREGATORS.has(defId)) {
    input = 'multi';
    // Aggregators emit a single merged value by default.
    output = output === 'array' ? 'array' : 'scalar';
  }
  if (SCALAR_CONSUMERS.has(defId)) input = 'scalar';
  if (LOOP_BODY_PASSTHROUGH.has(defId)) {
    // A loop reads an array but its INNER body iterates over scalars —
    // the loop node itself "consumes" the array.
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
