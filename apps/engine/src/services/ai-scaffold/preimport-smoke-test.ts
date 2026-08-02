/**
 * Pre-import smoke test — AI Scaffold Step 5 (Cappella Sistina).
 *
 * Da' fiducia all'utente che il workflow generato dall'AI realmente gira
 * PRIMA di importarlo. Per ogni nodo "lateral" (db_*, action_http,
 * action_send_email, agent_*), invoca un mock executor con fixture
 * realistiche e raccoglie:
 *  - input shape validity (zod-like check sul config)
 *  - output shape proposta (utile per riscaldare il type-check downstream)
 *  - errori potenziali (placeholder hard-coded, secrets mancanti, etc.)
 *
 * Output: SmokeReport con badge "verde / giallo / rosso" per ciascun nodo.
 * Pure — non chiama davvero db/http/smtp. Costo zero, sub-secondo.
 *
 * Architettura:
 *  - Pure logic (this file): nessun side effect, no LLM call
 *  - Smoke runners: una mappa defId → SmokeRunner che ritorna
 *    SimulationResult deterministica dal config
 *  - Aggregator: smokeTestWorkflow(workflow, opts): SmokeReport
 *  - Data-flow: valida i RIFERIMENTI tra nodi (reachability + catena json_extract)
 */
import { validateDataflow } from './dataflow-validator.js';

export interface WorkflowNode {
  id: string;
  defId: string;
  config: Record<string, unknown>;
  [k: string]: unknown;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  [k: string]: unknown;
}

export interface Workflow {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  [k: string]: unknown;
}

export type SmokeStatus = 'pass' | 'warn' | 'fail';

export interface SmokeNodeResult {
  nodeId: string;
  defId: string;
  status: SmokeStatus;
  /** Es. "URL hardcoded: https://x.com — verifica sia il tuo dominio reale". */
  reason: string;
  /** Forma simulated dell'output che questo nodo produrrebbe a runtime. */
  simulatedOutputShape?: Record<string, unknown>;
}

export interface SmokeReport {
  /** Aggregato. */
  overall: SmokeStatus;
  /** Per-nodo. */
  nodes: SmokeNodeResult[];
  /** Conteggi rapidi. */
  counts: { pass: number; warn: number; fail: number };
  /** Nodi non testati (defId non noto al simulatore — neutro, non blocca). */
  notSimulated: string[];
}

export interface SmokeOptions {
  /** Skip i nodi trigger (richiedono eventi esterni). Default true. */
  skipTriggers?: boolean;
  /** Set di defId considerati "registered" — se vuoto, considera tutti come noti. */
  registeredDefIds?: ReadonlySet<string>;
  /**
   * Set di defId AGENT pre-istruiti — quelli col `systemPrompt` HARDCODED nel
   * NodeDef (agent_data_analyst, agent_summarizer, security_audit, …). Per
   * questi il campo-istruzione nel config NON è richiesto: l'istruzione vive
   * nel def. Senza questo set lo smoke dava un FALSO POSITIVO "Agente senza
   * istruzioni" su workflow validi (bug owner 2026-06-12, goal SEO keyword
   * density → agent_data_analyst marcato rosso).
   */
  prePromptedDefIds?: ReadonlySet<string>;
}

/** Contesto passato a ogni runner — info che esulano dal singolo node.config. */
interface SmokeRunnerCtx {
  prePromptedDefIds: ReadonlySet<string>;
}

type SmokeRunner = (node: WorkflowNode, ctx: SmokeRunnerCtx) => SmokeNodeResult;

const PLACEHOLDER_RE = /YOUR_|REPLACE_ME|TODO|XXXXX|<your-|<insert/i;
const SECRET_PLACEHOLDER_RE = /\{\{secrets\.[A-Z0-9_]+\}\}/;
const URL_RE = /^https?:\/\/[^\s]+$/i;
/** Espressione template `{{ ... }}` (secret/$node/…) risolta a RUNTIME. Un URL
 *  che ne contiene una NON è validabile come stringa letterale: es.
 *  `{{secrets.HUBSPOT_API_URL}}/contacts` diventa un URL reale solo a runtime. */
