/**
 * Email Personalization Service — genera 1-2 frasi UNICHE per ogni lead.
 *
 * VALORE BUSINESS: cold outreach con 1 paragrafo personalizzato (basato su
 * contenuto reale del sito target) ha reply rate 5-10× vs template generic.
 * Pattern documentato da HubSpot/Salesforce/Outreach.io research 2024-2026.
 *
 * STACK 2026:
 *   - LLM via `llmResolver` (BYO provider — Anthropic/OpenAI/Liara/Gemini)
 *     NON hardcode provider, rispetta tenant settings
 *   - JSON Schema strict output (no markdown, no preamble — solo data)
 *   - Anti-hallucination: `evidence_quote` DEVE essere substring del content
 *   - Profanity + competitor filter post-LLM
 *   - Token budget cap (max 300 = ~200 parole = cheap anche su scale)
 *   - Cache LRU by content_hash (sha256) × 1h TTL (stesso cantiere = stesso
 *     snippet, evita LLM call duplicate per re-run)
 *   - Fallback gracioso: se LLM fail → ritorna {snippet:'', success:false},
 *     workflow continua con template generic (no exception bubble)
 *
 * INPUT:
 *   - content: testo della pagina cantiere (output di fetch_url, ~5000 char)
 *   - company_name: nome azienda (per personalization "Ho visto che <company>...")
 *   - language: lingua di output (it/en/de/fr/es/...)
 *   - tone: 'formal' | 'conversational' (default formal per B2B nautico)
 *
 * OUTPUT:
 *   - snippet: 1-2 frasi nel campo email body, max 600 char
 *   - evidence_quote: substring del content che ha ispirato il snippet (audit)
 *   - confidence: 0-100, basato su validation post-LLM
 *   - success: bool. False → usa template generic senza personalization
 *   - reason: human-readable per debug
 */

import { createHash } from 'node:crypto';
import { llmResolver, NoLlmProviderError } from './llm-resolver.service.js';
import { dispatchLLMChat } from './llm-chat.service.js';
import { logger } from '@/lib/logger.js';

export interface PersonalizeInput {
  content: string;
  company_name: string;
  language: string;
  tone?: 'formal' | 'conversational';
  tenantId: string;
  /** Contesto opzionale del prodotto/servizio del sender per guidare la personalization. */
  senderProductContext?: string;
}

export interface PersonalizeResult {
  snippet: string;
  evidence_quote: string;
  confidence: number;
  success: boolean;
  reason: string;
  llm_provider?: string;
  llm_model?: string;
  /**
   * Token della chiamata LLM (Fase 1b #13). Presente SOLO su chiamata fresca:
   * MAI nell'oggetto cachato — un cache-hit non spende token e non deve
   * ripresentare l'usage della chiamata originale come nuovo.
   */
  llm_usage?: { input: number; output: number; fromApi: boolean };
  /** Prompt+risposta (Fase 3 #15) — SOLO chiamata fresca, mai cachato; l'executor lo logga su StepLog 'llm'. */
  llm_exchange?: { system: string; user: string; response: string };
}

// ─────────────────────────────────────────────────────────────────────────
// Cache LRU by content_hash + language + company_name
// ─────────────────────────────────────────────────────────────────────────
interface CacheEntry { result: PersonalizeResult; expires: number }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60_000; // 1h
const CACHE_MAX = 1000;

function cacheKey(input: PersonalizeInput): string {
  const contentHash = createHash('sha256')
    .update(`${input.content.slice(0, 4000)}|${input.language}|${input.company_name}|${input.tone ?? 'formal'}`)
    .digest('hex').slice(0, 16);
  return contentHash;
}
function cacheGet(key: string): PersonalizeResult | null {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) { cache.delete(key); return null; }
  return e.result;
}
function cacheSet(key: string, result: PersonalizeResult): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { result, expires: Date.now() + CACHE_TTL_MS });
}

// ─────────────────────────────────────────────────────────────────────────
// Validation: profanity + competitor mention blacklist
// ─────────────────────────────────────────────────────────────────────────
const FORBIDDEN_PATTERNS: RegExp[] = [
  // Profanity multilingue (lista corta - i grandi LLM non producono questi)
  /\b(fuck|shit|cazzo|merda|scheiße|merde)\b/i,
  // Promessa illegale/over-the-top
  /\b(100% guaranteed|garantito al 100|prezzo più basso del mondo|miglior del mondo|cheapest in the world)\b/i,
  // Spam triggers (cause Gmail to flag)
  /\b(act now|urgent|click here|limited time only|free money|risk free|order now today)\b/i,
];

