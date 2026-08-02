import { z } from 'zod';
import { NodeDefSchema } from './nodes.js';

/**
 * Workflow node display name — Unicode-aware (ES2018+) UX-friendly.
 *
 * I 2 regex sono costruiti via new RegExp(string) per evitare caratteri
 * invisibili nel source (zero-width, RTL marks, line separators). Ogni
 * char è espresso come escape \\uNNNN — grep-friendly + code-review-friendly.
 *
 * Permette:
 *   - lettere Unicode (\p{L}: latino accentato, cirillico, greco, CJK, arabo)
 *   - numeri Unicode (\p{N})
 *   - spazi singoli (separatori parole)
 *   - punteggiatura sicura: _ - . ' ( ) [ ]
 *
 * Blacklist (priorità su whitelist):
 *   - U+0000-U+001F : C0 controls (NULL, BEL, ESC, TAB, ...)
 *   - U+007F : DEL
 *   - U+200B / U+200E-U+200F : zero-width spaces + LTR/RTL marks (anti-homoglyph)
 *   - U+2028 / U+2029 : LINE/PARAGRAPH SEPARATOR (JSON/JS injection vector)
 *   - <>{}|`\\ etc. : XSS / template injection / shell metacharacters
 *
 * Max length 120 char (era 64): copre frasi articolate italiane come
 * "Estrai contatto da pagina cantiere navale". Espressioni `$node.<name>`
 * continuano a funzionare con qualsiasi name perché l'interprete fa lookup
 * anche per ID, quindi non c'è regressione di compatibilità.
 *
 * Pre-validation hint: usa sanitizeNodeName(input) per convertire input
 * arbitrari (es. da AI scaffold, n8n import) in stringhe garantite-parse.
 */
const BLACKLIST_CHARS =
  '<>{}|`\\\\' +
  '\\u0000-\\u001F' +
  '\\u007F' +
  '\\u200B-\\u200F' +
  '\\u202A-\\u202E' +              // RLO/LRO/PDF/LRE/RLE (anti-homoglyph)
  '\\u2028-\\u2029';

const NODE_NAME_REGEX = new RegExp(
  '^[\\p{L}\\p{N}_][\\p{L}\\p{N}\\s\\-_.\'()\\[\\]]{0,119}$',
  'u',
);
const NODE_NAME_BLACKLIST = new RegExp('[' + BLACKLIST_CHARS + ']', 'u');
const NODE_NAME_BLACKLIST_GLOBAL = new RegExp('[' + BLACKLIST_CHARS + ']', 'gu');

export const NodeNameSchema = z.string()
  .min(1)
  .max(120)
  .refine((s) => !NODE_NAME_BLACKLIST.test(s), {
    message: 'Caratteri di controllo, zero-width o injection-prone non permessi',
  })
  .refine((s) => !/\s{2,}/.test(s), { message: 'Spazi consecutivi non permessi' })
  .refine((s) => NODE_NAME_REGEX.test(s), {
    message: 'Solo lettere/numeri/spazi e punteggiatura sicura (_ - . \' ( ) [ ])',
  });

/**
 * Sanitizza un nome utente arbitrario per renderlo NodeNameSchema-compliant.
 *
 * Use case: import da AI scaffold, seed scripts SQL diretti, migrazioni da
 * altri workflow engines (n8n / Zapier export). Garantisce che il successivo
 * NodeNameSchema.parse() abbia successo.
 *
 * Strategia:
 *   1. Type-guard (non-string → 'node' fallback)
 *   2. Strip caratteri blacklist (control + zero-width + injection)
 *   3. Collassa whitespace multiplo + trim
 *   4. Garantisce inizio con [\p{L}\p{N}_] (prepende 'n_' se necessario)
 *   5. Tronca a 120 char
 *
 * NON normalizza accenti (preserva "È", "à", "ñ", "中") — il regex li accetta.
 */
// Whitelist `not-allowed` set (negato del NODE_NAME_REGEX body):
// rimuove qualsiasi char fuori da [letters, numbers, whitespace, _-.'()[]]
const NODE_NAME_NOT_ALLOWED_GLOBAL = new RegExp(
  '[^\\p{L}\\p{N}\\s\\-_.\'()\\[\\]]',
  'gu',
);