const EXPRESSION_RE = /\{\{[^}]+\}\}/;

function checkPlaceholders(node: WorkflowNode, fields: string[]): SmokeNodeResult | null {
  for (const f of fields) {
    const v = node.config[f];
    if (typeof v !== 'string') continue;
    if (PLACEHOLDER_RE.test(v)) {
      return {
        nodeId: node.id,
        defId: node.defId,
        status: 'fail',
        reason: `Campo "${f}" contiene placeholder "${v}" — sostituisci prima di runtime.`,
      };
    }
  }
  return null;
}

const HTTP_RUNNER: SmokeRunner = (node) => {
  const url = typeof node.config.url === 'string' ? node.config.url : '';
  if (!url) {
    return {
      nodeId: node.id,
      defId: node.defId,
      status: 'fail',
      reason: 'Campo "url" mancante o vuoto.',
    };
  }
  const ph = checkPlaceholders(node, ['url', 'apiKey', 'token']);
  if (ph) return ph;
  // URL templato (`{{secrets.BASE}}/path`, `{{$node...}}`) → risolto a runtime:
  // non è validabile come stringa letterale, NON è un errore (era un falso
  // positivo che bocciava lookup HubSpot/Twilio/FattureInCloud, owner 2026-06-17).
  const isTemplatedUrl = EXPRESSION_RE.test(url);
  if (!isTemplatedUrl && !URL_RE.test(url)) {
    return {
      nodeId: node.id,
      defId: node.defId,
      status: 'fail',
      reason: `Campo "url" non è un URL valido: "${url}".`,
    };
  }
  const headers = node.config.headers;
  const hasAuthHeader =
    typeof headers === 'object' &&
    headers !== null &&
    Object.keys(headers).some((k) => /authorization|api[-_]?key|x-api-key/i.test(k));
  // authMode strutturato (bearer/basic/header-token/hmac/jwt) → l'header auth è
  // aggiunto a runtime: NON è un endpoint "senza auth". Pre-fix: falso positivo
  // su action_http con authMode:bearer + bearerToken (es. HubSpot).
  const authMode = typeof node.config.authMode === 'string' ? node.config.authMode.trim() : '';
  const hasStructuredAuth = authMode !== '' && authMode !== 'none';
  if (!hasAuthHeader && !hasStructuredAuth && url.includes('api.')) {
    return {
      nodeId: node.id,
      defId: node.defId,
      status: 'warn',
      reason: 'URL contiene "api." ma nessun header Authorization/X-API-Key — endpoint protetto?',
      simulatedOutputShape: { status: 200, body: '{}' },
    };
  }
  return {
    nodeId: node.id,
    defId: node.defId,
    status: 'pass',
    reason: 'HTTP call: URL valido, header auth presente.',
    simulatedOutputShape: { status: 200, body: '{}', headers: {} },
  };
};

const EMAIL_RUNNER: SmokeRunner = (node) => {
  const to = typeof node.config.to === 'string' ? node.config.to : '';
  const subj = typeof node.config.subject === 'string' ? node.config.subject : '';
  if (!to) {
    return { nodeId: node.id, defId: node.defId, status: 'fail', reason: 'Campo "to" mancante.' };
  }
  const ph = checkPlaceholders(node, ['to', 'subject', 'body']);
  if (ph) return ph;
  if (!to.includes('@') && !to.startsWith('{{')) {
    return {
      nodeId: node.id,
      defId: node.defId,
      status: 'fail',
      reason: `Campo "to" "${to}" non è un indirizzo email valido.`,
    };
  }
  if (!subj) {
    return {
      nodeId: node.id,
      defId: node.defId,
      status: 'warn',
      reason: 'Subject vuoto — il provider potrebbe flagare come spam.',
      simulatedOutputShape: { messageId: 'sim-msg-id', accepted: [to] },
    };
  }
  return {
    nodeId: node.id,
    defId: node.defId,
    status: 'pass',
    reason: 'Email: destinatario + subject + body presenti.',
    simulatedOutputShape: { messageId: 'sim-msg-id', accepted: [to] },
  };
};

