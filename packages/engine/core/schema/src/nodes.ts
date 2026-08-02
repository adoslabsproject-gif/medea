import { z } from 'zod';

export const NodeCategorySchema = z.enum(['trigger', 'action', 'ai', 'logic']);
export type NodeCategory = z.infer<typeof NodeCategorySchema>;

export const ConfigFieldTypeSchema = z.enum([
  'text',
  'textarea',
  'select',
  'number',
  'boolean',
  'secret',
  'json',
  'code',
  'expression',
  // Dynamic pickers — the renderer fetches options from the runtime API
  'db-picker',         // dropdown of tenant's databases (DB Studio)
  'db-table-picker',   // dropdown of tables in the selected database (uses `dependsOn` field)
  'db-collection-picker', // dropdown of vector collections in the selected database
  'workflow-picker',   // dropdown of tenant's workflows (excluding current)
  'form-fields',       // visual drag&drop form builder — value is JSON array of {key,label,type,required,options?,placeholder?}
  'key-value',         // {string: string} editor — used for headers, where clauses, patch sets
  'chip-list',         // string[] editor — comma-paste or one-at-a-time chips
  'filter-rows',       // array of {column, op, value} — DB query filters
  'sort-rows',         // array of {column, direction} — DB query ORDER BY
  'invoice-lines',     // array of {name, quantity, net_price, vat?} — invoice line items
  'email-account-picker', // dropdown of system_email_accounts (label + from)
  'attachments',       // array of {name, base64|path|url, contentType} — file upload + base64 in browser
  'rich-text',         // WYSIWYG HTML editor (TipTap) — emits HTML by default
  'file-picker',       // browse tenant sandbox + pick a file path (writes the path string)
  'directory-picker',  // browse tenant sandbox + pick a directory path
  'cron-builder',      // visual cron editor (every minute/hour/day...) with human-readable preview
  'switch-cases',      // builder of {match: value, branch: name} rows for logic_switch
  'timezone-picker',   // curated IANA timezone select with search
  'condition-rules',   // visual multi-rule builder for IF/Switch v2 — JSON value of shape { combinator, rules: [...] }
]);
export type ConfigFieldType = z.infer<typeof ConfigFieldTypeSchema>;

export const ShowIfRuleSchema = z.object({
  field: z.string().min(1),
  equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
  in: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  truthy: z.boolean().optional(),
});
export type ShowIfRule = z.infer<typeof ShowIfRuleSchema>;

export const ConfigFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  placeholder: z.string().optional(),
  required: z.boolean().optional(),
  type: ConfigFieldTypeSchema.optional(),
  options: z.array(z.string()).optional(),
  help: z.string().optional(),
  defaultValue: z.string().optional(),
  showIf: ShowIfRuleSchema.optional(),
  language: z.enum(['javascript', 'typescript', 'json', 'yaml', 'sql', 'jsonata']).optional(),
  /** For dependent dynamic pickers — names the field whose value scopes the options. */
  dependsOn: z.string().optional(),
  /**
   * Inline-validation regex applied as the user types. Non-matching, non-empty
   * values render an inline warning under the input. Empty values are ignored
   * (use `required` for emptiness checks). Currently honored by the `secret`
   * renderer (e.g. Telegram bot token format `^\d+:[\w-]+$`).
   */
  pattern: z.string().optional(),
  /** Human-readable message shown when `pattern` fails. Defaults to "Formato non valido". */
  patternMessage: z.string().optional(),
  /**
   * Client Portal whitelist (Sprint 3). Quando `true`, questo campo viene
   * esposto al cliente nel portale (white-label) e puo\` essere modificato
   * SENZA accesso all'editor. Validation server-side stretta:
   *  - Cliente puo\` SOLO impostare un valore (no expression injection)
   *  - I valori modificati passano per validateAndUpdateConfig() che riapplica
   *    pattern + required + type checking
   *  - Audit log ogni modifica con portalTokenId + workflowId + nodeId + fieldKey
   * Default false: niente esposizione al cliente senza opt-in esplicito.
   */
  exposeToClient: z.boolean().optional(),
  /**
   * Label alternativa mostrata al cliente nel portale (se exposeToClient=true).
   * Util quando la label tecnica ("smtp_password") non e\` user-friendly per
   * un cliente non-tecnico ("Password della tua email").
   */
  clientLabel: z.string().optional(),
  /**
   * Hint mostrato al cliente sotto il campo (separato da `help` che e\` per
   * lo sviluppatore nell'editor). Permette messaggi business-friendly.
   */
  clientHint: z.string().optional(),
});
export type ConfigField = z.infer<typeof ConfigFieldSchema>;