export function sanitizeNodeName(input: unknown): string {
  if (typeof input !== 'string') return 'node';
  // 1) Strip caratteri blacklist sicurezza (zero-width, RTL, control, etc.)
  // 2) Strip caratteri non-whitelist (es. `/` `?` `<` `>` `&`)
  // 3) Collassa whitespace
  let s = input
    .replace(NODE_NAME_BLACKLIST_GLOBAL, '')
    .replace(NODE_NAME_NOT_ALLOWED_GLOBAL, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (!s) return 'node';
  // Edge case: inizio con carattere non permesso (es. ".name" o "-foo")
  if (!/^[\p{L}\p{N}_]/u.test(s)) {
    s = 'n_' + s.replace(/^[^\p{L}\p{N}_]+/u, '');
  }
  return s.slice(0, 120) || 'node';
}

export const CanvasNodeSchema = z.object({
  id: z.string().min(1),
  defId: z.string().min(1),
  x: z.number().finite(),
  y: z.number().finite(),
  // I valori del config sono normalizzati a STRING (contratto storico: l'engine fa
  // Number(...)/parse a runtime). Accettiamo però anche number/boolean in INPUT e li
  // coerciamo a string → un client che invia retryCount:3 o retryDelayMs:1000 come number
  // (es. retry-policy trasversale) non causa più ZodError 500 al PUT. Object/array restano
  // rifiutati (non ammessi dal contratto). Coercion idempotente: '3'→'3', 3→'3'.
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]).transform((v) => String(v))),
  /**
   * Optional user-facing alias for this node. When set, expressions can
   * reference the node as `$node.<name>.json` instead of the cryptic
   * auto-generated id. The interpreter accepts BOTH — name takes precedence
   * so renaming doesn't break anything.
   *
   * Vincoli: Unicode-aware (vedi NodeNameSchema sopra) — permette italiano
   * accentato, parentesi, apostrofo, spazi singoli. Max 120 char.
   */
  name: NodeNameSchema.optional(),
  notes: z.string().optional(),
  /**
   * n8n-style "Continue (using error output)" per-nodo. Quando `true` e il
   * nodo fallisce, l'engine NON ferma il ramo: produce un error-item
   * `{ error: { message, nodeId, defId } }` come output del nodo e i nodi
   * downstream collegati alle porte NORMALI proseguono con quell'input.
   *
   * Default (undefined/false) = semantica "Stop and Error": il ramo segue
   * solo gli edge `fromPort === 'error'`, altrimenti muore qui.
   *
   * Backward-compat: optional → i workflow esistenti mantengono il vecchio
   * comportamento finché l'owner non attiva esplicitamente il flag.
   */
  continueOnFail: z.boolean().optional(),
  /**
   * Granularità per CATEGORIA d'errore (supera il "continue su tutto/niente").
   * Quando valorizzato E `continueOnFail` è attivo, il nodo prosegue SOLO se
   * l'errore appartiene a una di queste categorie (mappate da NodeError.code via
   * `categoryOf`); per le altre categorie il fallimento resta FATALE.
   *
   * Es. `['network','rate_limit']` → "continua sui problemi transitori di rete,
   * ma fermati su validation/auth/business". Vuoto/assente con continueOnFail
   * attivo = continua su QUALSIASI errore (comportamento booleano storico).
   *
   * I valori sono le NodeErrorCategory di @medea/engine-nodes-stdlib (duplicate qui
   * per non invertire la dipendenza core-schema → stdlib).
   */
  continueOnFailOn: z.array(z.enum(['validation', 'auth', 'network', 'rate_limit', 'business', 'aborted', 'internal'])).optional(),
  /**
   * Versioned Node API (n8n `typeVersion`): semver del NodeDef PINNATA quando
   * il nodo fu creato/configurato. L'editor la imposta da `def.version` al drop;
   * l'engine la confronta con la versione corrente del def per rilevare un drift
   * (vedi `classifyNodeVersionCompat`). Optional → workflow legacy = 'unversioned',
   * nessun enforcement, backward-compat totale.
   */
  defVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
});
export type CanvasNode = z.infer<typeof CanvasNodeSchema>;

