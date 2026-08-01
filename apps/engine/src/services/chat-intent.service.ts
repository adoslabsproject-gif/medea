/**
 * Chat intent detector + auto-tool-executor.
 *
 * PATTERN: deterministic intent classification BEFORE LLM call. Stesso
 * approccio di ChatGPT Browsing, Perplexity, Claude.ai: non si delega al
 * LLM la decisione "devo chiamare un tool?" perché i modelli weak
 * (Liara/Qwen, Gemini Flash, Llama 3.x small) ignorano sistematicamente
 * le istruzioni "USA QUESTO TOOL SE NECESSARIO" sepolte nel system prompt.
 *
 * INVECE: il backend ispeziona il messaggio utente con regex/keyword,
 * PRE-ESEGUE i tool deterministicamente, inietta il risultato nel system
 * prompt come `WEB_CONTEXT_FROM_TOOLS = ...`. Il LLM riceve i dati già
 * pronti e deve solo formularli in italiano.
 *
 * Tradeoff:
 *   ─ Pro: garantito che "cerca X" o "fetch URL" funzioni SEMPRE, su
 *          QUALSIASI provider, indipendentemente dalle capacità tool_use
 *   ─ Contro: l'agente non può inventarsi NUOVE query dinamicamente
 *            (es. "cerca X, poi sulla base dei risultati cerca Y"). Per
 *            quello servirebbe il loop LLM tool_use (Layer 2, vedi
 *            llm-chat.service.ts dispatch con tools native).
 *
 * Per il use case primario "cerca sul web" / "leggi questa URL" Layer 1
 * è sufficiente e MOLTO più affidabile.
 */

import { fetchUrl, webSearch, type FetchUrlResult, type SearchResponse } from './web-tools.service.js';
import {
  listWorkflows,
  setWorkflowEnabled,
  runWorkflow,
  configureNode,
  type WorkflowSummary,
} from './workflow-control-tools.service.js';
import { analyzeImage, extractDocument, type VisionAnalysisResult, type DocumentExtractionResult, type VisionLlmTarget } from './vision-tools.service.js';

export type IntentType =
  | 'fetch_url' | 'web_search'
  | 'list_workflows' | 'run_workflow' | 'enable_workflow' | 'disable_workflow' | 'configure_node'
  | 'analyze_image' | 'extract_document';

export interface DetectedIntent {
  /** Tipo di intent rilevato (può essere multiplo per messaggio). */
  type: IntentType;
  /** Args derivati dal messaggio per l'esecuzione automatica. */
  args: {
    url?: string;
    query?: string;
    workflowName?: string;
    workflowId?: string;
    nodeId?: string;
    configPatch?: Record<string, unknown>;
    imageBase64?: string;
    imagePrompt?: string;
    documentBase64?: string;
    documentMime?: string;
    documentName?: string;
    triggerInput?: unknown;
  };
  /** Reason: quale pattern ha matchato (debug-friendly). */
  reason: string;
}

export type ToolResultData =
  | FetchUrlResult
  | SearchResponse
  | { workflows: WorkflowSummary[] }
  | { ok: boolean; runId?: string; enabled?: boolean; updatedConfig?: Record<string, unknown>; error?: string }
  | VisionAnalysisResult
  | DocumentExtractionResult;

export interface ToolExecutionResult {
  intent: DetectedIntent;
  /** Risultato grezzo del tool (per debug + logging). */
  data: ToolResultData;
  /** Errore se il tool è fallito. */
  error?: string;
}

// ─── Workflow control trigger patterns ─────────────────────────────────────

