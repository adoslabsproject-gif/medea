/**
 * agent_legal_compliance executor — IT/EU compliance analysis.
 *
 * Out-of-the-box: NESSUNA dipendenza da KB esterno. Le normative chiave (GDPR,
 * eIDAS, AI Act, DPR 445, Codice Consumo, e-Privacy) sono inline nel system
 * prompt via LEGAL_KNOWLEDGE_INLINE (file separato per rispettare cap 250 righe).
 *
 * Pipeline:
 *  1. chunkDocument → array chunk semantici
 *  2. Liara LLM per chunk con system prompt + compendio inline (default)
 *     o tool searchKnowledge collection legal_kb_it_eu (opt-in via useExternalKb)
 *  3. dedupFindings + applySeverityFloor + computeScore
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@flowforge/nodes-stdlib';
import { logLlmExchange } from '@flowforge/nodes-stdlib';
import { dispatchLLMChat, type LlmTokenUsage, type TokenUsageListener } from '@/services/llm-chat.service.js';
import { llmResolver, type ResolvedLlm } from '@/services/llm-resolver.service.js';
import {
  LEGAL_KNOWLEDGE_INLINE,
  chunkDocument, dedupFindings, applySeverityFloor, computeScore,
  MIN_DOC_CHARS, MAX_DOC_CHARS,
  type Finding, type Recommendation,
} from './legal-compliance.knowledge.js';

interface AnalyzeResponse {
  findings?: Finding[];
  recommendations?: Recommendation[];
  summary?: string;
  detectedType?: string;
}

interface AnalyzeCtx {
  frameworks: string;
  documentType: string;
  jurisdiction: string;
}

/**
 * Fase 2 (#14): la chiamata passa da `llmResolver` + `dispatchLLMChat`
 * (gateway metered, Liara-da-settings default, BYOK override) — PRIMA colpiva
 * `LIARA_URL "v1 complete"` diretto: route inesistente in apps/liara + 401 dal
 * middleware internalAuth → il nodo cadeva SEMPRE nel ramo warnings senza
 * produrre findings. Il listener propaga l'usage per `output._llm`.
 */
async function analyzeChunkViaLlm(
  chunk: string,
  ctx: AnalyzeCtx,
  resolved: ResolvedLlm,
  onUsage: TokenUsageListener,
  logMeta: { context: unknown; phase: string; logSystem: boolean },
): Promise<AnalyzeResponse> {
  const sysPrompt =
    `Sei un avvocato esperto compliance IT/EU. Analizza testo legale contro: ${ctx.frameworks}. ` +
    `Tipo documento: ${ctx.documentType}. Giurisdizione: ${ctx.jurisdiction}. ` +
    `Per ogni issue produci: severity (critical/high/medium/low), framework, article (es. "GDPR art.6"), ` +
    `title (IT), excerpt (citazione testuale dal documento), remediation. ` +
    `Cita SEMPRE l'articolo corretto usando il compendio sotto come riferimento. ` +
    `Output JSON: { findings: [...], recommendations: [{ priority: P0|P1|P2, framework, action }], ` +
    `summary: <2-frase>, detectedType: <best guess se "auto"> }\n\n` +
    LEGAL_KNOWLEDGE_INLINE;

  const raw = (await dispatchLLMChat(
    resolved.provider, resolved.apiKey, resolved.model,
    sysPrompt, chunk, resolved.baseUrl, [],
    onUsage, undefined, { maxTokens: 2000, timeoutMs: 90_000 },
  )).trim();
  // Fase 3 (#15): system (col compendio) integrale SOLO al 1° chunk — è
  // identico per tutti; i chunk successivi loggano prompt utente + risposta.
  logLlmExchange(logMeta.context, {
    provider: resolved.provider,
    model: resolved.model || `${resolved.provider}-default`,
    system: logMeta.logSystem ? sysPrompt : '',
    user: chunk,
    response: raw,
    phase: logMeta.phase,
  });
  const jsonMatch = /\{[\s\S]*\}/.exec(raw);
  if (!jsonMatch) return {};
  try { return JSON.parse(jsonMatch[0]) as AnalyzeResponse; }
  catch { return {}; }
}

