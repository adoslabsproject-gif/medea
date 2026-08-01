/**
 * @flowforge/nodes-ai-agents — curated AI specialist agents as workflow nodes.
 *
 * Each agent is an LLM call with a carefully crafted system prompt that
 * specializes it for one job. Compared to a generic AI node, an agent:
 *   - Hides the system prompt (the user only provides input)
 *   - Returns structured output where applicable
 *   - Has guardrails specific to its domain
 *
 * Provider routing: each node accepts a `provider` field. The executor
 * dispatches to the matching LLM SDK call.
 */

import type { NodeModule, NodeExecutor } from '@flowforge/nodes-stdlib';
// Fase 3 (#15): prompt COMPLETO (system incluso) + risposta → StepLog 'llm'.
import { logLlmExchange } from '@flowforge/nodes-stdlib';

// 2026-06-04 audit gap closure: 8 fetch a provider LLM erano nudi (no
// timeout, no breaker). Un provider down = workflow appeso forever.
// Pattern unificato: safeFetchWithRedirects + executeWithHostBreaker.
import { executeWithHostBreaker } from '@flowforge/nodes-stdlib';
import { safeFetchWithRedirects, readJsonCapped, readTextTruncated, internalGatewayTrustedHost } from '@flowforge/safe-fetch';

// Fase 1a (#12): ogni agent_* espone `output._llm` (token in/out, modello,
// provider, fromApi). Helper in modulo separato (llm-usage.ts, no-monoliti).
import { buildAgentUsage, sumAgentUsage, attachAgentUsage } from './llm-usage.js';
import type { AgentLlmUsage, ApiTokenCounts } from './llm-usage.js';
import { resolveLlmConfig } from './llm-config.js';

export type { AgentLlmUsage } from './llm-usage.js';

/** Estratto d'errore anti-OOM: tronca a 8KB in streaming poi 200 char (era
 *  (await res.text()).slice(0,200) = body intero in RAM prima dello slice). */
async function errBody(res: Response): Promise<string> {
  return (await readTextTruncated(res, 8192)).text.slice(0, 200);
}

const LLM_PROVIDER_TIMEOUT_MS = 60_000;

