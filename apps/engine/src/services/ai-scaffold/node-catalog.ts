/**
 * Node catalog helpers per l'AI Scaffold agent.
 *
 * - `buildNodeCatalog`: snapshot del registry runtime (ALL_NODE_MODULES + community
 *   nodes runtime-loaded da loadInstalledFromDisk) con configFields completi.
 *   L'agente lo consulta per non inventare defId o config invalid.
 * - `normalizeColumnType`: whitelist dei tipi SQL accettati per
 *   create_table / add_column (evita SQL injection di tipi inventati).
 * - `normalizeConstraints`: parsing safe di {nullable, unique, primaryKey}.
 */
import { ALL_NODE_MODULES } from '@/engine/workflow-engine.js';
import { AI_AGENT_DEFINITIONS } from '@medea/engine-nodes-ai-agents';
import { listInstalled } from '@/services/community-nodes.service.js';
import type { OutputContract } from '@medea/engine-core-schema';

export interface NodeCatalogActionSummary {
  id: string;
  label: string;
  description?: string;
  category?: string;
  fields: NodeCatalogEntry['fields'];
}

export interface NodeCatalogEntry {
  defId: string;
  type: string;
  label: string;
  description: string;
  /** Per-field schema: name, type, required, options (if enum), pattern (if regex). */
  fields: {
    key: string;
    label: string;
    type: string;
    required: boolean;
    options?: string[];
    pattern?: string;
    defaultValue?: string;
  }[];
  /** Sub-actions (multi-action community nodes like community_telegram with 75 actions). */
  actions?: NodeCatalogActionSummary[];
  /** Alias di discoverability dichiarati dal NodeDef (vedi NodeDefSchema.searchAliases). */
  searchAliases?: string[];
  /** Contratto di output (cosa ritorna + edge-case) — grounding per l'analisi AI. */
  outputContract?: OutputContract;
}

interface NodeDefLike {
  id: string;
  type: string;
  label: string;
  description?: string;
  searchAliases?: string[];
  outputContract?: OutputContract;
  configFields?: {
    key: string;
    label: string;
    type?: string;
    required?: boolean;
    options?: string[];
    pattern?: string;
    defaultValue?: string;
  }[];
  actions?: {
    id: string;
    label: string;
    description?: string;
    category?: string;
    configFields?: NodeDefLike['configFields'];
  }[];
}

function mapField(
  f: NonNullable<NodeDefLike['configFields']>[number],
): NodeCatalogEntry['fields'][number] {
  const out: NodeCatalogEntry['fields'][number] = {
    key: f.key,
    label: f.label,
    type: f.type ?? 'text',
    required: f.required ?? false,
  };
  if (f.options) out.options = f.options;
  if (f.pattern) out.pattern = f.pattern;
  if (f.defaultValue) out.defaultValue = f.defaultValue;
  return out;
}

function defToCatalogEntry(def: NodeDefLike): NodeCatalogEntry {
  const entry: NodeCatalogEntry = {
    defId: def.id,
    type: def.type,
    label: def.label,
    description: def.description ?? '',
    fields: (def.configFields ?? []).map(mapField),
  };
  if (def.searchAliases && def.searchAliases.length > 0) entry.searchAliases = def.searchAliases;
  if (def.outputContract) entry.outputContract = def.outputContract;
  if (def.actions && def.actions.length > 0) {
    entry.actions = def.actions.map((a) => {
      const summary: NodeCatalogActionSummary = {
        id: a.id,
        label: a.label,
        fields: (a.configFields ?? []).map(mapField),
      };
      if (a.description) summary.description = a.description;
      if (a.category) summary.category = a.category;
      return summary;
    });
  }
  return entry;
}

/**
 * Build the node catalog dynamically:
 *   1. Bundled packages via ALL_NODE_MODULES (stdlib, db, italian-connectors,
 *      ai-agent, llm — `integrations-core` ora vuoto).
 *   2. Community nodes installed-from-disk (loadInstalledFromDisk → listInstalled).
 *      Include i 7 vendor v2.0 (community_telegram con 75 actions, community_slack
 *      con 57, ecc.) — questi NON sono in ALL_NODE_MODULES.
 *
 * Senza la fusione il SYSTEM_PROMPT puo\` istruire Liara a usare community_<vendor>
 * ma il catalog upfront non li menziona → Liara fa abort "non nel catalogo".
 * FIX 2026-05-30 user-segnalato.
 */
export function buildNodeCatalog(): NodeCatalogEntry[] {
  const bundled = ALL_NODE_MODULES.map((m) => defToCatalogEntry(m.def as NodeDefLike));
  const community = listInstalled().map((n) => defToCatalogEntry(n.def as NodeDefLike));

  // De-dup: se per ipotesi un community node ha lo stesso defId di un bundled
  // (impossibile col namespace community_<vendor>, ma defensivo) vince community.
  const byDefId = new Map<string, NodeCatalogEntry>();
  for (const e of bundled) byDefId.set(e.defId, e);
  for (const e of community) byDefId.set(e.defId, e);
  return Array.from(byDefId.values());
}

/**
 * Set dei defId AGENT pre-istruiti — quelli col `systemPrompt` HARDCODED nel
 * NodeDef (agent_data_analyst, agent_summarizer, security_audit, …). Lo smoke
 * test li deve riconoscere come "già istruiti" anche senza campo-istruzione nel
 * config (altrimenti falso positivo "Agente senza istruzioni", bug owner
 * 2026-06-12). Single source of truth: il `systemPrompt` del def, non una
 * whitelist hardcoded che andrebbe out-of-sync coi nodi nuovi.
 */
export function buildPrePromptedAgentDefIds(): Set<string> {
  const out = new Set<string>();
  // Fonte di verità: AI_AGENT_DEFINITIONS — il `systemPrompt` vive QUI, non sul
  // NodeDef (makeAgentNode costruisce il def coi soli configFields; lo schema
  // NodeDef non ha systemPrompt). Derivare dalle definizioni evita una
  // whitelist hardcoded che andrebbe out-of-sync coi nuovi agent.
  for (const a of AI_AGENT_DEFINITIONS) {
    if (typeof a.systemPrompt === 'string' && a.systemPrompt.trim() !== '') {
      out.add(a.id); // gli id includono già il prefisso "agent_"
    }
  }
  return out;
}

export const ALLOWED_COLUMN_TYPES = [
  'bigint',
  'boolean',
  'text',
  'varchar',
  'integer',
  'decimal',
  'real',
  'date',
  'time',
  'datetime',
  'json',
  'uuid',
  'bytea',
  'enum',
] as const;

export type ColumnType = (typeof ALLOWED_COLUMN_TYPES)[number];

export function normalizeColumnType(raw: unknown): ColumnType {
  const s = typeof raw === 'string' ? raw.toLowerCase().trim() : 'text';
  return (ALLOWED_COLUMN_TYPES as readonly string[]).includes(s) ? (s as ColumnType) : 'text';
}

export function normalizeConstraints(raw: unknown): {
  nullable: boolean;
  unique: boolean;
  primaryKey: boolean;
} {
  const c = (raw && typeof raw === 'object' ? raw : {}) as {
    nullable?: unknown;
    unique?: unknown;
    primaryKey?: unknown;
  };
  return {
    nullable: c.nullable === false ? false : true,
    unique: c.unique === true,
    primaryKey: c.primaryKey === true,
  };
}
