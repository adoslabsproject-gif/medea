/**
 * Dispatch VISION multi-provider — legge immagini col modello LLM RISOLTO del tenant
 * (BYOK o Liara), NON solo con Liara. Ogni famiglia di provider ha un formato immagine
 * diverso:
 *   • OpenAI-compat (openai/mistral/groq/grok/deepseek/openrouter/liara) → content[].image_url (data-URL)
 *   • Anthropic                                                          → content[].image.source(base64)
 *   • Gemini                                                             → parts[].inline_data
 *   • Ollama (llava/qwen-vl locali)                                      → message.images[] (base64 puro)
 *
 * Speculare a `dispatchLLMChat` (stessi endpoint/auth/parsing) ma multimodale. Non
 * lancia: ritorna `{ ok:false, error }` su ogni fallimento (è un tool, non il loop).
 */

import { isFixedOpenAiCompat, fixedOpenAiCompatTarget } from './llm/provider-registry.js';
import { isLiaraEnabled, liaraBaseUrl } from '@/config.js';
import { readJsonCapped, readTextTruncated } from '@/lib/capped-response.js';
import type { VisionImage } from '@/lib/vision-render.js';

/** Descrittore del provider risolto (sottoinsieme di ResolvedLlm) sufficiente al dispatch. */
export interface VisionLlmTarget {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string | undefined;
}

export interface VisionDispatchResult {
  ok: boolean;
  text: string;
  error?: string;
}

const TIMEOUT_MS = Number(process.env.MEDEA_VISION_TIMEOUT_MS ?? '120000');
const MAX_TOKENS = Number(process.env.MEDEA_VISION_MAX_TOKENS ?? '4096');

function openAiCompatContent(prompt: string, images: VisionImage[]): unknown[] {
  return [
    { type: 'text', text: prompt },
    ...images.map((img) => ({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
    })),
  ];
}

async function errExcerpt(res: Response): Promise<string> {
  return (await readTextTruncated(res, 65_536).catch(() => ({ text: '' }))).text.slice(0, 300);
}

/** Parsing risposta OpenAI-compat (`choices[].message.content`). */
async function parseOpenAiChoices(res: Response, label: string): Promise<VisionDispatchResult> {
  if (!res.ok)
    return {
      ok: false,
      text: '',
      error: `${label} HTTP ${res.status.toString()}: ${await errExcerpt(res)}`,
    };
  const data = await readJsonCapped<{ choices?: { message?: { content?: string } }[] }>(res);
  return { ok: true, text: data.choices?.[0]?.message?.content ?? '' };
}

export async function dispatchLLMVision(
  target: VisionLlmTarget,
  prompt: string,
  images: VisionImage[],
): Promise<VisionDispatchResult> {
  if (images.length === 0) return { ok: false, text: '', error: 'nessuna immagine fornita' };
  const { provider, apiKey, model, baseUrl } = target;
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    // ── OpenAI-compat a endpoint fisso (openai/mistral/groq/grok/deepseek/openrouter) ──
    if (isFixedOpenAiCompat(provider)) {
      const tgt = fixedOpenAiCompatTarget(provider, model);
      const res = await fetch(tgt.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(tgt.extraHeaders ?? {}),
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: tgt.model,
          messages: [{ role: 'user', content: openAiCompatContent(prompt, images) }],
          max_tokens: MAX_TOKENS,
          temperature: 0.1,
        }),
        signal: ctrl.signal,
      });
      return await parseOpenAiChoices(res, provider);
    }

    switch (provider) {
      case 'liara': {
        if (!isLiaraEnabled())
          return { ok: false, text: '', error: 'Liara è disabilitata su questa istanza' };
        const licenseKey = process.env.MEDEA_LICENSE_KEY ?? '';
        const res = await fetch(`${baseUrl ?? liaraBaseUrl()}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(licenseKey ? { Authorization: `Bearer ${licenseKey}` } : {}),
          },
          body: JSON.stringify({
            messages: [{ role: 'user', content: openAiCompatContent(prompt, images) }],
            max_tokens: MAX_TOKENS,
            temperature: 0.1,
            chat_template_kwargs: { enable_thinking: false },
          }),
          signal: ctrl.signal,
        });
        return await parseOpenAiChoices(res, 'Liara');
      }
      case 'ollama': {
        const res = await fetch(`${baseUrl ?? 'http://localhost:11434'}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: model || 'llava',
            stream: false,
            messages: [{ role: 'user', content: prompt, images: images.map((i) => i.base64) }],
          }),
          signal: ctrl.signal,
        });
        if (!res.ok)
          return {
            ok: false,
            text: '',
            error: `Ollama HTTP ${res.status.toString()}: ${await errExcerpt(res)}`,
          };
        const data = await readJsonCapped<{ message?: { content?: string } }>(res);
        return { ok: true, text: data.message?.content ?? '' };
      }
      case 'anthropic': {
        const content = [
          { type: 'text', text: prompt },
          ...images.map((img) => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mimeType, data: img.base64 },
          })),
        ];
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: model || 'claude-sonnet-4-5-20250929',
            messages: [{ role: 'user', content }],
            max_tokens: MAX_TOKENS,
            temperature: 0.1,
          }),
          signal: ctrl.signal,
        });
        if (!res.ok)
          return {
            ok: false,
            text: '',
            error: `Anthropic HTTP ${res.status.toString()}: ${await errExcerpt(res)}`,
          };
        const data = await readJsonCapped<{ content?: { type: string; text?: string }[] }>(res);
        return {
          ok: true,
          text: (data.content ?? [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join(''),
        };
      }
      case 'gemini': {
        const parts = [
          { text: prompt },
          ...images.map((img) => ({ inline_data: { mime_type: img.mimeType, data: img.base64 } })),
        ];
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.0-flash'}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ role: 'user', parts }] }),
            signal: ctrl.signal,
          },
        );
        if (!res.ok)
          return {
            ok: false,
            text: '',
            error: `Gemini HTTP ${res.status.toString()}: ${await errExcerpt(res)}`,
          };
        const data = await readJsonCapped<{
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        }>(res);
        return {
          ok: true,
          text: data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '',
        };
      }
      default:
        return {
          ok: false,
          text: '',
          error: `Il provider "${provider}" non supporta la lettura di immagini/documenti.`,
        };
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      text: '',
      error: aborted
        ? `Vision timeout dopo ${TIMEOUT_MS.toString()}ms`
        : err instanceof Error
          ? err.message
          : String(err),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