export const EdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  fromPort: z.string().optional(),
  label: z.string().optional(),
  /**
   * UI-only: ID dell'handle sorgente sul nodo `from` (es. 's-top', 's-right').
   * Permette ai 4-sided handles di ricordare DA QUALE lato esce l'edge.
   * L'engine IGNORA questo campo — è solo per il rendering visivo di ReactFlow.
   * Lasciato opzionale per backward-compat: edge esistenti senza handle
   * usano il default (right per source, left per target).
   */
  sourceHandle: z.string().optional(),
  /**
   * UI-only: ID dell'handle target sul nodo `to` (es. 't-left', 't-top').
   * Stesso pattern di sourceHandle — solo per posizionamento visivo.
   */
  targetHandle: z.string().optional(),
  /**
   * GAP 1 — "Visible Auto-Map" (supera il per-item implicito-magico di n8n).
   *
   * Quando l'output del nodo a monte è un ARRAY e questo edge ha il map
   * attivo, l'engine esegue il nodo a valle UNA VOLTA PER ELEMENTO senza
   * logic_loop manuale. La semantica è VISIBILE (badge ×N sull'edge) e il
   * risultato aggregato è un array ALLINEATO PER INDICE all'input
   * (item i → results[i], anche per gli item falliti in continue-on-fail):
   * il pairing a valle è deterministico by-construction — niente footgun
   * `$itemMatching`.
   *
   *  - `off`  (default/assente) → pass-through storico: l'array arriva
   *           intero al nodo a valle. Zero regressioni sui workflow esistenti.
   *  - `each` → CONTRATTO RIGIDO: l'input DEVE essere un array; se non lo è,
   *           il nodo fallisce con errore esplicito (l'utente ha dichiarato
   *           una forma, una violazione è un bug da vedere, non da nascondere).
   *  - `auto` → TOLLERANTE: array → per-item; non-array → pass-through.
   *           È la modalità che l'AI scaffold abilita quando rileva
   *           array→scalare (mai un errore su dati legittimi non-array).
   *
   * I nodi BRANCHABLE (if/switch/loop) non sono mappabili: il branch
   * per-item sarebbe ambiguo → errore esplicito a runtime.
   */
  mapMode: z.enum(['off', 'auto', 'each']).optional(),
});
export type Edge = z.infer<typeof EdgeSchema>;
export type EdgeMapMode = NonNullable<Edge['mapMode']>;

export const BreakpointSchema = z.union([
  z.string(),
  z.object({
    nodeId: z.string().min(1),
    condition: z.string().optional(),
  }),
]);
export type Breakpoint = z.infer<typeof BreakpointSchema>;

export const WORKFLOW_SCHEMA_VERSION = '1.0.0';

/**
 * Workflow id format: opaque non-empty string. We don't constrain to UUID
 * to allow nanoid / ULID / KSUID generators chosen per deployment.
 */
export const IdSchema = z.string().min(1).max(128);

/**
 * Tenant id: opaque string, with the literal 'default' reserved for
 * single-tenant deployments. Multi-tenant deployments are expected to use
 * UUIDs but the schema does not force it (audit trail enforces uniqueness).
 */
export const TenantIdSchema = z.string().min(1).max(128);

export const WorkflowSchema = z.object({
  schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  id: IdSchema,
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  enabled: z.boolean(),
  nodes: z.array(CanvasNodeSchema),
  edges: z.array(EdgeSchema),
  nodeDefs: z.array(NodeDefSchema),
  breakpoints: z.array(BreakpointSchema).optional(),
  tags: z.array(z.string()).optional(),
  folderId: z.string().optional(),
  /**
   * On-error notification target — webhook receives a JSON POST or email is
   * sent (whichever is set). Both are best-effort; failure to notify is
   * logged but never propagated to the run.
   */
  onError: z
    .object({
      webhookUrl: z.string().url().optional(),
      emailTo: z.string().email().optional(),
    })
    .optional(),
  /** Concurrent-run limit; 0/undefined means unlimited. */
  concurrencyLimit: z.number().int().nonnegative().optional(),
  /**
   * @deprecated 2026-06-07 sera — usa `runVerbosity` invece (tri-state).
   * Manteniamo il campo per back-compat lettura.
   */
  ephemeralRuns: z.boolean().optional(),
  /**
   * 2026-06-07 sera (tier-aware logging) — sostituisce `ephemeralRuns`.
   *  - `silent`  → no trace persistito (= ephemeralRuns=true)
   *  - `summary` → trace metadati only, no input/output (~5KB/row)
   *  - `full`    → trace completo (default storico)
   * Plan tier gating: Free forzato a 'silent' lato server.
   */
  runVerbosity: z.enum(['silent', 'summary', 'full']).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  createdBy: IdSchema.optional(),
  ownerId: IdSchema.optional(),
  tenantId: TenantIdSchema.optional(),
});
export type Workflow = z.infer<typeof WorkflowSchema>;