const DB_QUERY_RUNNER: SmokeRunner = (node) => {
  const sql = typeof node.config.sql === 'string' ? node.config.sql : '';
  if (!sql) {
    return { nodeId: node.id, defId: node.defId, status: 'fail', reason: 'Campo "sql" mancante.' };
  }
  if (/DROP\s+TABLE|TRUNCATE/i.test(sql) && !sql.includes('--allow-destructive')) {
    return {
      nodeId: node.id,
      defId: node.defId,
      status: 'fail',
      reason: 'Query contiene DROP TABLE/TRUNCATE non marcato come safe.',
    };
  }
  const usesParams = /\?|:\w+|\$\d+/.test(sql);
  if (!usesParams && /INSERT|UPDATE|DELETE/i.test(sql)) {
    return {
      nodeId: node.id,
      defId: node.defId,
      status: 'warn',
      reason: 'Query write senza parametri — SQL injection risk se valori interpolati.',
      simulatedOutputShape: { rows: [], rowCount: 1 },
    };
  }
  return {
    nodeId: node.id,
    defId: node.defId,
    status: 'pass',
    reason: 'DB query: SQL presente, parametri usati.',
    simulatedOutputShape: { rows: [], rowCount: 0 },
  };
};

// Ogni tipo di agent ha il SUO campo-istruzione (NON tutti usano "prompt"):
//   agent_extractor→schema, agent_translator→targetLanguage, agent_classifier→labels,
//   agent_intent_router→intents, agent_summarizer→prompt, ecc.
// Pre-fix l'AGENT_RUNNER pretendeva "prompt" per tutti → falso positivo su
// extractor/translator/classifier (workflow validi marcati rossi).
const AGENT_INSTRUCTION_FIELDS = [
  'prompt',
  'schema',
  'targetLanguage',
  'customTargetLanguage',
  'labels',
  'intents',
  'instruction',
  'query',
];
const AGENT_RUNNER: SmokeRunner = (node, ctx) => {
  // Agent pre-istruito (systemPrompt nel def): l'istruzione c'è SEMPRE, è nel
  // NodeDef, non nel config. Il campo-istruzione utente è opzionale per questi.
  const isPrePrompted = ctx.prePromptedDefIds.has(node.defId);
  const hasInstruction =
    isPrePrompted ||
    AGENT_INSTRUCTION_FIELDS.some((f) => {
      const v = node.config[f];
      return typeof v === 'string' && v.trim() !== '';
    });
  if (!hasInstruction) {
    return {
      nodeId: node.id,
      defId: node.defId,
      status: 'fail',
      reason:
        'Agente senza istruzioni — manca uno tra prompt/schema/targetLanguage/labels/intents.',
    };
  }
  const apiKey = typeof node.config.apiKey === 'string' ? node.config.apiKey : '';
  if (apiKey && !SECRET_PLACEHOLDER_RE.test(apiKey) && !apiKey.startsWith('{{')) {
    return {
      nodeId: node.id,
      defId: node.defId,
      status: 'fail',
      reason: 'Campo "apiKey" è hard-coded — usa {{secrets.PROVIDER_API_KEY}}.',
    };
  }
  return {
    nodeId: node.id,
    defId: node.defId,
    status: 'pass',
    reason: 'Agent: istruzione presente, apiKey via secrets.',
    simulatedOutputShape: { text: '...', tokens: { input: 0, output: 0 } },
  };
};

