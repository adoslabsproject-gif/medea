/**
 * Loop agente tool-calling in formato OpenAI-tools (Fase 2 #14).
 *
 * Percorso per Liara (gateway metered → vLLM Qwen3-VL, tool_calls VALIDATI
 * live 2026-07-06) e per i provider BYOK OpenAI-compatibili (openai,
 * openrouter, groq, mistral). Il percorso Anthropic nativo resta in
 * tool-loop.ts (formato tool_use/tool_result diverso, battle-tested).
 *
 * Condivide con tool-loop.ts: executeTool (guardie SSRF/H3/RAG identiche),
 * trace, cancel cooperativo, cap iterazioni. File separato: no-monoliti.
 */

import { internalGatewayTrustedHost } from '@flowforge/safe-fetch';
import { logLlmExchange } from '@flowforge/nodes-stdlib';
import { buildAgentUsage, sumAgentUsage, type AgentLlmUsage } from './llm-usage.js';

interface OpenAiToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiAssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: OpenAiToolCall[];
}

type OpenAiMessage =
  | { role: 'system' | 'user'; content: string }
  | OpenAiAssistantMessage
  | { role: 'tool'; tool_call_id: string; content: string };

interface OpenAiToolReply {
  choices?: { message?: OpenAiAssistantMessage; finish_reason?: string }[];
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Endpoint + auth per i provider OpenAI-format supportati dal loop. */
export function openAiLoopEndpoint(provider: string, apiKey: string, model: string, baseUrl: string | undefined): {
  url: string; headers: Record<string, string>; effectiveModel: string; trustedHost: string | undefined; label: string;
} {
  switch (provider) {
    case 'liara': {
      const internalGateway = typeof process !== 'undefined' && process.env.FLOWFORGE_LIARA_BASE_URL
        ? process.env.FLOWFORGE_LIARA_BASE_URL.replace(/\/$/, '')
        : undefined;
      const base = baseUrl ?? internalGateway ?? 'https://liara.nothumanallowed.com';
      const licenseKey = typeof process !== 'undefined' ? (process.env.FLOWFORGE_LICENSE_KEY ?? '').trim() : '';
      const bearer = licenseKey || apiKey;
      // Model: i default legacy Claude salvati nelle config (il nodo era
      // Anthropic-only) e 'nha-v1' senza tool-training NON hanno senso qui →
      // campo omesso, decide il gateway. Un model esplicito diverso passa.
      const effectiveModel = model.startsWith('claude-') || model === 'nha-v1' ? '' : model;
      return {
        url: `${base}/chat/completions`,
        headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
        effectiveModel,
        trustedHost: internalGatewayTrustedHost(base, internalGateway),
        label: 'Liara',
      };
    }
    case 'openai':
      return {
        url: 'https://api.openai.com/v1/chat/completions',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        effectiveModel: model || 'gpt-4o-mini',
        trustedHost: undefined,
        label: 'OpenAI',
      };
    case 'openrouter':
      return {
        url: 'https://openrouter.ai/api/v1/chat/completions',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'X-Title': 'FlowForge' },
        effectiveModel: model || 'anthropic/claude-sonnet-4.5',
        trustedHost: undefined,
        label: 'OpenRouter',
      };
    case 'groq':
      return {
        url: 'https://api.groq.com/openai/v1/chat/completions',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        effectiveModel: model || 'llama-3.3-70b-versatile',
        trustedHost: undefined,
        label: 'Groq',
      };
    case 'mistral':
      return {
        url: 'https://api.mistral.ai/v1/chat/completions',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        effectiveModel: model || 'mistral-large-latest',
        trustedHost: undefined,
        label: 'Mistral',
      };
    case 'gemini':
      // Google espone un endpoint OpenAI-COMPATIBILE (tools inclusi) — niente
      // formato function-calling proprietario da gestire.
      return {
        url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        effectiveModel: model || 'gemini-2.0-flash',
        trustedHost: undefined,
        label: 'Gemini',
      };
    case 'deepseek':
      return {
        url: 'https://api.deepseek.com/chat/completions',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        effectiveModel: model || 'deepseek-chat',
        trustedHost: undefined,
        label: 'DeepSeek',
      };
    case 'xai':
      return {
        url: 'https://api.x.ai/v1/chat/completions',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        effectiveModel: model || 'grok-2-latest',
        trustedHost: undefined,
        label: 'xAI',
      };
    case 'ollama': {
      // Ollama ha /v1/chat/completions OpenAI-compat con tools. Endpoint da
      // config/env di sistema (non payload utente) → esenzione SSRF per il suo
      // host esatto (default loopback: allowDockerNet non basterebbe).
      const base = (baseUrl
        ?? (typeof process !== 'undefined' ? process.env.FLOWFORGE_OLLAMA_URL : undefined)
        ?? 'http://localhost:11434').replace(/\/$/, '');
      return {
        url: `${base}/v1/chat/completions`,
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        effectiveModel: model || 'llama3.2',
        trustedHost: internalGatewayTrustedHost(base, base),
        label: 'Ollama',
      };
    }
    default:
      throw new Error(
        `ai_agent_tool_loop: provider "${provider}" non supporta il tool-calling in questo nodo. ` +
        'Supportati: liara (default, gratis), anthropic, openai, gemini, deepseek, xai, openrouter, groq, mistral, ollama.',
      );
  }
}