const RUN_WORKFLOW_TRIGGERS = [
  /\b(?:esegui|lancia|avvia|fai partire|parti|run|launch|execute)\s+(?:il\s+|the\s+)?(?:workflow\s+)?["']?([a-z0-9_\-\s]{2,80}?)["']?(?:\s*$|\s+(?:adesso|now|per favore|please|grazie)|[.!?,;])/i,
];
const ENABLE_WORKFLOW_TRIGGERS = [
  /\b(?:attiva|abilita|accendi|enable|activate|turn on)\s+(?:il\s+|the\s+)?(?:workflow\s+)?["']?([a-z0-9_\-\s]{2,80}?)["']?(?:\s*$|\s+(?:adesso|now|per favore|please|grazie)|[.!?,;])/i,
];
const DISABLE_WORKFLOW_TRIGGERS = [
  /\b(?:disattiva|disabilita|spegni|ferma|stop|disable|deactivate|turn off|pausa)\s+(?:il\s+|the\s+)?(?:workflow\s+)?["']?([a-z0-9_\-\s]{2,80}?)["']?(?:\s*$|\s+(?:adesso|now|per favore|please|grazie)|[.!?,;])/i,
];
const LIST_WORKFLOWS_TRIGGERS = [
  /\b(?:lista|elenca|mostrami|fammi vedere|quali|che|list|show)(?:\s+(?:me|mi|tutti|all|the|i|gli|miei|my))*\s+workflow/i,
  /\bworkflow\s+(?:esistenti|disponibili|configurati|available|configured)\b/i,
];
const CONFIGURE_NODE_TRIGGERS = [
  /\b(?:configura|imposta|set|configure|update|aggiorna)\s+(?:il\s+|the\s+)?nodo\s+["']?([a-z0-9_-]+)["']?\s+(?:del|di|of|in)\s+(?:il\s+|workflow\s+|the\s+)?["']?([a-z0-9_\-\s]{2,80}?)["']?\s+(?:con|with|to|=)\s+(.+?)(?:\s*$|[.!?])/i,
];

function parseConfigPatch(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const pairRegex = /([a-z_][a-z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,]+))/gi;
  let match;
  while ((match = pairRegex.exec(raw)) !== null) {
    const key = match[1];
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (key) {
      if (value === 'true') out[key] = true;
      else if (value === 'false') out[key] = false;
      else if (/^-?\d+(\.\d+)?$/.test(value)) out[key] = Number(value);
      else out[key] = value;
    }
  }
  return out;
}

export function resolveWorkflowName(name: string): { workflow: WorkflowSummary; confidence: number } | null {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return null;
  const all = listWorkflows();
  const exact = all.find((w) => w.id.toLowerCase() === trimmed || w.name.toLowerCase() === trimmed);
  if (exact) return { workflow: exact, confidence: 1.0 };
  const candidates = all.filter((w) =>
    w.name.toLowerCase().includes(trimmed) ||
    w.id.toLowerCase().includes(trimmed) ||
    trimmed.includes(w.name.toLowerCase()),
  );
  if (candidates.length === 1) return { workflow: candidates[0]!, confidence: 0.85 };
  if (candidates.length > 1) {
    const sorted = [...candidates].sort((a, b) => b.name.length - a.name.length);
    return { workflow: sorted[0]!, confidence: 0.6 };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Intent detection
// ─────────────────────────────────────────────────────────────────────────

// URL pattern (http/https) — match esplicito di URL embedded nel testo
const URL_REGEX = /\b(https?:\/\/[^\s<>"')]+)/gi;

// Bare domain (es. "nothumanallowed.com", "google.it") — solo se accompagnato
// da verbo intent (es. "cerca", "vai su", "apri"), per non scatenare fetch
// su menzioni casuali tipo "leggi gmail.com"
const BARE_DOMAIN_REGEX = /\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z]{2,24}(?:\.[a-z]{2,24})?)\b/gi;

// Trigger keywords per web search — gestiti come WORD BOUNDARY, case-insensitive
const SEARCH_TRIGGERS = [
  /\b(cerca(?:mi|temi)?|cerchi|cercare)\b/i,
  // "trova" SOLO imperativo di ricerca (trovami/trovare/trova X), NON il riflessivo
  // "si trova" / "dove si trova" (= dov'è, domanda di posizione UI, non ricerca web).
  // Bug 2026-06-28: "e dove si trova? non vedo i nodi" scatenava web_search spazzatura.
  /(?<!\bsi\s)\b(trova(?:mi|temi)?|trovare)\b/i,
  /\b(google|googla(?:mi|temi)?)\b/i,
  /\b(search|find|lookup)\b/i,
  /\bsul web\b/i,
  /\bonline\b/i,
  /\binformazioni? su\b/i,
  /\bcosa (?:è|sai|sai dire) (?:di|su)\b/i,
  /\bdimmi cosa è\b/i,
  /\bchi è\b/i,
  /\bcos['']è\b/i,
];

// Trigger keywords per fetch URL (anche se non c'è URL esplicito —
// pattern "apri/leggi/vai a")
const FETCH_TRIGGERS = [
  /\b(apri|aprire|leggi|leggere|visita|visitare|vai (?:a|su)|scarica|scaricare|fetch|fetcha(?:mi|temi)?)\b/i,
];

/**
 * Analizza il messaggio utente, ritorna lista intent rilevati.
 *
 * Strategia:
 *   1. Se ci sono URL espliciti http(s)://… → fetch_url per ognuno (max 3)
 *   2. Se c'è un trigger search ("cerca X", "googla Y") → web_search
 *      con query = porzione di testo dopo il trigger
 *   3. Se c'è bare-domain + trigger fetch ("apri foo.com") → fetch_url
 *      su https://foo.com
 *   4. Se c'è una domanda "chi è X" / "cosa è X" + parola plausibile non
 *      coperta da knowledge del modello (heuristica leggera) → web_search
 */
export function detectIntents(userMessage: string): DetectedIntent[] {
  const intents: DetectedIntent[] = [];
  const msg = userMessage.trim();
  if (!msg) return intents;

  // ─── Workflow control intents (precedenza su web tools) ───
  for (const rx of LIST_WORKFLOWS_TRIGGERS) {
    if (rx.test(msg)) { intents.push({ type: 'list_workflows', args: {}, reason: 'list workflows trigger' }); break; }
  }
  for (const rx of RUN_WORKFLOW_TRIGGERS) {
    const m = rx.exec(msg);
    if (m?.[1]) { intents.push({ type: 'run_workflow', args: { workflowName: m[1].trim() }, reason: `run trigger: "${m[1].trim()}"` }); break; }
  }
  for (const rx of ENABLE_WORKFLOW_TRIGGERS) {
    const m = rx.exec(msg);
    if (m?.[1] && !intents.some((i) => i.type === 'run_workflow')) {
      intents.push({ type: 'enable_workflow', args: { workflowName: m[1].trim() }, reason: `enable trigger: "${m[1].trim()}"` });
      break;
    }
  }
  for (const rx of DISABLE_WORKFLOW_TRIGGERS) {
    const m = rx.exec(msg);
    if (m?.[1] && !intents.some((i) => i.type === 'run_workflow' || i.type === 'enable_workflow')) {
      intents.push({ type: 'disable_workflow', args: { workflowName: m[1].trim() }, reason: `disable trigger: "${m[1].trim()}"` });
      break;
    }
  }
  for (const rx of CONFIGURE_NODE_TRIGGERS) {
    const m = rx.exec(msg);
    if (m?.[1] && m[2] && m[3]) {
      intents.push({
        type: 'configure_node',
        args: { nodeId: m[1].trim(), workflowName: m[2].trim(), configPatch: parseConfigPatch(m[3].trim()) },
        reason: `configure trigger: nodo "${m[1]}" wf "${m[2]}"`,
      });
      break;
    }
  }

  // 1. URL espliciti
  const explicitUrls = Array.from(msg.matchAll(URL_REGEX)).map((m) => m[1]).filter((u): u is string => !!u);
  for (const url of explicitUrls.slice(0, 3)) {
    intents.push({ type: 'fetch_url', args: { url }, reason: `URL esplicito: ${url}` });
  }

  // 2. Trigger search
  const hasSearchTrigger = SEARCH_TRIGGERS.some((rx) => rx.test(msg));
  // 3. Trigger fetch + bare domain
  const hasFetchTrigger = FETCH_TRIGGERS.some((rx) => rx.test(msg));
  const bareDomains = Array.from(msg.matchAll(BARE_DOMAIN_REGEX))
    .map((m) => m[1])
    .filter((d): d is string => !!d)
    // Escludi bare domain che fanno parte di URL già catturati
    .filter((d) => !explicitUrls.some((u) => u.includes(d)));

  if (hasFetchTrigger && bareDomains.length > 0) {
    for (const dom of bareDomains.slice(0, 2)) {
      intents.push({ type: 'fetch_url', args: { url: `https://${dom}` }, reason: `Bare domain + verbo fetch: ${dom}` });
    }
  }

  if (hasSearchTrigger) {
    // Query = tutto il messaggio (più affidabile di parsing "dopo cerca")
    // Pulisci verbi di trigger comuni dal query per migliorare i risultati
    const query = msg
      .replace(/\b(cerca(?:mi|temi)?|cerchi|cercare|trova(?:mi|temi)?|trovare|google|googla(?:mi|temi)?|search|find|lookup)\b/gi, '')
      .replace(/\b(sul web|online|in rete|in internet)\b/gi, '')
      .replace(/\b(per favore|per piacere|grazie|dimmi|fammi sapere)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    // Se dopo aver tolto i verbi-trigger non resta una query sensata (es. il messaggio
    // era SOLO "cerca" o una domanda UI tipo "dove si trova"), NON fare web_search:
    // cercare il messaggio intero produce risultati spazzatura. Meglio nessun intent.
    if (query.length >= 2) {
      intents.push({ type: 'web_search', args: { query }, reason: `Trigger search keyword: "${query}"` });
    }
  } else if (bareDomains.length > 0 && !hasFetchTrigger && intents.length === 0) {
    // Bare domain SENZA verbo fetch ma SENZA altri intent: search del domain
    // (es. "nothumanallowed.com cos'è?" o "dimmi su example.com")
    const dom = bareDomains[0];
    if (dom) {
      intents.push({ type: 'web_search', args: { query: dom }, reason: `Bare domain in messaggio info-seeking: ${dom}` });
    }
  }

  return intents;
}

// ─────────────────────────────────────────────────────────────────────────
// Auto-execution: per ogni intent rilevato, esegui il tool e ritorna i risultati
// ─────────────────────────────────────────────────────────────────────────

export async function executeIntents(
  intents: DetectedIntent[],
  /** Provider LLM risolto del tenant (BYOK o Liara) per i tool vision. Assente →
   *  i tool immagine/documento ritornano un errore esplicito. */
  visionTarget?: VisionLlmTarget,
): Promise<ToolExecutionResult[]> {
  const results: ToolExecutionResult[] = [];
  for (const intent of intents) {
    try {
      switch (intent.type) {
        case 'fetch_url': {
          if (!intent.args.url) break;
          results.push({ intent, data: await fetchUrl(intent.args.url) });
          break;
        }
        case 'web_search': {
          if (!intent.args.query) break;
          results.push({ intent, data: await webSearch(intent.args.query, 10) });
          break;
        }
        case 'list_workflows': {
          results.push({ intent, data: { workflows: listWorkflows() } });
          break;
        }
        case 'run_workflow': {
          const name = intent.args.workflowName ?? '';
          const resolved = resolveWorkflowName(name);
          if (!resolved) {
            results.push({ intent, data: { ok: false, error: `Workflow "${name}" non trovato.` }, error: `not_found: ${name}` });
            break;
          }
          const ran = await runWorkflow({ workflowId: resolved.workflow.id, triggerInput: intent.args.triggerInput });
          results.push({ intent: { ...intent, args: { ...intent.args, workflowId: resolved.workflow.id } }, data: ran });
          break;
        }
        case 'enable_workflow':
        case 'disable_workflow': {
          const name = intent.args.workflowName ?? '';
          const resolved = resolveWorkflowName(name);
          if (!resolved) {
            results.push({ intent, data: { ok: false, error: `Workflow "${name}" non trovato.` }, error: `not_found: ${name}` });
            break;
          }
          const toggled = setWorkflowEnabled({ workflowId: resolved.workflow.id, enabled: intent.type === 'enable_workflow' });
          results.push({ intent: { ...intent, args: { ...intent.args, workflowId: resolved.workflow.id } }, data: toggled });
          break;
        }
        case 'configure_node': {
          const name = intent.args.workflowName ?? '';
          const resolved = resolveWorkflowName(name);
          if (!resolved) {
            results.push({ intent, data: { ok: false, error: `Workflow "${name}" non trovato.` }, error: `not_found: ${name}` });
            break;
          }
          if (!intent.args.nodeId || !intent.args.configPatch || Object.keys(intent.args.configPatch).length === 0) {
            results.push({ intent, data: { ok: false, error: 'configure_node richiede nodeId + key=value.' }, error: 'invalid_args' });
            break;
          }
          const updated = configureNode({
            workflowId: resolved.workflow.id,
            nodeId: intent.args.nodeId,
            configPatch: intent.args.configPatch,
          });
          results.push({ intent: { ...intent, args: { ...intent.args, workflowId: resolved.workflow.id } }, data: updated });
          break;
        }
        case 'analyze_image': {
          if (!intent.args.imageBase64) break;
          if (!visionTarget) {
            results.push({ intent, data: { ok: false, error: 'Lettura immagini non disponibile: nessun provider AI risolto.', elapsedMs: 0 }, error: 'no_vision_provider' });
            break;
          }
          results.push({ intent, data: await analyzeImage(intent.args.imageBase64, intent.args.imagePrompt, visionTarget) });
          break;
        }
        case 'extract_document': {
          if (!intent.args.documentBase64 || !intent.args.documentMime) break;
          results.push({ intent, data: await extractDocument(intent.args.documentBase64, intent.args.documentMime) });
          break;
        }
      }
    } catch (e) {
      results.push({
        intent,
        data: { ok: false, error: e instanceof Error ? e.message : String(e) },
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────
// Format tool results come system context per il LLM
// ─────────────────────────────────────────────────────────────────────────

/**
 * Converte i risultati eseguiti in un blocco markdown da iniettare nel
 * system prompt. Cap a 30KB totali per evitare context explosion.
 */
export function formatToolResultsForPrompt(results: ToolExecutionResult[]): string {
  if (results.length === 0) return '';
  const parts: string[] = [
    '═══════════════════════════════════════════════════════════',
    'CONTESTO RICAVATO (web + allegati, auto-eseguito dal sistema):',
    '═══════════════════════════════════════════════════════════',
    '',
    'Hai a disposizione i seguenti risultati di ricerca/fetch ottenuti',
    'dal web dopo aver analizzato la richiesta dell\'utente. USA QUESTI',
    'DATI per formulare la risposta. NON dire "non trovo informazioni"',
    'se sotto ci sono risultati pertinenti.',
    '',
  ];
  let totalChars = 0;
  const MAX_CHARS = 30_000;

  for (const r of results) {
    if (totalChars > MAX_CHARS) break;
    parts.push(`--- ${r.intent.reason} ---`);
    if (r.error) {
      parts.push(`[Errore esecuzione tool: ${r.error}]`);
      parts.push('');
      continue;
    }
    if (r.intent.type === 'fetch_url') {
      const d = r.data as FetchUrlResult;
      parts.push(`URL: ${d.finalUrl}  (extractor: ${d.extractor})`);
      if (d.title) parts.push(`Titolo: ${d.title}`);
      if (d.description) parts.push(`Descrizione: ${d.description}`);
      const contentSlice = d.content.slice(0, 8_000);
      parts.push('Contenuto estratto:');
      parts.push(contentSlice);
      if (d.truncated) parts.push('[…contenuto troncato al limite di lettura della pagina]');
      totalChars += contentSlice.length + 500;
    } else if (r.intent.type === 'analyze_image') {
      // FIX 2026-06-22: senza questo ramo il risultato vision cadeva nell'`else`
      // (cast as SearchResponse) → il testo estratto NON entrava mai nel prompt →
      // Liara rispondeva "non vedo la foto". Ora emettiamo testo + dati strutturati,
      // e su ko un avviso ESPLICITO (così non nega l'esistenza dell'allegato).
      const d = r.data as VisionAnalysisResult;
      if (d.ok && (d.text ?? '').trim().length > 0) {
        const slice = d.text!.slice(0, 8_000);
        parts.push('Analisi dell\'immagine allegata (vision):');
        parts.push(slice);
        if (d.structured) parts.push(`Dati strutturati: ${JSON.stringify(d.structured).slice(0, 2_000)}`);
        totalChars += slice.length + 500;
      } else {
        parts.push(`[L'utente HA allegato un'immagine ma l'analisi visiva non è disponibile ora${d.error ? `: ${d.error}` : ''}. NON negare che l'allegato esista: chiedi di riprovare o di descriverlo.]`);
        totalChars += 300;
      }
    } else if (r.intent.type === 'extract_document') {
      const d = r.data as DocumentExtractionResult;
      if (d.ok && (d.text ?? '').trim().length > 0) {
        const slice = d.text!.slice(0, 8_000);
        parts.push(`Testo estratto dal documento allegato${d.pages ? ` (${d.pages.toString()} pagine)` : ''}:`);
        parts.push(slice);
        totalChars += slice.length + 500;
      } else {
        parts.push(`[L'utente HA allegato un documento ma l'estrazione non è riuscita${d.error ? `: ${d.error}` : ''}. NON negare che l'allegato esista.]`);
        totalChars += 300;
      }
    } else {
      const d = r.data as SearchResponse;
      parts.push(`Query: "${d.query}" (via ${d.provider})`);
      // Se il provider ha sintetizzato una risposta (Tavily/Serper answerBox),
      // mettila in evidenza — è già una sintesi LLM-ready.
      if (d.answer) {
        parts.push(`Risposta sintetizzata dal motore di ricerca:`);
        parts.push(d.answer);
        parts.push('');
      }
      parts.push(`Risultati trovati: ${d.results.length.toString()}`);
      if (d.results.length === 0 && !d.answer) {
        parts.push('[Nessun risultato per questa query — informa l\'utente]');
      } else {
        for (let i = 0; i < Math.min(d.results.length, 10); i++) {
          const r2 = d.results[i];
          if (!r2) continue;
          parts.push(`${(i + 1).toString()}. ${r2.title}`);
          parts.push(`   URL: ${r2.url}`);
          parts.push(`   ${r2.snippet}`);
        }
      }
      totalChars += 2_000;
    }
    parts.push('');
  }
  parts.push('═══════════════════════════════════════════════════════════');
  parts.push('FINE CONTESTO WEB. Rispondi usando questi dati.');
  parts.push('═══════════════════════════════════════════════════════════');
  return parts.join('\n');
}