async function gatewayFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; allowDockerNet?: boolean; allowedHosts?: readonly string[] },
): Promise<Response> {
  return executeWithHostBreaker(url, () => {
    const opts: Parameters<typeof safeFetchWithRedirects>[1] = {
      ...(init.method ? { method: init.method } : {}),
      ...(init.headers ? { headers: init.headers } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
      timeoutMs: LLM_PROVIDER_TIMEOUT_MS,
      ...(init.allowDockerNet ? { allowDockerNet: true } : {}),
      ...(init.allowedHosts ? { allowedHosts: init.allowedHosts } : {}),
    };
    return safeFetchWithRedirects(url, opts);
  });
}

// Fase 2 (#14): internalGatewayTrustedHost è diventata SSOT condivisa in
// @flowforge/safe-fetch (serve anche ai nodi stdlib che parlano col gateway).
// Re-export per back-compat: era nata qui (fix SSRF nLA_liara) e i test/import
// esistenti la referenziano da questo package.
export { internalGatewayTrustedHost } from '@flowforge/safe-fetch';

interface AgentDefinition {
  id: string;
  label: string;
  icon: string;
  color: string;
  description: string;
  systemPrompt: string;
  outputFormat?: 'text' | 'json';
  /** Alias di discoverability (vedi NodeDefSchema.searchAliases). */
  searchAliases?: string[];
}

const AGENTS: AgentDefinition[] = [
  {
    id: 'agent_security_audit',
    label: 'Agent: Security Audit',
    icon: 'shield-alert',
    color: '#dc2626',
    description:
      'Agent LLM senior security engineer: audita codice/config contro OWASP Top 10, injection vector (SQLi/XSS/SSRF/CSRF), ' +
      'secret leakage in plaintext, weak crypto (MD5/SHA1/DES), supply-chain risks (deprecated deps, typosquat). ' +
      'Output JSON: { findings: [{ severity, title, line, remediation }], summary }. Severity: critical/high/medium/low. ' +
      'Use case: pre-merge PR review automatico, audit periodico repo legacy, ' +
      'CI gate su pattern vietati, due diligence code acquisition.',
    systemPrompt: 'You are a senior security engineer. Audit the input for OWASP Top 10 vulnerabilities, injection vectors, secrets in plaintext, weak crypto, and supply-chain risks. Respond as JSON: {"findings":[{"severity":"critical|high|medium|low","title":"...","line":N,"remediation":"..."}],"summary":"..."}',
    outputFormat: 'json',
  },
  {
    id: 'agent_code_reviewer',
    label: 'Agent: Code Reviewer',
    icon: 'git-pull-request',
    color: '#8b5cf6',
    description:
      'Agent LLM senior code reviewer: rileva bug, anti-pattern, perf issue, missing error handling, miglioramenti idiomatici lingua-specifici. ' +
      'Output JSON: { issues: [{ severity (blocker/major/minor), file, line, message, suggestion }], overall_grade (A-F), summary }. ' +
      'Use case: PR review automatico pre-merge GitHub/GitLab, training junior dev con feedback dettagliato, ' +
      'audit refactoring legacy, gate CI per blocker severity, code quality dashboard team.',
    systemPrompt: 'You are a senior code reviewer. Review the input code for bugs, anti-patterns, performance issues, missing error handling, and idiomatic improvements. Respond as JSON: {"issues":[{"severity":"blocker|major|minor","file":"...","line":N,"message":"...","suggestion":"..."}],"overall_grade":"A|B|C|D|F","summary":"..."}',
    outputFormat: 'json',
  },
  {
    id: 'agent_data_analyst',
    label: 'Agent: Data Analyst',
    icon: 'bar-chart',
    color: '#0ea5e9',
    description:
      'Agent LLM data analyst: analizza dati tabulari (JSON/CSV) ed estrae distribuzioni per colonna, ' +
      'outlier (metodo IQR), correlazioni tra colonne (Pearson r), missing-value pattern, trend chiave. ' +
      'Output JSON: { columns: [{ name, type, missing, stats }], correlations: [{ a, b, r }], anomalies, insights }. ' +
      'Use case: EDA preliminare su CSV uploaded, anomaly detection metriche business, ' +
      'pre-processing dataset per ML, audit qualità dati post-import legacy.',
    systemPrompt: 'You are a data analyst. Given tabular data, identify: distribution shape per column, outliers (IQR method), correlations between columns, missing-value patterns, key trends. Respond as JSON: {"columns":[{"name":"...","type":"...","missing":N,"stats":{}}],"correlations":[{"a":"...","b":"...","r":0.0}],"anomalies":[...],"insights":[...]}',
    outputFormat: 'json',
  },
  {
    id: 'agent_summarizer',
    label: 'Agent: Summarizer',
    searchAliases: ['riassumi', 'riassunto', 'summary', 'tldr'],
    icon: 'file-text',
    color: '#22c55e',
    description:
      'Agent LLM (usa il provider configurato in Settings → AI Providers: Anthropic, OpenAI, Gemini, Mistral, Groq, OpenRouter, Ollama o Liara) che produce un summary strutturato 3-tier: TL;DR (1 frase), 5 bullet point, paragrafo (~150 word). ' +
      'Preserva named entities (people/orgs/dates/amounts/tech terms) verbatim — no parafrasi. Output JSON typed. ' +
      'Use case: digest email lunghe, riassunto articoli RSS per newsletter, brief meeting notes, abstract documenti legali/PDF. ' +
      'Token budget controllato. Compatibile output→input chain per filter/route downstream.',
    systemPrompt: 'You are a precise summarizer. Produce a 3-tier summary of the input: (1) one-sentence TL;DR, (2) 5 key bullet points, (3) detailed paragraph (~150 words). Preserve all named entities (people, organizations, dates, monetary values, technical terms) verbatim. Respond as JSON: {"tldr":"...","bullets":[...],"detailed":"...","entities":{"people":[],"orgs":[],"dates":[],"amounts":[],"tech":[]}}',
    outputFormat: 'json',
  },
  {
    id: 'agent_translator',
    label: 'Agent: Translator',
    searchAliases: ['traduci', 'traduzione', 'translate', 'lingua'],
    icon: 'languages',
    color: '#a855f7',
    description:
      'Agent LLM translator professionale: traduce input nella lingua target (config.targetLanguage IT/EN/DE/FR/ES/PT/...). ' +
      'Preserva markdown, code blocks, URL, named entities, tone (formal/informal). Input misto-lingua → traduce solo source language. ' +
      'Output text plain (no JSON wrapper). Engine sceglie modello cheaper per token budget. ' +
      'Use case: i18n contenuti email/website, traduzione ticket support multi-lingua, ' +
      'localizzazione descrizioni prodotto, traduzione documenti legali (con disclaimer).',
    systemPrompt: 'You are a professional translator. Translate the input into the target language specified in the targetLanguage config. Preserve markdown formatting, code blocks, URLs, named entities, and tone. If the input mixes languages, translate only the source language portion. Respond with the translated text only, no commentary.',
    outputFormat: 'text',
  },
  {
    id: 'agent_classifier',
    label: 'Agent: Classifier',
    icon: 'tag',
    color: '#f59e0b',
    description:
      'Agent LLM classifier: assegna l\'input a una delle label custom (config.labels). Output: { label, confidence 0-1, alternatives[] }. ' +
      'Se nessuna label matcha → fallback "other" con score basso. Confidence usable in if/switch downstream per threshold gating. ' +
      'Use case: triage email (lead/support/spam/ordine), classificazione ticket per team, ' +
      'routing per categoria prodotto e-commerce, content moderation pre-pubblicazione, ' +
      'tagging automatico documenti per archivio.',
    systemPrompt: 'You are a classifier. Given input text and a list of candidate labels (in config.labels), assign the most appropriate label. If none fit well, label as "other". Respond as JSON: {"label":"...","confidence":0.0-1.0,"alternatives":[{"label":"...","confidence":0.0}]}',
    outputFormat: 'json',
  },
  {
    id: 'agent_extractor',
    label: 'Agent: Entity Extractor',
    searchAliases: ['estrai', 'campi', 'strutturato', 'parse'],
    icon: 'crosshair',
    color: '#06b6d4',
    description:
      'Agent LLM entity extractor: dato testo non strutturato + JSON schema (config.schema), estrae fields conformi. ' +
      'Campi mancanti → null. Campi multi-value → array. Output JSON typed direttamente usabile downstream. ' +
      'Use case: parse email ordine (importo/cliente/sku/qty), estrazione anagrafica da CV, ' +
      'invoice extraction (numero/data/importo/IVA/righe), contatti da firma email, ' +
      'parametri da messaggio chat (date/luoghi/persone) per scheduling/CRM.',
    systemPrompt: 'You are an entity extractor. Given input text and a JSON schema in config.schema, extract the fields conforming to the schema. If a field is not present, set it to null. If a field allows multiple, return an array. Respond as JSON matching the requested schema.',
    outputFormat: 'json',
  },
  {
    id: 'agent_intent_router',
    label: 'Agent: Intent Router',
    icon: 'git-fork',
    color: '#ec4899',
    description:
      'Agent LLM intent router per workflow customer-facing: classifica user message contro lista intents (config.intents), ' +
      'output { intent, confidence, reasoning }. Se nessun match → "fallback". ' +
      'Pair with logic_switch downstream: ogni intent diventa una branch separata del workflow. ' +
      'Use case: chatbot multi-intent (order/refund/info/cancel → 4 rami), routing email per dipartimento, ' +
      'voice assistant action dispatcher, ticket support priority/category auto-tag.',
    systemPrompt: 'You are an intent classifier for a customer-facing workflow. Given the user message and a list of intent names (config.intents), return the most likely intent. If none fit, return "fallback". Respond with JSON: {"intent":"...","confidence":0.0-1.0,"reasoning":"..."}',
    outputFormat: 'json',
  },
  {
    id: 'agent_html_extractor',
    label: 'Agent: HTML Extractor (AI)',
    icon: 'wand-2',
    color: '#a855f7',
    description: 'Estrai dati strutturati da HTML descrivendo in linguaggio naturale cosa vuoi (NO selettori CSS). L\'AI legge il DOM + l\'instruction → ritorna JSON conforme allo schema specificato. Top 2026: scraping AI-powered che resiste a cambi di layout (selettori CSS si rompono, l\'AI no).',
    systemPrompt: 'Sei un estrattore intelligente di dati da HTML. Ricevi: (1) il body HTML completo della pagina; (2) un\'instruction in linguaggio naturale che descrive COSA estrarre (es. "titolo articolo, autore, data pubblicazione, lista commenti"); (3) un JSON schema (config.schema) che definisce la forma dell\'output. Analizza il DOM, capisci la struttura, estrai i campi richiesti. Se un campo non esiste set null. Per liste di items ritorna array. NON inventare dati: se non c\'è, null. Rispondi SOLO JSON valido conforme allo schema, niente prefissi tipo "Ecco i dati:".',
    outputFormat: 'json',
  },
  {
    id: 'agent_selector_inference',
    label: 'Agent: Selector Inference (AI)',
    icon: 'crosshair',
    color: '#ec4899',
    description: 'Genera selettori CSS/XPath automaticamente da 1-2 esempi label-value. Tu fornisci HTML + esempi tipo {"price": "€42.50"} → l\'AI genera selettori robusti che catturano gli stessi valori. Output usabile direttamente in action_html_select. Self-healing scraping (rigenera quando il sito cambia).',
    systemPrompt: 'Sei un generatore esperto di selettori CSS per scraping. Ricevi: (1) HTML completo della pagina; (2) una mappa di esempi {fieldName: expectedValue} dove l\'utente dice "questo campo deve produrre questo valore" (es. {"price": "€42.50", "title": "iPhone 16 Pro"}). Analizza il DOM, trova gli elementi che contengono ESATTAMENTE quei valori, e ritorna selettori CSS robusti (preferisci classi semantiche o attributi data-* sopra :nth-child quando possibile). Per ogni campo proponi: il selettore primario + 1-2 fallback. Output JSON: {"selectors": {<fieldName>: {"primary": "...", "fallbacks": [...], "extract": "text|attr", "attr": "..."}}, "confidence": 0.0-1.0, "notes": "..."}.',
    outputFormat: 'json',
  },
  {
    id: 'agent_validator',
    label: 'Agent: Schema Validator',
    icon: 'shield-check',
    color: '#10b981',
    description: 'Validate structured input against JSON Schema + business rules. Returns valid/errors/normalized. Top 2026: schema, custom rules, strict mode, error path, normalize-on-fix.',
    systemPrompt: 'Sei un validatore strict di dati strutturati. Ricevi: (1) input JSON da validare; (2) schema JSON Schema (config.schema) — type/properties/required/enum/pattern/min/max; (3) opzionali regole business (config.businessRules) in linguaggio naturale; (4) flag config.strictMode (true = reject extra fields, false = allow). \n\nValuta in 3 step:\n  A. Schema-shape: tutti i required ci sono? tipi giusti? pattern/enum rispettati?\n  B. Business rules: ogni regola applicata, raccolta violazioni.\n  C. Se config.normalize=true: applica fix triviali (trim string, lowercase email, parse number da string numerica). Niente fix che cambino semantica.\n\nRispondi SOLO JSON: {"valid": bool, "errors": [{"path":"$.field","rule":"required|type|pattern|enum|min|max|business","message":"..."}], "normalized": <object o null>, "summary":"breve riassunto IT"}',
    outputFormat: 'json',
  },
];

/** Shape usage OpenAI-format (liara/openai/openrouter/mistral/groq). */
interface OpenAiUsage { prompt_tokens?: number; completion_tokens?: number }
const openAiCounts = (u: OpenAiUsage | undefined): ApiTokenCounts => ({ input: u?.prompt_tokens, output: u?.completion_tokens });

/**
 * Una chiamata LLM completa. Ritorna il testo della risposta + l'usage token
 * della chiamata (dai campi API del provider quando presenti, stima altrimenti
 * — vedi buildAgentUsage). Il testo è IDENTICO a prima della Fase 1a: l'usage
 * è un canale aggiuntivo, non tocca il contenuto.
 */
async function dispatchLLM(provider: string, apiKey: string, model: string, system: string, user: string, baseUrl?: string): Promise<{ text: string; usage: AgentLlmUsage }> {
  switch (provider) {
    case 'liara': {
      // Free-tier hosted model (Qwen3 32B + NHA-v1 LoRA) — no API key needed.
      // Reachable only from the FlowForge server (IP-allowlisted at the host).
      //
      // Qwen3 has a "thinking" mode enabled by default that emits <think>...</think>
      // before the answer. For structured agent tasks this adds 10-30s of latency
      // without value. We disable it by prefixing /no_think (Qwen3 convention) and
      // asking vLLM to stop on the closing </think> tag if any thinking leaks in.
      // Liara base URL precedence: caller override > env > NHA default.
      // We read env directly here because this package is browser-safe and
      // can't import from apps/runtime/src/config.ts. The runtime callers
      // who want to override should pass `baseUrl` via context.llmProviders.
      const internalGateway = typeof process !== 'undefined' && process.env.FLOWFORGE_LIARA_BASE_URL
        ? process.env.FLOWFORGE_LIARA_BASE_URL.replace(/\/$/, '')
        : undefined;
      const liaraDefault = internalGateway ?? 'https://liara.nothumanallowed.com';
      const base = baseUrl ?? liaraDefault;
      // Path = `/chat/completions` SENZA `/v1`: il gateway Liara (FLOWFORGE_LIARA_BASE_URL
      // include già `/api/v1/llm`) instrada lì. Con `/v1/chat/completions` usciva un path
      // doppio `…/api/v1/llm/v1/chat/completions` → 404 (verificato empiricamente dal
      // container: /v1→404, /chat/completions→200). Identico alla chat (llm-chat.service).
      const url = `${base}/chat/completions`;
      // SSRF: il GATEWAY INTERNO di sistema (FLOWFORGE_LIARA_BASE_URL, es. 172.20.0.1:3006
      // sulla bridge docker) è traffico container→gateway fidato → IP privato by-design.
      // Esente dal guard per host:porta ESATTO, deciso per CONFRONTO DI ORIGIN con il
      // gateway: copre sia il default sia il caso (reale) in cui il runtime passa il
      // baseUrl del gateway ESPLICITAMENTE via context.llmProviders (llm-providers.service
      // ritorna baseUrl=liaraBaseUrl() per 'liara'). I BYOK utente hanno origin DIVERSO →
      // restano sotto guard pieno. Coerente con guardCustomBaseUrl della chat (per origin).
      const trustedHost = internalGatewayTrustedHost(base, internalGateway);
      // AUTH: il gateway Liara ESIGE la license come Bearer (senza → 400 "license required").
      // Letta dall'env del container (come la chat, llm-chat.service). BYOK (apiKey) → fallback.
      const licenseKey = typeof process !== 'undefined' ? (process.env.FLOWFORGE_LICENSE_KEY ?? '') : '';
      const authBearer = licenseKey || apiKey;
      const systemNoThink = `/no_think\n${system}`;
      const effectiveModel = model || 'nha-v1';
      const res = await gatewayFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authBearer ? { Authorization: `Bearer ${authBearer}` } : {}),
        },
        body: JSON.stringify({
          model: effectiveModel,
          messages: [{ role: 'system', content: systemNoThink }, { role: 'user', content: user }],
          temperature: 0.7,
          max_tokens: 2048,
          chat_template_kwargs: { enable_thinking: false },
        }),
        ...(trustedHost ? { allowedHosts: [trustedHost] } : {}),
      });
      if (!res.ok) throw new Error(`Liara ${String(res.status)}: ${await errBody(res)}`);
      const data = await readJsonCapped<{ choices?: { message: { content: string } }[]; usage?: OpenAiUsage }>(res);
      const raw = data.choices?.[0]?.message.content ?? '';
      return {
        // Safety: strip any residual <think>...</think> block that may leak through
        text: raw.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim(),
        // Stima sul RAW pre-strip: gli eventuali token di thinking sono stati
        // comunque generati (e contati/billati dal gateway).
        usage: buildAgentUsage({ provider: 'liara', model: effectiveModel, sentSystem: systemNoThink, sentUser: user, receivedText: raw, api: openAiCounts(data.usage) }),
      };
    }
    case 'anthropic': {
      const effectiveModel = model || 'claude-sonnet-4-5';
      const res = await gatewayFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: effectiveModel, max_tokens: 4096, system, messages: [{ role: 'user', content: user }] }),
      });
      if (!res.ok) throw new Error(`Anthropic ${String(res.status)}: ${await errBody(res)}`);
      const data = await readJsonCapped<{ content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } }>(res);
      const text = data.content?.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('') ?? '';
      return {
        text,
        usage: buildAgentUsage({ provider: 'anthropic', model: effectiveModel, sentSystem: system, sentUser: user, receivedText: text, api: { input: data.usage?.input_tokens, output: data.usage?.output_tokens } }),
      };
    }
    case 'openai': {
      const effectiveModel = model || 'gpt-4o-mini';
      const res = await gatewayFetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: effectiveModel, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      if (!res.ok) throw new Error(`OpenAI ${String(res.status)}: ${await errBody(res)}`);
      const data = await readJsonCapped<{ choices?: { message: { content: string } }[]; usage?: OpenAiUsage }>(res);
      const text = data.choices?.[0]?.message.content ?? '';
      return {
        text,
        usage: buildAgentUsage({ provider: 'openai', model: effectiveModel, sentSystem: system, sentUser: user, receivedText: text, api: openAiCounts(data.usage) }),
      };
    }
    case 'openrouter': {
      const effectiveModel = model || 'anthropic/claude-sonnet-4.5';
      const res = await gatewayFetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'X-Title': 'FlowForge' },
        body: JSON.stringify({ model: effectiveModel, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      if (!res.ok) throw new Error(`OpenRouter ${String(res.status)}: ${await errBody(res)}`);
      const data = await readJsonCapped<{ choices?: { message: { content: string } }[]; usage?: OpenAiUsage }>(res);
      const text = data.choices?.[0]?.message.content ?? '';
      return {
        text,
        usage: buildAgentUsage({ provider: 'openrouter', model: effectiveModel, sentSystem: system, sentUser: user, receivedText: text, api: openAiCounts(data.usage) }),
      };
    }
    case 'ollama': {
      const ollamaBase = baseUrl ?? 'http://localhost:11434';
      const url = `${ollamaBase}/api/chat`;
      // Ollama spesso è loopback (localhost:11434): allowDockerNet non esenta il loopback
      // → esenzione per host esatto (endpoint da config/env di sistema, non payload utente).
      const ollamaHosts = internalGatewayTrustedHost(url, ollamaBase);
      const effectiveModel = model || 'llama3.2';
      const res = await gatewayFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: effectiveModel, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
        allowDockerNet: true,
        ...(ollamaHosts ? { allowedHosts: [ollamaHosts] } : {}),
      });
      if (!res.ok) throw new Error(`Ollama ${String(res.status)}: ${await errBody(res)}`);
      const data = await readJsonCapped<{ message?: { content?: string }; prompt_eval_count?: number; eval_count?: number }>(res);
      const text = data.message?.content ?? '';
      return {
        text,
        usage: buildAgentUsage({ provider: 'ollama', model: effectiveModel, sentSystem: system, sentUser: user, receivedText: text, api: { input: data.prompt_eval_count, output: data.eval_count } }),
      };
    }
    case 'gemini': {
      const m = model || 'gemini-2.0-flash';
      // API key nell'HEADER x-goog-api-key, NON in query (?key=): una key nell'URL
      // finisce nei log/breaker-key e su redirect cross-host NON viene strippata.
      const res = await gatewayFetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
        }),
      });
      if (!res.ok) throw new Error(`Gemini ${String(res.status)}: ${await errBody(res)}`);
      const data = await readJsonCapped<{ candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }>(res);
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      return {
        text,
        usage: buildAgentUsage({ provider: 'gemini', model: m, sentSystem: system, sentUser: user, receivedText: text, api: { input: data.usageMetadata?.promptTokenCount, output: data.usageMetadata?.candidatesTokenCount } }),
      };
    }
    case 'mistral': {
      const effectiveModel = model || 'mistral-large-latest';
      const res = await gatewayFetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: effectiveModel, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      if (!res.ok) throw new Error(`Mistral ${String(res.status)}: ${await errBody(res)}`);
      const data = await readJsonCapped<{ choices?: { message: { content: string } }[]; usage?: OpenAiUsage }>(res);
      const text = data.choices?.[0]?.message.content ?? '';
      return {
        text,
        usage: buildAgentUsage({ provider: 'mistral', model: effectiveModel, sentSystem: system, sentUser: user, receivedText: text, api: openAiCounts(data.usage) }),
      };
    }
    case 'groq': {
      const effectiveModel = model || 'llama-3.3-70b-versatile';
      const res = await gatewayFetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: effectiveModel, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      if (!res.ok) throw new Error(`Groq ${String(res.status)}: ${await errBody(res)}`);
      const data = await readJsonCapped<{ choices?: { message: { content: string } }[]; usage?: OpenAiUsage }>(res);
      const text = data.choices?.[0]?.message.content ?? '';
      return {
        text,
        usage: buildAgentUsage({ provider: 'groq', model: effectiveModel, sentSystem: system, sentUser: user, receivedText: text, api: openAiCounts(data.usage) }),
      };
    }
    default: throw new Error(`Unknown LLM provider: ${provider}. Supported: anthropic, openai, gemini, mistral, groq, openrouter, ollama.`);
  }
}