/**
 * Provider con tool-calling FUNZIONANTE nel loop (nativo anthropic escluso: ha
 * il suo ramo). Chi non è qui (oggi SOLO perplexity: i modelli Sonar non
 * supportano i tools) non deve produrre un errore quando arriva dall'auto-pick
 * di Settings → il dispatcher fa fallback DICHIARATO su Liara.
 */
export const TOOL_CAPABLE_OPENAI_PROVIDERS: ReadonlySet<string> = new Set([
  'liara', 'openai', 'gemini', 'deepseek', 'xai', 'openrouter', 'groq', 'mistral', 'ollama',
]);

/** Converte il catalogo tool (schema Anthropic input_schema) in formato OpenAI-tools. */
export function toOpenAiTools(tools: readonly { name: string; description: string; input_schema: unknown }[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

export interface OpenAiLoopDeps {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl: string | undefined;
  systemPrompt: string;
  userGoal: string;
  maxIterations: number;
  tools: readonly { name: string; description: string; input_schema: unknown }[];
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  fetchFn: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; allowedHosts?: readonly string[]; signal?: AbortSignal }) => Promise<Response>;
  readJson: <T>(res: Response) => Promise<T>;
  readErrText: (res: Response) => Promise<string>;
  abortSignal?: AbortSignal | undefined;
  /** Context del nodo (per il log prompt/risposta sul canale StepLog 'llm' — Fase 3 #15). */
  nodeContext?: unknown;
}

export interface OpenAiLoopResult {
  output: Record<string, unknown>;
  iterations: number;
}

/**
 * Esegue il loop. Ritorna l'output del nodo (finalAnswer o error) SEMPRE con
 * `_llm` quando almeno una chiamata è partita (i token spesi si dichiarano
 * anche nei percorsi d'errore).
 */