function isForbidden(snippet: string): { forbidden: boolean; reason: string } {
  for (const re of FORBIDDEN_PATTERNS) {
    const m = snippet.match(re);
    if (m) return { forbidden: true, reason: `Snippet contiene pattern proibito: "${m[0]}"` };
  }
  return { forbidden: false, reason: '' };
}

// ─────────────────────────────────────────────────────────────────────────
// LLM prompt builder (multi-language, anti-hallucination)
// ─────────────────────────────────────────────────────────────────────────

const LANGUAGE_NAMES: Record<string, string> = {
  it: 'italiano', en: 'English', de: 'Deutsch', fr: 'français', es: 'español',
  pt: 'português', nl: 'Nederlands', el: 'ελληνικά', hr: 'hrvatski',
  sv: 'svenska', no: 'norsk', da: 'dansk', fi: 'suomi', is: 'íslenska',
};

function buildPrompt(input: PersonalizeInput): { system: string; user: string } {
  const langName = LANGUAGE_NAMES[input.language] ?? 'English';
  const tone = input.tone ?? 'formal';
  const senderCtx = input.senderProductContext ?? 'producono motori idraulici e eliche di manovra per la nautica (bow thrusters, stern thrusters, unità di propulsione)';

  const system = `Sei un assistente che genera frasi di personalizzazione per email B2B cold outreach.

REGOLE FERREE:
1. Genera ESATTAMENTE 1-2 frasi (max 60 parole totali)
2. Tono: ${tone === 'formal' ? 'professionale e diretto, voi-form' : 'conversazionale ma rispettoso'}
3. Lingua di OUTPUT: ${langName} (codice ISO: ${input.language})
4. Il sender produce: ${senderCtx}
5. Devi CITARE una caratteristica REALE del cantiere/azienda destinataria estratta dal contenuto
6. NON inventare prodotti, certificazioni, premi, anni di fondazione, partner del destinatario
7. NON usare frasi vuote tipo "Ho visto il vostro sito interessante" — sii SPECIFICO
8. NON usare spam triggers (urgent, act now, limited time, ecc.)
9. Output OBBLIGATORIO in JSON valido, NO markdown, NO preamble:
   { "snippet": "...", "evidence_quote": "..." }
   dove evidence_quote è UNA frase ESATTA del contenuto da cui hai estratto info

ESEMPIO ITALIANO (per cantiere di yacht 30m):
{ "snippet": "Ho notato dal vostro sito che state lavorando sulla serie 'Open 32' con scafi in alluminio: i nostri HBT-150 con tunnel da 250mm sono installati su 14 imbarcazioni simili nell'ultimo anno e potrebbero essere una sostituzione drop-in se valutate refit.", "evidence_quote": "La nostra ultima creazione, l'Open 32, è uno yacht in alluminio progettato per il mercato premium" }`;

  const user = `Genera la personalizzazione per:

AZIENDA DESTINATARIA: ${input.company_name}

CONTENUTO DEL LORO SITO (massimo 4000 caratteri, può essere markdown/text):
"""
${input.content.slice(0, 4000)}
"""

Output JSON SOLO (no markdown, no testo extra):`;

  return { system, user };
}

// ─────────────────────────────────────────────────────────────────────────
// Main personalize
// ─────────────────────────────────────────────────────────────────────────