// Fase 2 (#14): resolveLlmConfig spostata in llm-config.ts — serve anche a
// tool-loop.ts e importarla da qui creerebbe un ciclo (index importa tool-loop).
export { resolveLlmConfig } from './llm-config.js';
export type { ResolvedLlmConfig } from './llm-config.js';

/**
 * Build a "config preamble" that exposes agent-specific config to the LLM.
 *
 * The system prompts say things like "use config.labels" or "translate to
 * the language in config.targetLanguage", but the LLM has no API to read
 * the JS config object. We serialize the relevant fields as plain text
 * preamble so the model can actually use them.
 */
function buildAgentConfigPreamble(agentId: string, config: Record<string, unknown>): string {
  const lines: string[] = [];
  if (agentId === 'agent_classifier' && typeof config.labels === 'string' && config.labels.trim()) {
    lines.push(`Candidate labels: ${config.labels}`);
  }
  if (agentId === 'agent_extractor' && typeof config.schema === 'string' && config.schema.trim()) {
    lines.push(`Target JSON schema:\n${config.schema}`);
  }
  if (agentId === 'agent_intent_router' && typeof config.intents === 'string' && config.intents.trim()) {
    lines.push(`Candidate intents: ${config.intents}`);
  }
  if (agentId === 'agent_validator') {
    if (typeof config.schema === 'string' && config.schema.trim()) {
      lines.push(`JSON Schema:\n${config.schema}`);
    }
    if (typeof config.businessRules === 'string' && config.businessRules.trim()) {
      lines.push(`\nBusiness rules:\n${config.businessRules}`);
    }
    const strict = config.strictMode === true || config.strictMode === 'true';
    const normalize = config.normalize === true || config.normalize === 'true';
    lines.push(`\nstrictMode=${strict.toString()}, normalize=${normalize.toString()}`);
  }
  if (agentId === 'agent_translator') {
    const custom = typeof config.customTargetLanguage === 'string' ? config.customTargetLanguage.trim() : '';
    const sel = typeof config.targetLanguage === 'string' ? config.targetLanguage.trim() : '';
    const lang = custom || sel || 'italiano';
    lines.push(`Target language: ${lang}`);
  }
  // agent_html_extractor: il system prompt RICHIEDE instruction + schema (config) —
  // senza iniettarli qui il modello vedrebbe solo l'HTML grezzo → output spazzatura.
  if (agentId === 'agent_html_extractor') {
    if (typeof config.instruction === 'string' && config.instruction.trim()) {
      lines.push(`Cosa estrarre (instruction):\n${config.instruction}`);
    }
    if (typeof config.schema === 'string' && config.schema.trim()) {
      lines.push(`\nJSON schema dell'output:\n${config.schema}`);
    }
  }
  // agent_selector_inference: il system prompt RICHIEDE la mappa examples (+ flag
  // preferDataAttrs) — senza iniettarla il modello non sa quali valori cercare.
  if (agentId === 'agent_selector_inference') {
    if (typeof config.examples === 'string' && config.examples.trim()) {
      lines.push(`Esempi {campo: valore atteso}:\n${config.examples}`);
    }
    const preferSemantic = config.preferDataAttrs === undefined || config.preferDataAttrs === true || config.preferDataAttrs === 'true';
    lines.push(`\npreferDataAttrs=${preferSemantic.toString()} (true = preferisci classi semantiche / data-* a :nth-child)`);
  }
  return lines.length > 0 ? `[Agent config]\n${lines.join('\n')}\n\n---\n\n` : '';
}

