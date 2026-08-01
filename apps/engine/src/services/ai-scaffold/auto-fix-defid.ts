/**
 * Auto-fix Layer C+ — rimappa defId INVENTATI con suffix → base catalog.
 *
 * Bug user-osservato 2026-05-31:
 *   Prompt: "IMAP-driven CRM enrichment ... fai webhook lookup verso Clearbit/Hunter
 *            ... fetch della homepage del dominio + meta extract ..."
 *   Liara generava defId con suffix specifici del dominio (anti-pattern):
 *     • action_json_extract_sender      → action_json_extract
 *     • action_json_extract_domain      → action_json_extract
 *     • action_http_clearbit            → action_http
 *     • action_http_hunter              → action_http
 *     • action_web_fetch_homepage       → action_fetch_url
 *   Validation falliva: 5 errori "defId X non nel catalogo" → workflow rejected.
 *
 * Soluzione:
 *   1. Se defId NON è nel catalog, prova STRIP progressiva del suffix
 *      `_<lastpart>` finché trova un base defId noto.
 *   2. La differenza semantica (clearbit vs hunter) NON è persa: viene
 *      preservata nel `purpose` del nodo + nei config (es. URL Clearbit
 *      vs URL Hunter), che è la PRATICA giusta in FlowForge.
 *   3. Skip: defId che iniziano con `community_` (vendor è parte dell'identita\`),
 *      defId che iniziano con `trigger_` (ogni trigger è atomico).
 *   4. Min strip: 2 parts (mai ridurre a "action" o "agent" puro).
 *
 * Output idempotent + lista appliedFixes per logging/telemetry.
 *
 * Vocabolario alias (nomi n8n + termini generici → defId FlowForge) centralizzato in
 * `lib/node-aliases.ts`, condiviso con l'import n8n: un utente n8n può chiedere "Code",
 * "HTTP Request", "Set", "IF"… e se Liara emette quel termine come defId, viene
 * normalizzato qui al confine, senza ri-addestrare il LoRA.
 */
import { resolveNodeAlias } from '@/lib/node-aliases.js';

export interface DefIdFixInput {
  nodes: { id: string; defId: string; config: Record<string, unknown>; [k: string]: unknown }[];
}

export interface DefIdFixResult {
  nodes: DefIdFixInput['nodes'];
  appliedFixes: {
    nodeId: string;
    before: string;
    after: string;
    detail: string;
  }[];
}

const SKIP_PREFIXES = ['community_', 'trigger_'];
const MIN_PARTS = 2;

function shouldSkip(defId: string): boolean {
  return SKIP_PREFIXES.some((p) => defId.startsWith(p));
}

/**
 * Cerca il base defId rimuovendo suffix iterativamente.
 * Restituisce il primo match nel catalog, o null se nessuno.
 */
export function findBaseDefId(defId: string, knownDefIds: Set<string>): string | null {
  if (knownDefIds.has(defId)) return defId;
  // Alias (n8n + generici, es. flow_merge→logic_merge, code→action_run_js,
  // httpRequest→action_http) PRIMA del suffix-stripping e prima dello skip prefix:
  // è il vocabolario nomi-comuni → defId-runtime. Normalizza case/prefisso n8n.
  const aliased = resolveNodeAlias(defId);
  if (aliased && knownDefIds.has(aliased)) return aliased;
  if (shouldSkip(defId)) return null;
  const parts = defId.split('_');
  // Itera da N-1 parts a MIN_PARTS (es. "action_http_clearbit" prova
  // "action_http" prima di considerare ancora più corte).
  for (let n = parts.length - 1; n >= MIN_PARTS; n--) {
    const candidate = parts.slice(0, n).join('_');
    if (knownDefIds.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Rimappa nodes con defId inventato a base catalog noto.
 * Modifica i nodi in-place sulla copia ritornata.
 */
export function autoFixInventedDefIds(input: DefIdFixInput, knownDefIds: Set<string>): DefIdFixResult {
  const result: DefIdFixResult = {
    nodes: input.nodes.map((n) => ({ ...n, config: { ...n.config } })),
    appliedFixes: [],
  };

  for (const node of result.nodes) {
    if (knownDefIds.has(node.defId)) continue;
    const base = findBaseDefId(node.defId, knownDefIds); // gestisce alias + suffix-strip
    if (!base || base === node.defId) continue;
    const before = node.defId;
    node.defId = base;
    result.appliedFixes.push({
      nodeId: node.id,
      before,
      after: base,
      detail:
        `defId "${before}" non esiste nel catalogo. Rimappato a "${base}" (base reale). ` +
        `La differenza semantica del suffix originale e\` preservata nel config (URL/secret/label).`,
    });
  }

  return result;
}
