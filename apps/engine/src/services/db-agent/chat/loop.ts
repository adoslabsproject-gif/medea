/**
 * Loop chat agentico del DB-agent — il cervello che mette i 15 strumenti
 * tenant-safe nelle mani di Liara dentro DB Studio.
 *
 * Ciclo: chiede un turno al modello (con i tool); se il modello chiede tool,
 * li esegue via `executeDbAgentTool` (SEMPRE tenant-scoped) e ri-alimenta i
 * risultati; ripete finché il modello produce una risposta finale o si
 * raggiunge `maxIterations` (anti-loop). Non lancia mai per colpa di un tool:
 * gli errori dei tool tornano al modello come messaggi, così può correggersi
 * o chiedere conferma. Un'eccezione del MODELLO (llmTurn) viene propagata
 * pulita (è un guasto d'infrastruttura, non un esito di tool).
 *
 * @module services/db-agent/chat/loop
 */
import type { DbAgentContext } from '../context.js';
import { executeDbAgentTool, listDbAgentTools, isDestructiveTool } from '../registry.js';
import { buildDbAgentSystemPrompt, type DbAgentPromptContext } from './prompt.js';
import type { ChatTurn, DbAgentChatResult, DbAgentChatStep, LlmTurn } from './types.js';

const DEFAULT_MAX_ITERATIONS = 8;

export interface RunDbAgentChatOptions {
  ctx: DbAgentContext;
  userMessage: string;
  prompt: DbAgentPromptContext;
  history?: ChatTurn[];
  llmTurn: LlmTurn;
  maxIterations?: number;
  /** Callback per ogni step di tool eseguito — per lo streaming live (SSE). */
  onStep?: (step: DbAgentChatStep) => void;
}

export async function runDbAgentChat(opts: RunDbAgentChatOptions): Promise<DbAgentChatResult> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const system = buildDbAgentSystemPrompt(opts.prompt);
  const tools = listDbAgentTools();
  const messages: ChatTurn[] = [...(opts.history ?? []), { role: 'user', content: opts.userMessage }];
  const steps: DbAgentChatStep[] = [];

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const turn = await opts.llmTurn({ system, messages, tools });

    if (turn.kind === 'final') {
      return { message: turn.text, steps, iterations: iteration, stoppedReason: 'final' };
    }

    // Il modello chiede uno o più tool. Registriamo il turno assistant CON i
    // tool_calls (necessario per un thread OpenAI-compat valido) e poi
    // eseguiamo OGNI tool, accodando il risultato.
    messages.push({ role: 'assistant', content: turn.text ?? '', toolCalls: turn.toolCalls });
    for (const call of turn.toolCalls) {
      const result = await executeDbAgentTool(opts.ctx, call.name, call.args);
      const step: DbAgentChatStep = {
        tool: call.name,
        ok: result.ok,
        ...(result.ok ? {} : { code: result.code }),
        destructive: isDestructiveTool(call.name),
      };
      steps.push(step);
      opts.onStep?.(step);
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  // Esauriti i giri senza risposta finale: stop netto (niente loop infinito).
  return {
    message: 'Ho raggiunto il numero massimo di passi senza completare. Riformula la richiesta o procedi a step più piccoli.',
    steps,
    iterations: maxIterations,
    stoppedReason: 'max_iterations',
  };
}