/**
 * Tronca l'HTML in input a `maxHtmlChars` per gli agent HTML (html_extractor /
 * selector_inference). Il configField PROMETTE "limita HTML inviato all'AI per
 * controllare il costo token": senza questo era aspirazionale (HTML intero →
 * blow-up token/contesto). Clamp difensivo [1000, 100000], default 20000.
 */
function applyHtmlCap(agentId: string, payload: string, config: Record<string, unknown>): string {
  if (agentId !== 'agent_html_extractor' && agentId !== 'agent_selector_inference') return payload;
  const raw = Number(config.maxHtmlChars ?? 20000);
  const max = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1000), 100000) : 20000;
  return payload.length > max ? payload.slice(0, max) : payload;
}

function makeAgentExecutor(agent: AgentDefinition): NodeExecutor {
  return async (config, input, context) => {
    const start = Date.now();
    const resolved = resolveLlmConfig(config, context.llmProviders);
    const extraContext = typeof config.extraContext === 'string' ? config.extraContext : '';
    const userPayload = applyHtmlCap(agent.id, typeof input === 'string' ? input : JSON.stringify(input), config);
    const configPreamble = buildAgentConfigPreamble(agent.id, config);
    const finalUser = [configPreamble, extraContext ? `${extraContext}\n\n---\n\n` : '', userPayload]
      .filter((s) => s.length > 0)
      .join('');

    const llmRes = await dispatchLLM(resolved.provider, resolved.apiKey, resolved.model, agent.systemPrompt, finalUser, resolved.baseUrl);
    const text = llmRes.text;
    // Usage cumulativo del nodo: la 2ª chiamata del repair pass (sotto) si somma.
    let usage = llmRes.usage;
    // Fase 3 (#15): il system prompt è NASCOSTO all'utente per design — il log
    // per-run è l'unico posto dove può vederlo insieme a ciò che è stato inviato.
    logLlmExchange(context, { provider: usage.provider, model: usage.model, system: agent.systemPrompt, user: finalUser, response: text });

    let parsed: unknown = text;
    if (agent.outputFormat === 'json') {
      const first = extractJson(text);
      if (first.ok) {
        parsed = first.value;
      } else {
        // ── JSON repair pass ───────────────────────────────────────────────
        // The LLM produced something that won't parse. Most failures are
        // recoverable: trailing commas, single quotes, missing closing brace,
        // commentary text bracketing the JSON. We do ONE retry with a
        // self-correcting prompt; if that also fails, we surface the raw
        // text + parse error so the workflow can route to an error branch.
        const repairSystem =
          'Sei un riparatore di JSON. Riceverai del testo che doveva essere un JSON valido ' +
          'matching un certo schema, ma ha errori sintattici. Restituisci SOLO il JSON corretto, ' +
          'nient\'altro: niente preambolo, niente backtick, niente spiegazioni.';
        const repairUser =
          `Schema atteso:\n${typeof config.schema === 'string' ? config.schema : '(qualsiasi JSON valido)'}\n\n` +
          `Output ricevuto (NON parseabile, errore: ${first.error}):\n${text}\n\n` +
          'Rispondi con SOLO il JSON corretto.';
        try {
          const repairRes = await dispatchLLM(resolved.provider, resolved.apiKey, resolved.model, repairSystem, repairUser, resolved.baseUrl);
          usage = sumAgentUsage(usage, repairRes.usage);
          logLlmExchange(context, { provider: usage.provider, model: usage.model, system: repairSystem, user: repairUser, response: repairRes.text, phase: 'repair' });
          const second = extractJson(repairRes.text);
          if (second.ok) {
            parsed = second.value;
          } else {
            parsed = { _raw: text, _rawRepaired: repairRes.text, _parseError: second.error };
          }
        } catch (err) {
          parsed = { _raw: text, _parseError: first.error, _repairError: err instanceof Error ? err.message : String(err) };
        }
      }
    }

    return { output: attachAgentUsage(parsed, usage), durationMs: Date.now() - start };
  };
}