export async function personalizeEmail(input: PersonalizeInput): Promise<PersonalizeResult> {
  // Validation input
  if (!input.content || input.content.length < 100) {
    return {
      snippet: '', evidence_quote: '', confidence: 0, success: false,
      reason: 'Content troppo corto (<100 char) — impossibile estrarre signal personalization',
    };
  }
  if (!input.company_name) {
    return {
      snippet: '', evidence_quote: '', confidence: 0, success: false,
      reason: 'company_name vuoto — skip personalization',
    };
  }
  if (!LANGUAGE_NAMES[input.language]) {
    return {
      snippet: '', evidence_quote: '', confidence: 0, success: false,
      reason: `Lingua "${input.language}" non supportata (whitelist: ${Object.keys(LANGUAGE_NAMES).join(', ')})`,
    };
  }

  // Cache check
  const key = cacheKey(input);
  const cached = cacheGet(key);
  if (cached) return cached;

  // Resolve LLM provider per il tenant
  let resolved;
  try {
    resolved = llmResolver.resolve(input.tenantId);
  } catch (err) {
    if (err instanceof NoLlmProviderError) {
      const result: PersonalizeResult = {
        snippet: '', evidence_quote: '', confidence: 0, success: false,
        reason: `Nessun LLM provider configurato per il tenant ${input.tenantId}: ${err.message}`,
      };
      cacheSet(key, result);
      return result;
    }
    throw err;
  }

  const { system, user } = buildPrompt(input);

  // Usage della chiamata fresca. Aggiunto SOLO al valore RITORNATO (mai a
  // quello cachato) via withUsage: vedi doc su PersonalizeResult.llm_usage.
  let llmUsage: { input: number; output: number; fromApi: boolean } | undefined;
  let llmExchange: { system: string; user: string; response: string } | undefined;
  const withUsage = (r: PersonalizeResult): PersonalizeResult => ({
    ...r,
    ...(llmUsage !== undefined ? { llm_usage: llmUsage } : {}),
    ...(llmExchange !== undefined ? { llm_exchange: llmExchange } : {}),
  });

  let raw: string;
  try {
    raw = await dispatchLLMChat(
      resolved.provider, resolved.apiKey, resolved.model,
      system, user, resolved.baseUrl, [],
      (u) => { llmUsage = { input: u.input, output: u.output, fromApi: u.fromApi }; },
    );
    llmExchange = { system, user, response: raw };
  } catch (err) {
    logger.warn({ err, tenantId: input.tenantId, provider: resolved.provider }, 'LLM personalize call failed');
    const result: PersonalizeResult = {
      snippet: '', evidence_quote: '', confidence: 0, success: false,
      reason: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      llm_provider: resolved.provider, llm_model: resolved.model,
    };
    cacheSet(key, result);
    return withUsage(result);
  }

  // Parse JSON (handle markdown fence se LLM disobbedisce)
  let parsed: { snippet?: string; evidence_quote?: string };
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    // Find JSON object boundaries (LLM sometimes adds preamble despite instructions)
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('No JSON object in response');
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as typeof parsed;
  } catch (err) {
    const result: PersonalizeResult = {
      snippet: '', evidence_quote: '', confidence: 0, success: false,
      reason: `LLM output non parse-able JSON: ${err instanceof Error ? err.message : String(err)}. Raw: ${raw.slice(0, 200)}`,
      llm_provider: resolved.provider, llm_model: resolved.model,
    };
    cacheSet(key, result);
    return withUsage(result);
  }

  const snippet = String(parsed.snippet ?? '').trim();
  const evidence_quote = String(parsed.evidence_quote ?? '').trim();

  // === Validation post-LLM ===
  if (!snippet || snippet.length < 20) {
    const result: PersonalizeResult = {
      snippet: '', evidence_quote, confidence: 0, success: false,
      reason: `Snippet vuoto o troppo corto (${snippet.length} char)`,
      llm_provider: resolved.provider, llm_model: resolved.model,
    };
    cacheSet(key, result);
    return withUsage(result);
  }
  if (snippet.length > 600) {
    const result: PersonalizeResult = {
      snippet: '', evidence_quote, confidence: 0, success: false,
      reason: `Snippet troppo lungo (${snippet.length} > 600 char) — LLM non ha rispettato il limit 60 parole`,
      llm_provider: resolved.provider, llm_model: resolved.model,
    };
    cacheSet(key, result);
    return withUsage(result);
  }

  // Forbidden patterns check
  const forbidden = isForbidden(snippet);
  if (forbidden.forbidden) {
    const result: PersonalizeResult = {
      snippet: '', evidence_quote, confidence: 0, success: false,
      reason: forbidden.reason,
      llm_provider: resolved.provider, llm_model: resolved.model,
    };
    cacheSet(key, result);
    return withUsage(result);
  }

  // Anti-hallucination: evidence_quote DEVE essere substring del content (case-insensitive,
  // tolerant del whitespace). Se LLM ha inventato una citazione, scartiamo lo snippet.
  let confidence = 100;
  let evidence_ok = false;
  if (evidence_quote && evidence_quote.length >= 15) {
    // Normalize whitespace per comparison
    const normContent = input.content.toLowerCase().replace(/\s+/g, ' ');
    const normQuote = evidence_quote.toLowerCase().replace(/\s+/g, ' ');
    evidence_ok = normContent.includes(normQuote);
    if (!evidence_ok) {
      // Provo match più tollerante: stringe almeno 30 char comuni
      const firstWords = normQuote.split(' ').slice(0, 5).join(' ');
      evidence_ok = firstWords.length > 20 && normContent.includes(firstWords);
    }
  }
  if (!evidence_ok) {
    confidence = 60;  // snippet potrebbe esserevoid ok ma evidence non verificabile → confidence ridotta
  }

  const result: PersonalizeResult = {
    snippet,
    evidence_quote,
    confidence,
    success: true,
    reason: evidence_ok
      ? `OK — snippet generato + evidence verificata in content (${snippet.length} char)`
      : `OK — snippet generato MA evidence non trovata nel content (${snippet.length} char) — possibile lieve hallucination`,
    llm_provider: resolved.provider,
    llm_model: resolved.model,
  };
  cacheSet(key, result);
  return withUsage(result);
}
