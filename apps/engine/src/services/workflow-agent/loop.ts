/**
 * loop — driver agentico del costruttore di workflow (#3).
 *
 * Mirror del loop db-agent (provider-agnostico, `LlmTurn` INIETTATO → testabile
 * senza modello reale): chiede un turno al modello coi tool; esegue i tool sul
 * WorkflowBuilder; ri-alimenta i risultati; ripete finché il modello chiama
 * `finish`, dà una risposta finale, o si raggiunge `maxIterations`.
 *
 * Non lancia mai per colpa di un tool: gli errori tornano al modello come
 * messaggi (può correggersi). Un'eccezione del MODELLO (llmTurn) viene propagata.
 *
 * @module services/workflow-agent/loop
 */
import type { ChatTurn, LlmTurn } from '@/services/db-agent/chat/types.js';
import type { NodeCatalogEntry } from '@/services/ai-scaffold/node-catalog.js';
import { WorkflowBuilder, type WorkflowSnapshot } from '@/services/workflow-agent/state.js';
import {
  buildWorkflowAgentPrompt,
  type WorkflowAgentPromptContext,
} from '@/services/workflow-agent/prompt.js';
import {
  listWorkflowTools,
  executeWorkflowTool,
  isFinishTool,
  type WorkflowAgentContext,
} from '@/services/workflow-agent/tools.js';
import { describeViolation } from '@/services/ai-scaffold/catalog-validator.js';

const DEFAULT_MAX_ITERATIONS = 16;

export interface WorkflowAgentStep {
  tool: string;
  ok: boolean;
}

export interface RunWorkflowAgentOptions {
  catalog: NodeCatalogEntry[];
  prompt: WorkflowAgentPromptContext;
  llmTurn: LlmTurn;
  maxIterations?: number;
  onStep?: (step: WorkflowAgentStep) => void;
  /**
   * Builder PRE-ESISTENTE (modalità MODIFICA): seedato col workflow corrente
   * (read-before-edit) prima di entrare nel loop. Se omesso, il loop ne crea uno
   * VUOTO dal catalog (modalità creazione, comportamento storico invariato).
   */
  builder?: WorkflowBuilder;
  /**
   * Primo messaggio utente del loop. In modifica descrive l'intento ("aggiungi un
   * nodo email e collegalo") + invita a leggere lo stato corrente prima di agire.
   * Default = avvio della costruzione da zero (comportamento storico invariato).
   */
  initialUserMessage?: string;
  /**
   * Prompt di sistema GIÀ assemblato (modalità modifica usa un prompt dedicato che
   * include lo stato corrente). Se omesso, è derivato da `prompt` (creazione).
   */
  systemPrompt?: string;
}

const DEFAULT_INITIAL_MESSAGE =
  'Costruisci il workflow per il goal indicato. Inizia con search_nodes.';

export interface WorkflowAgentResult {
  snapshot: WorkflowSnapshot;
  /** Violazioni di catalog ancora presenti alla fine (vuoto = workflow valido). */
  remainingIssues: string[];
  steps: WorkflowAgentStep[];
  iterations: number;
  stoppedReason: 'finish' | 'final' | 'max_iterations';
  /**
   * Testo in linguaggio naturale dell'ULTIMO turno del modello (la risposta
   * finale o l'ultimo commento prima di finish/max). In modifica lo usiamo come
   * messaggio del chatter quando il modello spiega (es. "nessun nodo adatto nel
   * catalogo, crealo nell'IDE"). Vuoto se il modello non ha mai prodotto testo.
   */
  finalText: string;
}

export async function runWorkflowAgent(
  opts: RunWorkflowAgentOptions,
): Promise<WorkflowAgentResult> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const builder = opts.builder ?? new WorkflowBuilder(opts.catalog);
  const ctx: WorkflowAgentContext = { builder, catalog: opts.catalog };
  const system = opts.systemPrompt ?? buildWorkflowAgentPrompt(opts.prompt);
  const tools = listWorkflowTools();
  const messages: ChatTurn[] = [
    { role: 'user', content: opts.initialUserMessage ?? DEFAULT_INITIAL_MESSAGE },
  ];
  const steps: WorkflowAgentStep[] = [];
  let lastText = '';

  const result = (
    reason: WorkflowAgentResult['stoppedReason'],
    iterations: number,
  ): WorkflowAgentResult => ({
    snapshot: builder.snapshot(),
    remainingIssues: builder.validate().map(describeViolation),
    steps,
    iterations,
    stoppedReason: reason,
    finalText: lastText,
  });

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const turn = await opts.llmTurn({ system, messages, tools });

    if (turn.kind === 'final') {
      if (turn.text) lastText = turn.text;
      return result('final', iteration);
    }

    if (turn.text) lastText = turn.text;
    messages.push({ role: 'assistant', content: turn.text ?? '', toolCalls: turn.toolCalls });
    for (const call of turn.toolCalls) {
      const res = executeWorkflowTool(ctx, call.name, call.args);
      // step.ok riflette l'esito dell'OPERAZIONE: il tool può eseguire (res.ok)
      // ma l'operazione del builder fallire (data.ok===false, es. defId errato).
      const opOk =
        res.ok &&
        !(
          typeof res.data === 'object' &&
          res.data !== null &&
          (res.data as { ok?: unknown }).ok === false
        );
      steps.push({ tool: call.name, ok: opOk });
      opts.onStep?.({ tool: call.name, ok: opOk });
      messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(res) });
      if (isFinishTool(call.name) && res.ok) return result('finish', iteration);
    }
  }

  return result('max_iterations', maxIterations);
}
