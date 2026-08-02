/**
 * node-aliases — vocabolario UNICO: nomi n8n + termini generici → defId FlowForge.
 *
 * Fonte condivisa tra:
 *   - import n8n (route /n8n-import): converte i `type` n8n in defId FlowForge.
 *   - net deterministico dello scaffold (auto-fix-defid): se Liara emette un defId
 *     in stile n8n o un termine generico (es. "code", "httpRequest", "set"), lo
 *     normalizza al defId reale al confine, prima della validazione.
 *
 * Obiettivo prodotto: un utente che VIENE DA n8n può chiedere "Code node",
 * "HTTP Request", "Set", "IF", "Merge"… e ottenere il nodo FlowForge giusto, senza
 * conoscere la nomenclatura FlowForge.
 *
 * ⚠️ Questa mappa è SOLO lessicale (traduzione di nomi). Chi la consuma DEVE
 * verificare che il defId risolto sia nel catalog runtime (source-of-truth degli
 * executor): `resolveNodeAlias` non garantisce l'esistenza, solo la traduzione.
 */

/**
 * Normalizza un termine/identificatore a chiave canonica: lowercase, strip dei
 * prefissi-namespace n8n, rimozione dei caratteri non-alfanumerici. Così
 * "HTTP Request", "httpRequest", "http_request", "n8n-nodes-base.httpRequest"
 * collassano tutti su `httprequest`.
 */
export function normalizeAliasKey(term: string): string {
  return term
    .trim()
    .toLowerCase()
    .replace(/^@n8n\/n8n-nodes-langchain\./, '')
    .replace(/^n8n-nodes-base\./, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * chiave normalizzata → defId FlowForge. Solo target REALI (verificati nel catalog).
 * I tipi n8n senza equivalente reale (stripe/openai/anthropic) NON sono qui: cadono
 * sul fallback del chiamante (`action_http`) invece di un defId fantasma.
 */
const ALIASES: ReadonlyMap<string, string> = new Map([
  // ── Trigger ──
  ['start', 'trigger_manual'],
  ['manualtrigger', 'trigger_manual'],
  ['manual', 'trigger_manual'],
  ['cron', 'trigger_cron'],
  ['scheduletrigger', 'trigger_cron'],
  ['schedule', 'trigger_cron'],
  ['webhook', 'trigger_webhook'],
  ['formtrigger', 'trigger_form'],
  ['form', 'trigger_form'],
  // ── Code (DEFAULT JavaScript, come n8n; Python solo se esplicito) ──
  ['code', 'action_run_js'],
  ['codenode', 'action_run_js'],
  ['function', 'action_run_js'],
  ['functionitem', 'action_run_js'],
  ['runjs', 'action_run_js'],
  ['runjavascript', 'action_run_js'],
  ['javascript', 'action_run_js'],
  ['js', 'action_run_js'],
  ['runpython', 'action_run_python'],
  ['python', 'action_run_python'],
  ['py', 'action_run_python'],
  // ── HTTP / fetch ──
  ['httprequest', 'action_http'],
  ['http', 'action_http'],
  ['fetch', 'action_http'],
  // ── Set / transform ──
  ['set', 'logic_transform'],
  ['editfields', 'logic_transform'],
  ['edit', 'logic_transform'],
  ['transform', 'logic_transform'],
  // ── Logic ──
  ['if', 'logic_if'],
  ['filter', 'logic_if'],
  ['switch', 'logic_switch'],
  ['merge', 'logic_merge'],
  ['flowmerge', 'logic_merge'],
  ['join', 'logic_merge'],
  ['wait', 'logic_wait'],
  ['splitinbatches', 'logic_loop'],
  ['loop', 'logic_loop'],
  ['splitout', 'logic_loop'],
  // ── Email ──
  ['emailsend', 'action_send_email'],
  ['gmail', 'action_send_email'],
  ['email', 'action_send_email'],
  ['sendemail', 'action_send_email'],
  // ── AI / LLM (nodo LLM reale, NON fallback HTTP) ──
  ['openai', 'action_llm_complete'],
  ['anthropic', 'action_llm_complete'],
  ['llm', 'action_llm_complete'],
  ['llmchain', 'action_llm_complete'],
  ['chatopenai', 'action_llm_complete'],
  // ── Community (vendor reali nel catalog) ──
  ['slack', 'community_slack'],
  ['discord', 'community_discord'],
  ['github', 'community_github'],
  ['notion', 'community_notion'],
  ['telegram', 'community_telegram'],
]);

/**
 * Risolve un nome n8n / termine generico → defId FlowForge, o `undefined` se non
 * c'è alias (il chiamante decide il fallback).
 */
export function resolveNodeAlias(term: string): string | undefined {
  return ALIASES.get(normalizeAliasKey(term));
}

/**
 * Insieme di TUTTI i defId-target distinti della mappa. Serve al contract test che
 * verifica che ogni target esista nel catalog runtime reale (anti-fantasma): se un
 * alias punta a un defId inesistente/rinominato, il test va rosso.
 */
export function aliasTargets(): ReadonlySet<string> {
  return new Set(ALIASES.values());
}

/**
 * Mappa un `type` n8n → defId FlowForge per l'import. Tipi senza equivalente reale
 * cadono sul fallback (default `action_http`, un nodo reale: meglio di un defId
 * fantasma che fallirebbe il load).
 */
export function n8nTypeToDefId(n8nType: string, fallback = 'action_http'): string {
  return resolveNodeAlias(n8nType) ?? fallback;
}