export async function runOpenAiToolLoop(deps: OpenAiLoopDeps): Promise<OpenAiLoopResult> {
  const { url, headers, effectiveModel, trustedHost, label } = openAiLoopEndpoint(deps.provider, deps.apiKey, deps.model, deps.baseUrl);
  const openAiTools = toOpenAiTools(deps.tools);

  const messages: OpenAiMessage[] = [
    { role: 'system', content: deps.systemPrompt },
    { role: 'user', content: deps.userGoal },
  ];
  const trace: { iteration: number; tool: string; input: unknown; output: string }[] = [];

  // Usage cumulativo su tutte le iterazioni. Il model riportato dalla risposta
  // vince (il gateway può aver iniettato il suo default quando omesso).
  let usage: AgentLlmUsage | null = null;
  const accumulate = (reply: OpenAiToolReply, sentBody: string, gotText: string): void => {
    const step = buildAgentUsage({
      provider: deps.provider,
      model: reply.model ?? usage?.model ?? (effectiveModel || 'gateway-default'),
      sentSystem: '',
      sentUser: sentBody,
      receivedText: gotText,
      api: { input: reply.usage?.prompt_tokens, output: reply.usage?.completion_tokens },
    });
    usage = usage === null ? step : { ...sumAgentUsage(usage, step), model: step.model };
  };
  const withUsage = (out: Record<string, unknown>): Record<string, unknown> =>
    usage !== null ? { ...out, _llm: usage } : out;

  const cancelledOutput = (iter: number): OpenAiLoopResult => ({
    output: withUsage({ error: 'Agent annullato (run cancellato)', cancelled: true, trace, iterations: iter }),
    iterations: iter,
  });

  for (let iter = 0; iter < deps.maxIterations; iter++) {
    if (deps.abortSignal?.aborted) return cancelledOutput(iter);

    const body = JSON.stringify({
      ...(effectiveModel ? { model: effectiveModel } : {}),
      max_tokens: 4096,
      messages,
      tools: openAiTools,
      tool_choice: 'auto',
    });
    let res: Response;
    try {
      res = await deps.fetchFn(url, {
        method: 'POST',
        headers,
        body,
        ...(trustedHost ? { allowedHosts: [trustedHost] } : {}),
        ...(deps.abortSignal ? { signal: deps.abortSignal } : {}),
      });
    } catch (err) {
      if (deps.abortSignal?.aborted) return cancelledOutput(iter);
      throw err;
    }
    if (!res.ok) {
      const errText = await deps.readErrText(res);
      return {
        output: withUsage({ error: `${label} ${res.status.toString()}: ${errText}`, trace, iterations: iter }),
        iterations: iter,
      };
    }
    const reply = await deps.readJson<OpenAiToolReply>(res);
    const msg = reply.choices?.[0]?.message;
    const content = typeof msg?.content === 'string' ? msg.content : '';
    accumulate(reply, body, content + JSON.stringify(msg?.tool_calls ?? ''));
    // Fase 3 (#15): prompt integrale alla 1ª iterazione (system+goal); dalle
    // successive il "prompt" incrementale sono i tool result, già nel trace.
    logLlmExchange(deps.nodeContext, {
      provider: deps.provider,
      model: reply.model ?? (effectiveModel || 'gateway-default'),
      system: iter === 0 ? deps.systemPrompt : '',
      user: iter === 0 ? deps.userGoal : '(tool results dell\'iterazione precedente — vedi trace)',
      response: content || JSON.stringify(msg?.tool_calls ?? []),
      phase: `iterazione ${String(iter + 1)}`,
    });

    const toolCalls = (msg?.tool_calls ?? []).filter((tc) => tc.type === undefined || tc.type === 'function');
    if (msg) {
      // Il messaggio assistant va rimesso in history COMPLETO di tool_calls,
      // altrimenti il modello perde il filo delle proprie richieste.
      messages.push({ role: 'assistant', content: msg.content ?? null, ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
    }

    if (toolCalls.length > 0) {
      for (const tc of toolCalls) {
        if (deps.abortSignal?.aborted) return cancelledOutput(iter);
        const toolName = tc.function?.name ?? '';
        // arguments è una STRINGA JSON prodotta dal modello: parse difensivo —
        // garbage → tool-result d'errore strutturato, il modello può correggersi.
        let toolInput: Record<string, unknown> = {};
        let parseFailed = false;
        try {
          const parsed: unknown = JSON.parse(tc.function?.arguments ?? '{}');
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            toolInput = parsed as Record<string, unknown>;
          } else {
            parseFailed = true;
          }
        } catch {
          parseFailed = true;
        }
        const result = parseFailed
          ? JSON.stringify({ error: `invalid tool arguments (not a JSON object): ${(tc.function?.arguments ?? '').slice(0, 200)}` })
          : await deps.executeTool(toolName, toolInput);
        trace.push({ iteration: iter, tool: toolName, input: toolInput, output: result.slice(0, 500) });
        messages.push({ role: 'tool', tool_call_id: tc.id ?? '', content: result });
      }
      continue;
    }

    return {
      output: withUsage({ finalAnswer: content, iterations: iter + 1, trace }),
      iterations: iter + 1,
    };
  }

  return {
    output: withUsage({ error: `Agent exceeded maxIterations=${deps.maxIterations.toString()}`, trace, iterations: deps.maxIterations }),
    iterations: deps.maxIterations,
  };
}