/**
 * Bulk capability metadata — when set, the iteration engine knows the node
 * has a true bulk endpoint and can route the entire array through a single
 * call instead of N individual calls. Used by Loop strategy='auto' and the
 * cost estimator UI.
 */
export const BulkCapabilitySchema = z.object({
  supports: z.literal(true),
  /** Maximum items per single bulk call (e.g. Stripe = 100, SendGrid = 1000). */
  maxBatchSize: z.number().int().positive(),
  /** Optional human-readable endpoint name ("POST /v1/charges/bulk"). */
  endpoint: z.string().optional(),
  /** Cost per item in USD — feeds the estimator. */
  costPerItem: z.number().nonnegative().optional(),
  rateLimit: z
    .object({
      reqPerMin: z.number().int().positive().optional(),
      reqPerSec: z.number().int().positive().optional(),
    })
    .optional(),
});
export type BulkCapability = z.infer<typeof BulkCapabilitySchema>;

/**
 * Per-call cost & rate-limit hints. Used by the estimator to warn the
 * operator BEFORE a run starts ("50k iterations × $0.002 = $100").
 */
export const PerCallCostSchema = z.object({
  costPerCall: z.number().nonnegative().optional(),
  typicalLatencyMs: z.number().int().positive().optional(),
  rateLimit: z
    .object({
      reqPerMin: z.number().int().positive().optional(),
      reqPerSec: z.number().int().positive().optional(),
    })
    .optional(),
});
export type PerCallCost = z.infer<typeof PerCallCostSchema>;

/**
 * NodeAction — a sub-action of a node. PDF4Me-style pattern: one node
 * declares N actions (e.g. "Extract Text", "OCR Scan", "Merge PDFs"),
 * the user picks one in the drawer, and only THAT action's configFields
 * render. The executor receives `__action: <actionId>` in config and
 * dispatches accordingly.
 *
 * `aiAction: true` flags actions that wrap an LLM call (vision OCR,
 * document classification, etc.) so the marketplace can highlight them
 * with the ✨ AI badge.
 *
 * Use cases:
 *   • Third-party community nodes that pack many vendor endpoints in one
 *     palette entry (PDF4Me has 94 actions).
 *   • First-party "service" nodes that group related operations (e.g.
 *     google_drive: list/upload/download/share — currently we have one
 *     node per operation; with actions it would be a single drawer with
 *     an Action dropdown).
 *
 * When `actions` is set, the top-level `configFields` act as SHARED
 * fields (rendered for every action — useful for API key / endpoint).
 * The action's own `configFields` render BELOW shared, only for that action.
 */
export const NodeActionSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9_-]+$/i),
  label: z.string().min(1),
  description: z.string().optional(),
  /** Renders ✨ badge in the action picker — purely cosmetic but signals "this is AI-powered". */
  aiAction: z.boolean().optional(),
  configFields: z.array(ConfigFieldSchema).optional(),
  /** Category groups actions in the picker dropdown (e.g. "Document", "Image", "AI"). */
  category: z.string().optional(),
  /**
   * Resource/Operation pattern (n8n): la RISORSA su cui opera l'azione (es.
   * "Contatto", "Fattura", "Foglio"). Quando le actions di un nodo dichiarano
   * `resource`, l'editor mostra un picker a due livelli: prima la Risorsa, poi
   * l'Operazione (questa action) filtrata per quella risorsa. Optional →
   * retro-compatibile: senza `resource` il picker resta una lista piatta.
   */
  resource: z.string().optional(),
  /**
   * Granularità per-operation del continue-on-fail (n8n: continueOnFail solo
   * per certe operations). Una operation intrinsecamente tollerante all'errore
   * (es. "Append" idempotente, "Notify" best-effort) può dichiarare `true`:
   * l'istanza che la seleziona EREDITA questo default come comportamento di
   * fallimento, salvo override esplicito via `CanvasNode.continueOnFail`.
   * Una operation critica (es. "Delete", "Charge") lascia `false`/undefined.
   */
  continueOnFailDefault: z.boolean().optional(),
});
export type NodeAction = z.infer<typeof NodeActionSchema>;

