/**
 * Una chat col provider del tenant, per i servizi dei custom node (ai-assist,
 * ai-inline).
 *
 * I due servizi parlano in «messaggi» — uno o più di sistema, poi l'utente —
 * mentre il dispatcher vuole sistema, storia e ultimo messaggio separati. Qui
 * si fa la traduzione una volta sola, e si risale dal tenant al provider che
 * ha configurato: non esiste un modello «di casa» a cui ripiegare.
 *
 * @module services/custom-nodes/tenant-llm
 */

import { dispatchLLMChat } from '@/services/llm-chat.service.js';
import { llmResolver } from '@/services/llm-resolver.service.js';

export interface TenantChatRequest {
  messages: { role: string; content: string }[];
  temperature: number;
  maxTokens: number;
  /** Timeout della singola chiamata (ms). */
  timeoutMs: number;
  /** Il tenant: da lui si risale al provider configurato. */
  workspaceId: string;
  /** Stop sequences (es. inline-completion). */
  stop?: string[];
  /** Modello da usare al posto di quello configurato dal tenant. */
  modelOverride?: string;
}

export interface TenantChatResult {
  content: string;
  usage: { input: number; output: number };
  /** Il provider che ha risposto. */
  provider: string;
}

/**
 * Chiede una risposta al provider del tenant.
 *
 * Lancia in ogni caso in cui la risposta non c'è: nessun provider configurato
 * (`NoLlmProviderError`, col messaggio che dice dove configurarlo), errore di
 * rete, timeout, risposta non-2xx. Chi chiama decide se rilanciare o ripiegare.
 */
export async function tenantChatCompletion(req: TenantChatRequest): Promise<TenantChatResult> {
  const resolved = llmResolver.resolve(req.workspaceId);

  const system = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const turni = req.messages.filter((m) => m.role !== 'system');
  const ultimo = turni.at(-1);
  if (ultimo?.role !== 'user') {
    throw new Error('tenantChatCompletion: l’ultimo messaggio deve essere dell’utente');
  }
  const history = turni.slice(0, -1).map((m) => ({
    role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
    content: m.content,
  }));

  let usage = { input: 0, output: 0 };
  const content = await dispatchLLMChat(
    resolved.provider,
    resolved.apiKey,
    req.modelOverride ?? resolved.model,
    system,
    ultimo.content,
    resolved.baseUrl,
    history,
    (u) => {
      usage = { input: u.input, output: u.output };
    },
    {
      maxTokens: req.maxTokens,
      timeoutMs: req.timeoutMs,
      temperature: req.temperature,
      ...(req.stop && req.stop.length > 0 ? { stop: req.stop } : {}),
    },
  );

  return { content, usage, provider: resolved.provider };
}
