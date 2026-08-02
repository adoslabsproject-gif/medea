/**
 * agent_video_summarizer executor.
 *
 * Step:
 *  1. POST <whisperEndpoint>/transcribe { videoUrl } → { transcript, segments[], language }
 *  2. POST <visionEndpoint>/describe-frames { videoUrl, intervalSec } → { scenes[]: { tStart, tEnd, description } }
 *  3. Fusion transcript+scenes via llmResolver + dispatchLLMChat (gateway metered) → summary strutturato
 *
 * Whisper/Vision/Liara possono fallire: degradiamo (transcript-only se vision down, etc.)
 * con errore tracciato nei warnings.
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { logLlmExchange } from '@medea/engine-nodes-stdlib';
import { internalAwareFetch, type InternalServiceKey } from '@/lib/internal-service-fetch.js';
import { readJsonCapped, readTextTruncated } from '@/lib/capped-response.js';
import { dispatchLLMChat, type LlmTokenUsage } from '@/services/llm-chat.service.js';
import { llmResolver } from '@/services/llm-resolver.service.js';
import { reportPortalTokenUsage } from '@/services/portal-quota.service.js';

const DEFAULT_WHISPER = 'http://host.docker.internal:5005';
const DEFAULT_VISION = 'http://host.docker.internal:5004';

interface TranscriptSegment {
  tStart: number;
  tEnd: number;
  text: string;
}
interface TranscriptResult {
  transcript: string;
  segments?: TranscriptSegment[];
  language?: string;
}
interface SceneDescription {
  tStart: number;
  tEnd: number;
  description: string;
}
interface VisionResult {
  scenes: SceneDescription[];
  /** Token del ramo vision (Fase 2 #14: lo shim /describe-frames li aggrega dal vLLM, 1 chiamata per frame). */
  usage?: { input?: number; output?: number; fromApi?: boolean };
}
interface SummaryResult {
  tldr: string;
  bullets: string[];
  chapters: { tStart: number; title: string }[];
}

function clamp(raw: unknown, min: number, max: number, def: number): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.floor(n), min), max);
}

async function postJson<T>(
  url: string,
  body: unknown,
  timeoutMs: number,
  scope: { allow: InternalServiceKey },
): Promise<T> {
  // whisper/vision/Liara: l'endpoint può venire dal config nodo (user-overridable
  // — `cfg.whisperEndpoint`). internalAwareFetch con `scope` concede il bypass SSRF
  // SOLO se l'origin è ESATTAMENTE il servizio atteso da QUESTO callsite: un
  // utente che devia whisperEndpoint verso un ALTRO nostro servizio (Liara) NON
  // ottiene il bypass; un endpoint esterno pubblico funziona; un IP privato
  // arbitrario resta BLOCCATO.
  const res = await internalAwareFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    },
    scope,
  );
  if (!res.ok) {
    const txt = (await readTextTruncated(res, 65_536).catch(() => ({ text: '' }))).text;
    throw new Error(`HTTP ${String(res.status)} ${txt.slice(0, 200)}`);
  }
  return await readJsonCapped<T>(res);
}

