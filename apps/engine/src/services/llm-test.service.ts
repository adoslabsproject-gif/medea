/**
 * Minimal ping per il bottone "Test" degli AI Providers.
 * Invia una completion da 1 token per verificare auth + raggiungibilità.
 *
 * Endpoint/modelli/header dei provider OpenAI-compat a endpoint fisso vengono
 * da UNICA FONTE (services/llm/provider-registry): un solo ramo generico al
 * posto di un case duplicato per provider. Aggiungere un provider OpenAI-compat
 * = una riga nel registry, zero codice qui.
 *
 * Case dedicati solo per le shape NON OpenAI: Liara/Ollama (self-host),
 * Gemini nativo, Anthropic, Voyage (embeddings).
 */

import type { LlmProvider } from './llm-providers.service.js';
import {
  getProviderSpec, isFixedOpenAiCompat, fixedOpenAiCompatTarget,
} from './llm/provider-registry.js';
import { readJsonCapped, readTextTruncated } from '@/lib/capped-response.js';

interface ProviderCfg { apiKey: string; defaultModel?: string; baseUrl?: string }

const PING = 'Reply with the single word OK.';

/** Estrae il testo da una risposta OpenAI-compat (choices[0].message.content). */
async function readOpenAiText(res: Response, label: string): Promise<string> {
  if (!res.ok) throw new Error(`${label} ${res.status.toString()}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 200)}`);
  const data = await readJsonCapped<{ choices?: { message: { content: string } }[] }>(res);
  return data.choices?.[0]?.message.content ?? '';
}

export async function dispatchLLMForTest(provider: LlmProvider, cfg: ProviderCfg | null): Promise<string> {
  const apiKey = cfg?.apiKey ?? '';
  const model = cfg?.defaultModel ?? '';
  const baseUrl = cfg?.baseUrl;

  // ── Ramo generico: tutti i provider OpenAI-compat a endpoint fisso ──────────
  // (openai, mistral, groq, grok, deepseek, openrouter). Url/model/header = SSOT.
  if (isFixedOpenAiCompat(provider)) {
    const target = fixedOpenAiCompatTarget(provider, model, true /* ping model */);
    const res = await fetch(target.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(target.extraHeaders ?? {}), Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: target.model, messages: [{ role: 'user', content: PING }], max_tokens: 8 }),
    });
    return readOpenAiText(res, providerLabel(provider));
  }

  switch (provider) {
    case 'liara': {
      // Self-host: il backend vLLM espone il path OpenAI /v1; baseUrl override per
      // istanze custom. (Distinto dal gateway portal usato dalla chat runtime.)
      const url = `${baseUrl ?? 'https://liara.nothumanallowed.com'}/v1/chat/completions`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || getProviderSpec('liara').pingModel, messages: [{ role: 'user', content: PING }], max_tokens: 8 }),
      });
      return readOpenAiText(res, 'Liara');
    }
    case 'anthropic': {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: model || getProviderSpec('anthropic').pingModel, max_tokens: 8, messages: [{ role: 'user', content: PING }] }),
      });
      if (!res.ok) throw new Error(`Anthropic ${res.status.toString()}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 200)}`);
      const data = await readJsonCapped<{ content?: { type: string; text?: string }[] }>(res);
      return data.content?.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('') ?? '';
    }
    case 'gemini': {
      const m = model || getProviderSpec('gemini').pingModel;
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: PING }] }] }),
      });
      if (!res.ok) throw new Error(`Gemini ${res.status.toString()}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 200)}`);
      const data = await readJsonCapped<{ candidates?: { content?: { parts?: { text?: string }[] } }[] }>(res);
      return data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    }
    case 'ollama': {
      const url = `${baseUrl ?? 'http://localhost:11434'}/api/chat`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || getProviderSpec('ollama').pingModel, stream: false, messages: [{ role: 'user', content: PING }] }),
      });
      if (!res.ok) throw new Error(`Ollama ${res.status.toString()}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 200)}`);
      const data = await readJsonCapped<{ message?: { content?: string } }>(res);
      return data.message?.content ?? '';
    }
    case 'voyage': {
      const res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model || getProviderSpec('voyage').pingModel, input: PING }),
      });
      if (!res.ok) throw new Error(`Voyage ${res.status.toString()}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 200)}`);
      return 'OK (embeddings provider)';
    }
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

/** Etichetta leggibile per i messaggi di errore del ramo generico. */
function providerLabel(p: LlmProvider): string {
  const map: Partial<Record<LlmProvider, string>> = {
    openai: 'OpenAI', mistral: 'Mistral', groq: 'Groq', grok: 'Grok', deepseek: 'DeepSeek', openrouter: 'OpenRouter',
  };
  return map[p] ?? p;
}
