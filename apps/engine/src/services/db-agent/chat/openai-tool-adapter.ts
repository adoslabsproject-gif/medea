/**
 * Adapter LLM tool-calling (formato OpenAI-compatible) per il loop DB-agent.
 *
 * L'infra FlowForge parla `/chat/completions` (Liara=default via OpenAI-compat,
 * o OpenAI/BYOK). Qui traduciamo l'interfaccia astratta del loop (system +
 * ChatTurn[] + tools) in una richiesta valida, e la risposta in un LlmTurnResult.
 *
 * Funzioni PURE (build/parse) testate su fixture: il modello reale è una
 * dipendenza, non il soggetto del test. `makeOpenAiLlmTurn` aggiunge il
 * trasporto (fetch iniettabile → testabile end-to-end senza LLM).
 *
 * @module services/db-agent/chat/openai-tool-adapter
 */
import type { ChatTurn, LlmToolCall, LlmTurn, LlmTurnInput, LlmTurnResult } from './types.js';
import { readJsonCapped } from '@/lib/capped-response.js';

interface OaFunctionCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
interface OaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: OaFunctionCall[];
}
interface OaTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface OaChatRequest {
  messages: OaMessage[];
  tools: OaTool[];
  tool_choice: 'auto';
  model?: string;
}

/** ChatTurn[] (+system) → messaggi OpenAI-compat, con tool_calls/tool_call_id corretti. */
export function buildChatCompletionsRequest(input: LlmTurnInput, model?: string): OaChatRequest {
  const messages: OaMessage[] = [{ role: 'system', content: input.system }];
  for (const t of input.messages) {
    messages.push(toOaMessage(t));
  }
  const tools: OaTool[] = input.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  return { messages, tools, tool_choice: 'auto', ...(model?.trim() ? { model } : {}) };
}

function toOaMessage(t: ChatTurn): OaMessage {
  if (t.role === 'tool') {
    return {
      role: 'tool',
      content: t.content,
      ...(t.toolCallId ? { tool_call_id: t.toolCallId } : {}),
    };
  }
  if (t.role === 'assistant' && t.toolCalls && t.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: t.content.length > 0 ? t.content : null,
      tool_calls: t.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
      })),
    };
  }
  return { role: t.role, content: t.content };
}

interface OaChoiceMessage {
  content?: string | null;
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
}
interface OaResponse {
  choices?: { message?: OaChoiceMessage }[];
}

/** Risposta OpenAI-compat → LlmTurnResult. tool_calls presenti ⇒ kind 'tools'. */
export function parseChatCompletionsResponse(data: unknown): LlmTurnResult {
  const msg = ((data ?? {}) as OaResponse).choices?.[0]?.message ?? {};
  const rawCalls = msg.tool_calls ?? [];
  if (rawCalls.length > 0) {
    const toolCalls: LlmToolCall[] = rawCalls.map((c, i) => ({
      id: c.id ?? `call_${i.toString()}`,
      name: c.function?.name ?? '',
      args: safeParseArgs(c.function?.arguments),
    }));
    const text = typeof msg.content === 'string' ? msg.content : '';
    return { kind: 'tools', ...(text ? { text } : {}), toolCalls };
  }
  return { kind: 'final', text: typeof msg.content === 'string' ? msg.content : '' };
}

/** function.arguments è una STRINGA JSON; fail-soft a {} se malformata. */
function safeParseArgs(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export interface OpenAiLlmTurnOptions {
  endpoint: string;
  apiKey?: string;
  model?: string;
  /** Header HTTP extra (es. attribution OpenRouter) — dal provider-registry. */
  extraHeaders?: Readonly<Record<string, string>>;
  /** Iniettabile per i test; default global fetch. */
  fetchImpl?: typeof fetch;
}

/** Costruisce una LlmTurn che chiama un endpoint OpenAI-compat con tool-calling. */
export function makeOpenAiLlmTurn(opts: OpenAiLlmTurnOptions): LlmTurn {
  const doFetch = opts.fetchImpl ?? fetch;
  return async (input) => {
    const body = buildChatCompletionsRequest(input, opts.model);
    const res = await doFetch(opts.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.extraHeaders ?? {}),
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`LLM tool endpoint HTTP ${res.status.toString()}`);
    }
    const data: unknown = await readJsonCapped<unknown>(res);
    return parseChatCompletionsResponse(data);
  };
}