export const legalComplianceExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const docText = coerceString(cfg.documentText ?? '').trim();
  if (!docText) throw new Error('agent_legal_compliance: campo "documentText" obbligatorio.');
  if (docText.length < MIN_DOC_CHARS) {
    throw new Error(`agent_legal_compliance: documento troppo corto (${String(docText.length)} char, min ${String(MIN_DOC_CHARS)}).`);
  }
  if (docText.length > MAX_DOC_CHARS) {
    throw new Error(`agent_legal_compliance: documento troppo lungo (${String(docText.length)} char, max ${String(MAX_DOC_CHARS)}).`);
  }

  const frameworks = coerceString(cfg.frameworks ?? 'gdpr,eidas,ai_act');
  const documentType = coerceString(cfg.documentType ?? 'auto');
  const jurisdiction = coerceString(cfg.jurisdiction ?? 'it_eu');
  const severityFloor = coerceString(cfg.severityFloor ?? 'medium');
  const useExternalKb = cfg.useExternalKb === true || coerceString(cfg.useExternalKb ?? 'false') === 'true';

  const chunks = chunkDocument(docText);
  const allFindings: Finding[] = [];
  const allRecommendations: Recommendation[] = [];
  const summaries: string[] = [];
  let detectedType = documentType === 'auto' ? '' : documentType;
  const warnings: string[] = [];

  // Il tool searchKnowledge era una feature del vecchio endpoint "v1 complete"
  // (mai funzionante dal container: 401). Il gateway chat non espone tools →
  // si analizza SEMPRE col compendio inline, dichiarandolo.
  if (useExternalKb) {
    warnings.push('useExternalKb: KB esterno non supportato dal percorso gateway — analisi eseguita col compendio inline.');
  }

  // Provider risolto UNA volta per tutto il documento (Liara default, BYOK override).
  let resolved: ResolvedLlm | null = null;
  try {
    resolved = llmResolver.resolve(context.tenantId);
  } catch (e) {
    warnings.push(`LLM provider non disponibile: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Usage cumulativo su TUTTI i chunk → un solo `_llm` per il nodo.
  let totIn = 0; let totOut = 0; let allFromApi = true; let llmCalls = 0;
  const onUsage = (u: LlmTokenUsage): void => {
    totIn += u.input; totOut += u.output; allFromApi = allFromApi && u.fromApi; llmCalls += 1;
  };

  for (let i = 0; i < chunks.length && resolved !== null; i++) {
    const chunk = chunks[i];
    if (chunk === undefined) continue;
    try {
      const r = await analyzeChunkViaLlm(chunk, { frameworks, documentType, jurisdiction }, resolved, onUsage,
        { context, phase: `chunk ${String(i + 1)}/${String(chunks.length)}`, logSystem: i === 0 });
      if (Array.isArray(r.findings)) allFindings.push(...r.findings.filter((f) => f && typeof f === 'object'));
      if (Array.isArray(r.recommendations)) allRecommendations.push(...r.recommendations);
      if (typeof r.summary === 'string') summaries.push(r.summary);
      if (!detectedType && typeof r.detectedType === 'string') detectedType = r.detectedType;
    } catch (e) {
      warnings.push(`chunk ${String(i + 1)}/${String(chunks.length)} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const filtered = applySeverityFloor(dedupFindings(allFindings), severityFloor);
  const score = computeScore(filtered);

  return {
    output: {
      score,
      findings: filtered,
      frameworks: frameworks.split(',').map((s) => s.trim()),
      recommendations: allRecommendations.slice(0, 20),
      summary: summaries.join(' ').slice(0, 1000),
      detectedType: detectedType || 'unknown',
      chunksProcessed: chunks.length,
      knowledgeMode: 'inline_compendium',
      warnings,
      checkedAt: new Date().toISOString(),
      // Fase 2 (#14): usage standard cross-nodo, cumulativo sui chunk.
      ...(llmCalls > 0 && resolved !== null ? {
        _llm: {
          inputTokens: totIn,
          outputTokens: totOut,
          model: resolved.model || `${resolved.provider}-default`,
          provider: resolved.provider,
          fromApi: allFromApi,
        },
      } : {}),
    },
    durationMs: Date.now() - start,
  };
};