/** Extract the first balanced JSON object/array from `text`. Tolerates
 *  surrounding prose (LLMs love to wrap JSON in "Ecco il JSON:\n```json...```").
 *  Returns ok:false when no balanced bracket pair exists or parse fails. */
function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const stripped = text.replace(/```(?:json)?\s*|\s*```/g, '');
  // Try object first, then array.
  const candidates: [string, string][] = [['{', '}'], ['[', ']']];
  for (const [open, close] of candidates) {
    const start = stripped.indexOf(open);
    const end = stripped.lastIndexOf(close);
    if (start >= 0 && end > start) {
      const slice = stripped.slice(start, end + 1);
      try { return { ok: true, value: JSON.parse(slice) }; } catch { /* try next */ }
    }
  }
  return { ok: false, error: 'no balanced JSON found' };
}

/**
 * Per-agent-type config field that the system prompt EXPECTS but isn't a
 * generic provider/model setting. Without these the agent runs with empty
 * config and gives garbage output (the LLM has no way to know what labels
 * the classifier should pick from, what schema the extractor should match,
 * what target language the translator should output).
 */
function agentSpecificFields(agentId: string): ConfigFieldLite[] {
  switch (agentId) {
    case 'agent_classifier':
      return [
        {
          key: 'labels',
          label: 'Etichette possibili',
          type: 'chip-list',
          required: true,
          placeholder: 'es. spam, urgente, supporto, vendita',
          help: 'Lista di etichette tra cui il classifier può scegliere. Una per chip (o incolla virgola-separate).',
        },
      ];
    case 'agent_extractor':
      return [
        {
          key: 'schema',
          label: 'JSON Schema da estrarre',
          type: 'code',
          language: 'json',
          required: true,
          placeholder: '{ "nome": "string", "email": "string", "telefono": "string|null" }',
          help: 'Schema dei campi da estrarre. L\'agent leggerà il testo input e produrrà un JSON che matcha questo schema. Campi non trovati = null.',
        },
      ];
    case 'agent_intent_router':
      return [
        {
          key: 'intents',
          label: 'Intent possibili',
          type: 'chip-list',
          required: true,
          placeholder: 'es. acquisto, supporto, reclamo, info',
          help: 'Lista di intent (categorie di intenzione utente). Se nessuno matcha, l\'agent ritorna "fallback".',
        },
      ];
    case 'agent_translator':
      return [
        {
          key: 'targetLanguage',
          label: 'Lingua di destinazione',
          type: 'select',
          required: true,
          options: ['italiano', 'inglese', 'francese', 'tedesco', 'spagnolo', 'portoghese', 'cinese', 'giapponese', 'arabo', 'russo'],
          defaultValue: 'italiano',
          help: 'Lingua in cui tradurre. Per altre lingue usa il campo "Lingua custom" sotto.',
        },
        {
          key: 'customTargetLanguage',
          label: 'Lingua custom (override)',
          type: 'text',
          required: false,
          placeholder: 'es. catalano, swahili, latino',
          help: 'Se la lingua non è in lista, scrivila qui. Sovrascrive il select sopra.',
        },
      ];
    case 'agent_html_extractor':
      return [
        {
          key: 'instruction',
          label: 'Istruzione (cosa estrarre)',
          type: 'textarea',
          required: true,
          placeholder: 'es. "Titolo articolo, autore, data pubblicazione (formato ISO), lista commenti con nome+testo, prezzo se presente."',
          help: 'Descrivi in italiano (o inglese) quali campi vuoi estrarre dal HTML. L\'AI interpreta + cerca nel DOM senza selettori CSS.',
        },
        {
          key: 'schema',
          label: 'JSON Schema output',
          type: 'code',
          language: 'json',
          required: true,
          placeholder: '{\n  "title": "string",\n  "author": "string",\n  "publishedAt": "string (ISO date)",\n  "price": "number|null",\n  "comments": [{ "name": "string", "text": "string" }]\n}',
          help: 'Schema atteso dell\'output. Tipi: string, number, boolean, array. Usa "|null" per opzionali. L\'AI rispetta lo schema, set null se campo non trovato.',
        },
        {
          key: 'maxHtmlChars',
          label: 'Max HTML char in input',
          type: 'number',
          required: false,
          defaultValue: '20000',
          help: 'Limita HTML inviato all\'AI per controllare costo token. Default 20K (~5K token). Min 1K, max 100K.',
        },
      ];
    case 'agent_selector_inference':
      return [
        {
          key: 'examples',
          label: 'Esempi label → valore atteso',
          type: 'code',
          language: 'json',
          required: true,
          placeholder: '{\n  "title": "iPhone 16 Pro",\n  "price": "€1.249,00",\n  "stock": "Disponibile"\n}',
          help: 'Map di {nomeCampo: valoreAtteso}. L\'AI cerca elementi nel DOM che producono ESATTAMENTE questi valori, poi genera selettori CSS robusti. 2-3 esempi sono ideali (più sono, meglio è il pattern matching).',
        },
        {
          key: 'preferDataAttrs',
          label: 'Preferisci selettori semantici',
          type: 'boolean',
          required: false,
          defaultValue: 'true',
          help: 'Se ON, l\'AI preferisce classi semantiche (.product-title) o data-* attributi (data-testid="title") sopra :nth-child o XPath posizionale (più robusti a cambi layout).',
        },
        {
          key: 'maxHtmlChars',
          label: 'Max HTML char in input',
          type: 'number',
          required: false,
          defaultValue: '20000',
          help: 'Limita HTML inviato all\'AI. Default 20K.',
        },
      ];
    case 'agent_validator':
      return [
        {
          key: 'schema',
          label: 'JSON Schema di validazione',
          type: 'code',
          language: 'json',
          required: true,
          placeholder: '{\n  "type": "object",\n  "required": ["email", "totale"],\n  "properties": {\n    "email": { "type": "string", "pattern": "^[^@]+@[^@]+$" },\n    "totale": { "type": "number", "minimum": 0 },\n    "tipo": { "type": "string", "enum": ["contratto","fattura","preventivo"] }\n  }\n}',
          help: 'JSON Schema standard (draft-07). Definisce type/required/properties/pattern/enum/min/max. L\'agent verifica che l\'input rispetti lo schema e ritorna errors[] con path JSONPath.',
        },
        {
          key: 'businessRules',
          label: 'Regole di business (opzionale)',
          type: 'textarea',
          required: false,
          placeholder: 'es. "Se totale > 10000, customer_vat deve essere presente"\n"Se tipo=preventivo, deadline deve essere entro 30 giorni"',
          help: 'Regole in linguaggio naturale che vanno OLTRE il JSON Schema. L\'agent le applica una per riga.',
        },
        {
          key: 'strictMode',
          label: 'Strict mode (rifiuta campi extra)',
          type: 'boolean',
          required: false,
          defaultValue: 'false',
          help: 'Se true, qualsiasi field non dichiarato nello schema produce un errore. Se false, campi extra sono ignorati.',
        },
        {
          key: 'normalize',
          label: 'Auto-normalize (trim/lowercase/parse)',
          type: 'boolean',
          required: false,
          defaultValue: 'true',
          help: 'Se true, prova fix non-distruttivi prima di failare: trim stringhe, lowercase email, parse number da stringa numerica. Output in "normalized".',
        },
        {
          key: 'onInvalidBehavior',
          label: 'Cosa fare se invalido',
          type: 'select',
          required: false,
          options: ['continue', 'halt', 'branch'],
          defaultValue: 'continue',
          help: 'continue=passa output al next con valid:false; halt=ferma workflow con errore; branch=usa con logic_if su output.valid per branching.',
        },
      ];
    default:
      return [];
  }
}