/**
 * Resource/Operation pattern (n8n) — la RISORSA come entità di primo livello.
 * Una NodeAction (operation) referenzia una resource via `NodeAction.resource`.
 * La risorsa porta label/icona/descrizione per la UI + `configFields` CONDIVISI
 * da tutte le sue operations (es. il "Base ID" comune a tutte le operazioni su
 * un Airtable Base). L'editor mostra: Risorsa → campi-risorsa → Operazione →
 * campi-operazione. La risorsa selezionata è esposta in config `__resource`,
 * così i `showIf` dei campi possono dipendere da essa.
 */
export const NodeResourceSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9_-]+$/i),
  label: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  /** Campi condivisi da TUTTE le operations di questa risorsa. */
  configFields: z.array(ConfigFieldSchema).optional(),
});
export type NodeResource = z.infer<typeof NodeResourceSchema>;

/**
 * Community-node TRIGGER declaration (FEAT community-trigger runtime, 2026-06-09).
 *
 * Un community node può dichiarare uno o più trigger oltre alle action. Solo i
 * trigger `mode='polling'` sono eseguibili dal runtime (l'engine chiama il poll
 * del vendor nel sandbox isolated-vm ogni `pollIntervalSec` e avvia un run per
 * ogni evento emesso). I trigger `mode='stream'` sono dichiarabili ma il sandbox
 * non può tenere connessioni persistenti → il compiler dell'SDK li rifiuta
 * esplicitamente (vedi @medea/engine-community-node-sdk). Per lo streaming reale si
 * usano i trigger built-in (trigger_websocket).
 *
 * Campo additivo+opzionale → zero impatto sui NodeDef esistenti.
 */
export const NodeTriggerSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9_-]+$/i, 'Trigger ID must be alphanumeric with - or _'),
  label: z.string().min(1),
  description: z.string().optional(),
  mode: z.enum(['polling', 'stream']),
  /** Solo mode='polling': intervallo tra i poll. Clampato dal runtime [10, 3600]. */
  pollIntervalSec: z.number().int().positive().optional(),
  configFields: z.array(ConfigFieldSchema).optional(),
});
export type NodeTrigger = z.infer<typeof NodeTriggerSchema>;

/**
 * Un campo dell'output di un nodo: nome, tipo (in notazione TS-like, può
 * includere `| null`), e descrizione del comportamento — SOPRATTUTTO sugli
 * edge-case (è lì che l'AaI allucina). Es. odoo_lookup_partner.partnerId:
 * type 'number | null', desc 'id del partner; null se non trovato e !createIfMissing'.
 */
export const OutputFieldSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  desc: z.string().min(1),
});
export type OutputField = z.infer<typeof OutputFieldSchema>;

export const OutputContractSchema = z.object({
  fields: z.array(OutputFieldSchema).min(1),
  /** Note cross-campo / edge-case combinati (es. "miss+!create → tutti null"). */
  notes: z.string().optional(),
});
export type OutputContract = z.infer<typeof OutputContractSchema>;