// SOLO db_sql_query usa `sql` (raw SELECT, key:'sql'). TUTTI gli altri db_* —
// db_query INCLUSO — usano l'API STRUTTURATA `table` (+ filtersJson/selectJson per
// le read, rowJson/whereJson per le write). db_query NON ha proprio il campo sql.
// Pre-fix db_query era su DB_QUERY_RUNNER → "Campo sql mancante" falso (Redirect
// Chain Audit 2026-06-11: db_query con table+selectJson).
const DB_TABLE_RUNNER: SmokeRunner = (node) => {
  const table = typeof node.config.table === 'string' ? node.config.table.trim() : '';
  if (!table) {
    return {
      nodeId: node.id,
      defId: node.defId,
      status: 'fail',
      reason: 'Campo "table" mancante.',
    };
  }
  return {
    nodeId: node.id,
    defId: node.defId,
    status: 'pass',
    reason: 'DB (API strutturata): tabella presente.',
    simulatedOutputShape: { rows: [], rowCount: 1 },
  };
};

const RUNNERS: ReadonlyMap<string, SmokeRunner> = new Map<string, SmokeRunner>([
  ['action_http', HTTP_RUNNER],
  ['action_send_email', EMAIL_RUNNER],
  ['db_sql_query', DB_QUERY_RUNNER], // l'UNICO con sql grezzo
  ['db_query', DB_TABLE_RUNNER], // table + filtersJson/selectJson (NO sql)
  ['db_insert', DB_TABLE_RUNNER],
  ['db_insert_batch', DB_TABLE_RUNNER],
  ['db_update', DB_TABLE_RUNNER],
  ['db_delete', DB_TABLE_RUNNER],
]);

function pickRunner(defId: string): SmokeRunner | null {
  const exact = RUNNERS.get(defId);
  if (exact) return exact;
  if (defId.startsWith('agent_')) return AGENT_RUNNER;
  return null;
}

/**
 * Smoke-test del workflow. Pure. Ritorna SmokeReport.
 */
export function smokeTestWorkflow(workflow: Workflow, opts: SmokeOptions = {}): SmokeReport {
  const skipTriggers = opts.skipTriggers ?? true;
  const registered = opts.registeredDefIds;
  const runnerCtx: SmokeRunnerCtx = { prePromptedDefIds: opts.prePromptedDefIds ?? new Set() };
  const results: SmokeNodeResult[] = [];
  const notSimulated: string[] = [];

  for (const node of workflow.nodes) {
    if (skipTriggers && node.defId.startsWith('trigger_')) continue;
    if (registered && registered.size > 0 && !registered.has(node.defId)) {
      // Non testabile: defId non è registrato (es. workflow contiene defId che
      // verrà sintetizzato dopo). Saltato silenziosamente.
      notSimulated.push(node.id);
      continue;
    }
    const runner = pickRunner(node.defId);
    if (!runner) {
      notSimulated.push(node.id);
      continue;
    }
    results.push(runner(node, runnerCtx));
  }

  // DATA-FLOW: oltre la struttura del singolo nodo, valida i RIFERIMENTI tra nodi
  // (reachability + catena json_extract). Becca "referenzi un nodo non a monte" e
  // il mismatch semantico tipo email→dominio che il check per-nodo non vede.
  for (const dfi of validateDataflow(workflow.nodes, workflow.edges)) {
    results.push({
      nodeId: dfi.nodeId,
      defId: 'data-flow',
      status: dfi.status,
      reason: dfi.reason,
    });
  }

  const counts = {
    pass: results.filter((r) => r.status === 'pass').length,
    warn: results.filter((r) => r.status === 'warn').length,
    fail: results.filter((r) => r.status === 'fail').length,
  };
  const overall: SmokeStatus = counts.fail > 0 ? 'fail' : counts.warn > 0 ? 'warn' : 'pass';
  return { overall, nodes: results, counts, notSimulated };
}