type ConfigFieldLite = NonNullable<NodeModule['def']['configFields']>[number];

function makeAgentNode(agent: AgentDefinition): NodeModule {
  return {
    def: {
      id: agent.id,
      type: 'ai',
      label: agent.label,
      icon: agent.icon,
      color: agent.color,
      description: agent.description,
      ...(agent.searchAliases ? { searchAliases: agent.searchAliases } : {}),
      configFields: [
        // ── Agent-specific fields FIRST (most relevant, most often required) ──
        ...agentSpecificFields(agent.id),
        // ── LLM provider override (collapsible-ish: optional) ─────────────────
        {
          key: 'provider',
          label: 'LLM provider (opzionale, override)',
          type: 'select',
          required: false,
          options: ['', 'liara', 'anthropic', 'openai', 'gemini', 'mistral', 'groq', 'openrouter', 'ollama'],
          defaultValue: '',
          help: 'Vuoto = usa il default da Settings → AI Providers. Selezionalo SOLO per override locale (es. account diverso per questo nodo).',
        },
        { key: 'apiKey', label: 'API key (override)', type: 'secret', required: false, help: 'Vuoto = usa la chiave di Settings → AI Providers. Liara è free-tier (nessuna key necessaria).' },
        { key: 'model', label: 'Modello (override)', type: 'text', required: false, placeholder: 'es. claude-sonnet-4-5', help: 'Vuoto = default del provider. Es. claude-sonnet-4-5, gpt-4o, gemini-2.0-flash, nha-v1.' },
        { key: 'baseUrl', label: 'Base URL (per Ollama / self-hosted)', type: 'text', required: false, placeholder: 'http://localhost:11434', showIf: { field: 'provider', in: ['ollama'] } },
        { key: 'extraContext', label: 'Contesto aggiuntivo (opzionale)', type: 'expression', required: false, placeholder: 'Esempi di output desiderato, glossario di dominio, regole speciali...', help: 'Testo aggiunto al prompt PRIMA dell\'input. Utile per "few-shot examples" o vincoli che il system prompt non copre.' },
      ],
      vendor: 'flowforge',
      version: '1.1.0',
    },
    executor: makeAgentExecutor(agent),
  };
}

import { agentToolLoopNode } from './tool-loop.js';

export { agentToolLoopNode } from './tool-loop.js';

export const aiAgentNodes: readonly NodeModule[] = [...AGENTS.map(makeAgentNode), agentToolLoopNode];
export const AI_AGENT_DEFINITIONS = AGENTS;