export const videoSummarizerExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const videoUrl = coerceString(cfg.videoUrl ?? '').trim();
  if (!videoUrl) throw new Error('agent_video_summarizer: campo "videoUrl" obbligatorio.');
  if (!/^https?:\/\//i.test(videoUrl) && !videoUrl.startsWith('/data/')) {
    throw new Error('agent_video_summarizer: videoUrl deve essere http(s):// o path /data/*');
  }

  const intervalSec = clamp(cfg.frameIntervalSec, 1, 60, 5);
  const maxDurationSec = clamp(cfg.maxDurationSec, 60, 7200, 1800);
  const whisperEndpoint = coerceString(cfg.whisperEndpoint ?? DEFAULT_WHISPER).trim();
  const visionEndpoint = coerceString(cfg.visionEndpoint ?? DEFAULT_VISION).trim();
  const summaryLanguage = coerceString(cfg.summaryLanguage ?? 'auto').trim();
  // Whisper opt-in (default OFF): non tutte le installation hanno Whisper
  // standup. Vision-only + Liara è la modalità out-of-the-box garantita.
  const enableTranscription =
    cfg.enableTranscription === true || coerceString(cfg.enableTranscription ?? 'false') === 'true';

  const warnings: string[] = [];

  // Step 1 — Whisper ASR (solo se enable)
  let transcriptRes: TranscriptResult = { transcript: '' };
  if (enableTranscription) {
    try {
      transcriptRes = await postJson<TranscriptResult>(
        `${whisperEndpoint}/transcribe`,
        { videoUrl, maxDurationSec, tenantId: context.tenantId },
        120_000,
        { allow: 'whisper' },
      );
    } catch (e) {
      warnings.push(`whisper failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Step 2 — Vision scenes
  let visionRes: VisionResult = { scenes: [] };
  try {
    visionRes = await postJson<VisionResult>(
      `${visionEndpoint}/describe-frames`,
      { videoUrl, intervalSec, maxDurationSec, tenantId: context.tenantId },
      180_000,
      { allow: 'vision' },
    );
  } catch (e) {
    warnings.push(`vision failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Metering (follow-up Fase 2 #14): i token della gamba vision NON passano dal
  // gateway license → riportati al portal per scalare la quota come tutti gli
  // altri. Fire-and-forget: un portal irraggiungibile non blocca il nodo.
  if (visionRes.usage && ((visionRes.usage.input ?? 0) > 0 || (visionRes.usage.output ?? 0) > 0)) {
    void reportPortalTokenUsage(context.tenantId, {
      tokensIn: visionRes.usage.input ?? 0,
      tokensOut: visionRes.usage.output ?? 0,
      source: 'video-describe-frames',
    });
  }

  // Step 3 — LLM fusion via resolver + gateway metered (Fase 2 #14 — PRIMA:
  // endpoint diretto "v1 complete" su LIARA_URL, route inesistente + 401
  // internalAuth → il summary non veniva MAI prodotto, solo warning).
  let summary: SummaryResult = { tldr: '', bullets: [], chapters: [] };
  let llmUsage: LlmTokenUsage | undefined;
  let llmProvider = '';
  let llmModel = '';
  const langInstruction =
    summaryLanguage === 'auto'
      ? `Lingua output = lingua del transcript (${transcriptRes.language ?? 'detected'}).`
      : `Lingua output = ${summaryLanguage}.`;
  const fusionSystem =
    'Sei un summarizer multimodale. Rispondi SOLO con JSON valido, niente prosa attorno.';
  const fusionUser =
    `Dato:\n` +
    `TRANSCRIPT: ${transcriptRes.transcript.slice(0, 8000)}\n\n` +
    `SCENES (description per intervallo):\n${visionRes.scenes
      .slice(0, 50)
      .map((s) => `[${String(s.tStart)}s-${String(s.tEnd)}s] ${s.description}`)
      .join('\n')}\n\n` +
    `Produci JSON: { tldr: <1 frase>, bullets: <5 bullet>, chapters: [{tStart, title}] }. ${langInstruction}`;

  try {
    const resolved = llmResolver.resolve(context.tenantId);
    llmProvider = resolved.provider;
    llmModel = resolved.model || `${resolved.provider}-default`;
    const raw = (
      await dispatchLLMChat(
        resolved.provider,
        resolved.apiKey,
        resolved.model,
        fusionSystem,
        fusionUser,
        resolved.baseUrl,
        [],
        (u) => {
          llmUsage = u;
        },
        undefined,
        { maxTokens: 800, timeoutMs: 60_000 },
      )
    ).trim();
    // Fase 3 (#15): prompt di fusione completo + risposta → StepLog 'llm'.
    logLlmExchange(context, {
      provider: llmProvider,
      model: llmModel,
      system: fusionSystem,
      user: fusionUser,
      response: raw,
      phase: 'fusion',
    });
    const jsonMatch = /\{[\s\S]*\}/.exec(raw);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Partial<SummaryResult>;
      summary = {
        tldr: typeof parsed.tldr === 'string' ? parsed.tldr : '',
        bullets: Array.isArray(parsed.bullets)
          ? parsed.bullets.filter((x) => typeof x === 'string').slice(0, 10)
          : [],
        chapters: Array.isArray(parsed.chapters)
          ? parsed.chapters
              .filter((c) => c && typeof c.tStart === 'number' && typeof c.title === 'string')
              .slice(0, 30)
          : [],
      };
    } else {
      warnings.push('liara summary: no JSON in response');
    }
  } catch (e) {
    warnings.push(`liara failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    output: {
      transcript: transcriptRes.transcript,
      transcriptLanguage: transcriptRes.language,
      transcriptSegments: transcriptRes.segments ?? [],
      scenes: visionRes.scenes,
      summary,
      warnings,
      durationSec:
        visionRes.scenes.length > 0 ? Math.max(...visionRes.scenes.map((s) => s.tEnd)) : 0,
      // Fase 2 (#14): usage standard = fusion LLM + ramo vision (per-frame,
      // aggregato dallo shim). Presente se ALMENO una delle due gambe ha speso token.
      ...(llmUsage !== undefined || visionRes.usage !== undefined
        ? {
            _llm: {
              inputTokens: (llmUsage?.input ?? 0) + (visionRes.usage?.input ?? 0),
              outputTokens: (llmUsage?.output ?? 0) + (visionRes.usage?.output ?? 0),
              model: llmModel || 'liara-default',
              provider: llmProvider || 'liara',
              fromApi: (llmUsage?.fromApi ?? true) && (visionRes.usage?.fromApi ?? true),
            },
          }
        : {}),
    },
    durationMs: Date.now() - start,
  };
};
