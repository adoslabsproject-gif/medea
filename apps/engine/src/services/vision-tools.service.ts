/**
 * Vision Tools — lettura immagini/documenti col modello LLM RISOLTO del tenant
 * (BYOK o Liara, NON più il microservizio VL-7B su 5004 né il pdf-service su 5002).
 *
 * Liara ora è Qwen3-VL-32B (multimodale) e i provider BYOK (OpenAI/Anthropic/Gemini/…)
 * leggono immagini nativamente → instradiamo tutto via `dispatchLLMVision` col provider
 * che l'utente sta già usando. I PDF vengono renderizzati a PNG (unpdf + @napi-rs/canvas)
 * e mandati come immagini — scelta owner 2026-06-18.
 *
 * Usato come tool deterministico dai chat endpoint (auto-dispatch quando l'utente
 * allega un'immagine/PDF). NON va mai chiamato direttamente dal frontend.
 */

import { logger } from '@/lib/logger.js';
import { dispatchLLMVision, type VisionLlmTarget } from './llm-vision.service.js';
import { toVisionImage, extractPdfText } from '@/lib/vision-render.js';

export type { VisionLlmTarget } from './llm-vision.service.js';

/** Cap dimensione documento in input (32 MB) — anti-OOM sul decode base64. */
const DOC_MAX_INPUT_BYTES = 32 * 1024 * 1024;
/** Cap dimensione IMMAGINE in input (20 MB) — anti-OOM/costo: una foto base64
 *  enorme andrebbe dritta in RAM e nel context del modello vision. */
const IMAGE_MAX_INPUT_BYTES = 20 * 1024 * 1024;

/** byte stimati dei dati base64 (3/4 della lunghezza, ignorando il padding). */
function base64Bytes(b64: string): number {
  return Math.ceil((b64.length * 3) / 4);
}

const DEFAULT_IMAGE_PROMPT =
  'Leggi e descrivi tutto il contenuto di questa immagine. Se contiene testo ' +
  '(documento, fattura, scontrino, screenshot, targa), trascrivilo FEDELMENTE e in ' +
  'modo strutturato. Rispondi in italiano.';

export interface VisionAnalysisResult {
  ok: boolean;
  text?: string;
  confidence?: number;
  structured?: Record<string, unknown>;
  error?: string;
  elapsedMs: number;
}

/**
 * Analizza un'immagine col modello vision del tenant. `image` = base64 puro o
 * data-URL; `prompt` opzionale dirige l'analisi.
 */
export async function analyzeImage(
  image: string,
  prompt: string | undefined,
  target: VisionLlmTarget,
): Promise<VisionAnalysisResult> {
  const start = Date.now();
  const visionImage = toVisionImage(image);
  if (!visionImage.base64) {
    return { ok: false, error: 'immagine vuota', elapsedMs: Date.now() - start };
  }
  // Cap PRIMA di toccare RAM/modello (path d'errore non dimenticato): foto enorme → stop.
  const imgBytes = base64Bytes(visionImage.base64);
  if (imgBytes > IMAGE_MAX_INPUT_BYTES) {
    return { ok: false, error: `Immagine troppo grande (${imgBytes.toString()} bytes). Max ${(IMAGE_MAX_INPUT_BYTES / (1024 * 1024)).toString()} MB.`, elapsedMs: Date.now() - start };
  }
  const r = await dispatchLLMVision(target, prompt?.trim() || DEFAULT_IMAGE_PROMPT, [visionImage]);
  if (!r.ok) {
    logger.warn({ provider: target.provider, error: r.error }, '[vision] analyzeImage failed');
    return { ok: false, error: r.error ?? 'vision fallita', elapsedMs: Date.now() - start };
  }
  return { ok: true, text: r.text, elapsedMs: Date.now() - start };
}

export interface DocumentExtractionResult {
  ok: boolean;
  text?: string;
  pages?: number;
  size?: number;
  mime?: string;
  error?: string;
  elapsedMs: number;
}

/**
 * Estrae il testo da un documento. text/* → decode UTF-8 diretto. application/pdf →
 * estrazione testo con unpdf (NON render-immagine: pdfjs apre un worker che sotto il
 * bundle di produzione non trasferisce il canvas → DataCloneError; `extractText`
 * funziona). Il testo torna al chiamante che lo passa al modello (Liara/BYOK).
 * PDF scansionati (senza layer testo) → testo vuoto: lo segnaliamo esplicitamente.
 */
export async function extractDocument(
  documentBase64: string,
  mimeType: string,
): Promise<DocumentExtractionResult> {
  const start = Date.now();
  const sizeBytes = base64Bytes(documentBase64);
  const base = { mime: mimeType, size: sizeBytes };

  if (sizeBytes > DOC_MAX_INPUT_BYTES) {
    return { ok: false, error: `Documento troppo grande (${sizeBytes.toString()} bytes). Max ${(DOC_MAX_INPUT_BYTES / (1024 * 1024)).toString()} MB.`, ...base, elapsedMs: Date.now() - start };
  }

  // File di testo: decode diretto.
  if (mimeType.startsWith('text/')) {
    try {
      const text = Buffer.from(documentBase64, 'base64').toString('utf-8');
      return { ok: true, text: text.slice(0, 200_000), pages: 1, ...base, elapsedMs: Date.now() - start };
    } catch {
      return { ok: false, error: 'UTF-8 decode failed', ...base, elapsedMs: Date.now() - start };
    }
  }

  if (!mimeType.startsWith('application/pdf')) {
    return { ok: false, error: `MIME non supportato: ${mimeType}`, ...base, elapsedMs: Date.now() - start };
  }

  // PDF → estrazione testo (funziona nel bundle, a differenza del render-immagine).
  try {
    const pdfBytes = new Uint8Array(Buffer.from(documentBase64, 'base64'));
    const { text, totalPages } = await extractPdfText(pdfBytes);
    if (text.trim().length === 0) {
      return { ok: false, error: 'Il PDF non contiene testo estraibile (probabilmente scansionato/immagine): la lettura a immagine dei PDF non è ancora supportata.', pages: totalPages, ...base, elapsedMs: Date.now() - start };
    }
    return { ok: true, text: text.slice(0, 200_000), pages: totalPages, ...base, elapsedMs: Date.now() - start };
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, '[vision] extractDocument failed');
    return { ok: false, error: err instanceof Error ? err.message : String(err), ...base, elapsedMs: Date.now() - start };
  }
}