export const NodeDefSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9_-]+$/i, 'Node ID must be alphanumeric with - or _'),
  type: NodeCategorySchema,
  label: z.string().min(1),
  icon: z.string(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Color must be a hex code like #4a90e2'),
  description: z.string(),
  configFields: z.array(ConfigFieldSchema).optional(),
  /**
   * Risorse del pattern Resource/Operation. Quando presenti, l'editor mostra un
   * picker a due livelli con LABEL/icona/descrizione (non l'id raw) e i campi
   * condivisi della risorsa. Le `actions` referenziano una resource via il loro
   * campo `resource`. Optional → nodi senza resources = lista operations piatta.
   */
  resources: z.array(NodeResourceSchema).optional(),
  /**
   * Optional multi-action declaration (PDF4Me / Telegram style).
   * When present, the drawer renders an action picker before configFields.
   */
  actions: z.array(NodeActionSchema).optional(),
  /**
   * Output port names. Two interpretations:
   *
   *   1. When `branching === true` (logic_if, logic_switch, logic_loop),
   *      each entry is a DISTINCT downstream port. The engine routes the
   *      execution to the edge with matching `fromPort`. The canvas renders
   *      one handle per entry, color-coded (green=true, rose=false, …).
   *
   *   2. When `branching` is absent/false, each entry is just a SCHEMA HINT
   *      describing the fields the node's output object will contain (e.g.
   *      pdf_extract → text/confidence/mode/pages…). All downstream nodes
   *      receive the FULL output object on a single port. The canvas shows
   *      one combined handle — the field list is for documentation only.
   */
  outputs: z.array(z.string()).optional(),
  /**
   * OUTPUT CONTRACT — descrizione STRUTTURATA di ciò che il nodo produce, per
   * far ANALIZZARE i workflow all'AI (Liara) SENZA allucinare i dettagli.
   *
   * Motivazione (2026-06-23): analizzando un workflow Liara riceve solo la prima
   * frase della description (≤140 char) → sui valori di output INDOVINA (es.
   * "partnerId=0" invece del vero `null` di odoo_lookup_partner su miss). Qui il
   * comportamento REALE — inclusi gli edge-case — è esplicito e iniettato nel
   * contesto di analisi.
   *
   * ⚠️ NON-ASPIRAZIONALE: deve riflettere l'executor REALE. Per i nodi che lo
   * dichiarano, un test anti-drift verifica che i campi corrispondano all'output
   * effettivo dell'executor (vedi es. odoo_lookup_partner/index.test.ts).
   */
  outputContract: OutputContractSchema.optional(),
  /**
   * True for nodes that route to ONE of N downstream branches based on
   * runtime result (if/switch/error-handler). See `outputs` semantics above.
   */
  branching: z.boolean().optional(),
  vendor: z.string().optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  deprecated: z.boolean().optional(),
  /** Bulk endpoint metadata — Loop strategy='auto' picks 'bulk' when present. */
  bulk: BulkCapabilitySchema.optional(),
  /** Per-call cost & latency hints — feeds the cost estimator. */
  cost: PerCallCostSchema.optional(),
  /**
   * Il nodo gestisce INTERNAMENTE il proprio retry (es. action_http: retryOnStatus +
   * Retry-After awareness). Quando true, l'engine NON applica il proprio retry loop su
   * questo nodo (eviterebbe il doppione annidato engine×nodo) — a meno che la config del
   * nodo non forzi `retryStrategy='workflow'`. Default (assente) = false → l'engine
   * gestisce il retry via `retryCount`. Vedi engine/strategies/retry-policy.
   */
  selfManagedRetry: z.boolean().optional(),
  /**
   * Trigger custom dichiarati da un community node (polling/stream). Solo i
   * polling sono eseguibili dal runtime trigger-watchers. Vedi NodeTriggerSchema.
   */
  triggers: z.array(NodeTriggerSchema).optional(),
  /**
   * Alias di ricerca/discoverability (n8n-speak, EN↔IT) — i termini con cui
   * gli utenti chiedono questo nodo ma che NON compaiono in id/label/prima
   * frase della description. Es. action_run_js → ['code','function','script']:
   * "creami un nodo code" deve trovarlo (BUG reale 2026-06-12). Entrano
   * nell'indice del catalog-retrieval (keywords lessicali + searchText
   * embeddato). Dichiarali qui, NON in mappe esterne: così ogni autore di
   * nodo (community inclusi) li mantiene accanto al def e il test anti-drift
   * li copre. Minuscoli, 1 parola ciascuno, niente speculazioni.
   */
  searchAliases: z.array(z.string().min(2)).optional(),
});
export type NodeDef = z.infer<typeof NodeDefSchema>;

export const NodeRegistrySchema = z.array(NodeDefSchema);
export type NodeRegistry = z.infer<typeof NodeRegistrySchema>;
