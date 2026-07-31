/**
 * Il loop dell'agente: costruisce il workflow un passo alla volta.
 *
 * A differenza della generazione in un colpo solo, qui il modello **vede il
 * catalogo mentre lavora**: cerca il nodo, ne legge lo schema, lo aggiunge,
 * lo configura, valida e chiude. È il motivo per cui funziona anche con un
 * provider che non conosce i nodi: non deve ricordarli, li interroga.
 *
 * È anche l'unica modalità che sa MODIFICARE un workflow esistente, partendo
 * dal suo stato invece di rigenerarlo da capo.
 */

import type { NodeDef, Workflow } from '../types';

import { WorkflowBuilder, type WorkflowSnapshot } from './builder';
import { executeWorkflowTool, WORKFLOW_AGENT_TOOLS } from './tools';
import { describeViolations, type Violation } from './validate';

/** Oltre questo numero di passi si ferma: un modello che gira a vuoto non
 *  deve poter consumare all'infinito. */
const MAX_STEPS = 40;

/** Chiamata a tool emessa dal modello, nella forma normalizzata dal backend. */
export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentTurn {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  toolCallId?: string;
  name?: string;
}

/** Il canale verso il modello. Astratto: l'agente non sa quale provider ci sia. */
export type AgentChat = (args: {
  system: string;
  history: AgentTurn[];
  tools: { type: 'function'; function: Record<string, unknown> }[];
}) => Promise<{ content: string; toolCalls: AgentToolCall[] }>;

export interface AgentStep {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface AgentSuccess {
  ok: true;
  workflow: Workflow;
  steps: AgentStep[];
  /** Problemi rimasti che l'utente dovrà sistemare a mano (es. scelte da menu). */
  remainingIssues: string[];
}

export interface AgentFailure {
  ok: false;
  steps: AgentStep[];
  reason: string;
  violations: Violation[];
  /** Lo stato raggiunto: anche incompleto può valere la pena mostrarlo. */
  partial?: WorkflowSnapshot;
}

export type AgentResult = AgentSuccess | AgentFailure;

export interface AgentRequest {
  goal: string;
  catalog: NodeDef[];
  chat: AgentChat;
  /** Workflow da modificare invece di crearne uno nuovo. */
  seed?: Workflow;
  /** Risorse reali: database, account email, credenziali disponibili. */
  context?: string;
  onStep?: (step: AgentStep) => void;
}

export function buildAgentSystemPrompt(goal: string, context?: string, isModify = false): string {
  return [
    'Sei un ingegnere di automazione che costruisce workflow usando gli strumenti a disposizione.',
    '',
    isModify
      ? 'Stai MODIFICANDO un workflow esistente: leggilo prima di cambiarlo, e tocca solo ciò che serve.'
      : 'Costruisci il workflow UN PASSO ALLA VOLTA, non tutto in una volta:',
    '1. `search_nodes` per TROVARE il nodo giusto (non inventare defId).',
    '2. `get_node_schema` per leggere i campi del nodo prima di configurarlo.',
    '3. `add_node` per aggiungerlo; `set_config` per completarne i campi obbligatori.',
    "4. `connect` per collegare i nodi nell'ordine del flusso (trigger → azioni).",
    '5. `validate_workflow` per controllare; correggi le issue segnalate.',
    '6. `finish` SOLO quando validate_workflow non riporta più problemi.',
    '',
    'Regole:',
    '- Inizia SEMPRE da un nodo trigger.',
    '- Riempi i campi obbligatori con valori realistici dedotti dal goal; i segreti',
    '  (API key, password) vanno come `{{secrets.NOME}}`.',
    "- Per riferire l'output di un nodo precedente usa espressioni `{{$node.<id>.json.<campo>}}`.",
    '- Non aggiungere nodi inutili: il minimo che realizza il goal.',
    '',
    `GOAL: ${goal}`,
    ...(context?.trim() ? ['', 'CONTESTO:', context.trim()] : []),
  ].join('\n');
}

/** I tool nel formato che il backend passa al provider. */
export function agentToolsForProvider(): { type: 'function'; function: Record<string, unknown> }[] {
  return WORKFLOW_AGENT_TOOLS.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export async function runWorkflowAgent(req: AgentRequest): Promise<AgentResult> {
  const builder = new WorkflowBuilder(
    req.catalog,
    req.seed?.name ?? 'Nuovo workflow',
    req.seed?.description,
    req.seed ? { nodes: req.seed.nodes, edges: req.seed.edges } : undefined,
  );
  const ctx = { builder, catalog: req.catalog };
  const system = buildAgentSystemPrompt(req.goal, req.context, Boolean(req.seed));
  const tools = agentToolsForProvider();

  const history: AgentTurn[] = [{ role: 'user', content: req.goal }];
  const steps: AgentStep[] = [];

  for (let step = 1; step <= MAX_STEPS; step++) {
    let reply: { content: string; toolCalls: AgentToolCall[] };
    try {
      reply = await req.chat({ system, history, tools });
    } catch (e) {
      return {
        ok: false,
        steps,
        reason: `Il provider non ha risposto: ${String(e)}`,
        violations: builder.validate(),
        partial: builder.snapshot(),
      };
    }

    if (reply.toolCalls.length === 0) {
      // Nessuno strumento chiamato: o ha finito senza dirlo, o si è perso.
      // Glielo si fa notare una volta, poi si chiude.
      const violations = builder.validate();
      if (builder.snapshot().nodes.length > 0 && violations.length === 0) {
        return finishFrom(builder, steps);
      }
      history.push(
        { role: 'assistant', content: reply.content },
        {
          role: 'user',
          content:
            'Non hai chiamato nessuno strumento. Prosegui usando gli strumenti: search_nodes, add_node, connect, validate_workflow, e infine finish.',
        },
      );
      continue;
    }

    history.push({
      role: 'assistant',
      content: reply.content,
      toolCalls: reply.toolCalls.map((c) => ({
        id: c.id,
        type: 'function' as const,
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      })),
    });

    for (const call of reply.toolCalls) {
      const outcome = executeWorkflowTool(ctx, call.name, call.arguments);
      const record: AgentStep = {
        step: steps.length + 1,
        tool: call.name,
        args: call.arguments,
        result: outcome.data,
      };
      steps.push(record);
      req.onStep?.(record);

      history.push({
        role: 'tool',
        content: JSON.stringify(outcome.data),
        toolCallId: call.id,
        name: call.name,
      });

      if (outcome.done) {
        return finishFrom(builder, steps);
      }
    }
  }

  const violations = builder.validate();
  return {
    ok: false,
    steps,
    reason: `L'agente non ha concluso entro ${MAX_STEPS} passi.`,
    violations,
    partial: builder.snapshot(),
  };
}

/** Chiusura: si accetta solo un workflow che supera la validazione. */
function finishFrom(builder: WorkflowBuilder, steps: AgentStep[]): AgentResult {
  const violations = builder.validate();
  const snapshot = builder.snapshot();

  if (violations.length > 0) {
    return {
      ok: false,
      steps,
      reason: `Il workflow ha ${violations.length} problemi non risolti:\n${describeViolations(violations)}`,
      violations,
      partial: snapshot,
    };
  }

  return {
    ok: true,
    workflow: {
      name: snapshot.name,
      ...(snapshot.description ? { description: snapshot.description } : {}),
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      executionTarget: 'local',
    },
    steps,
    remainingIssues: builder.orphanNodes().map((id) => `Il nodo "${id}" non è collegato a nulla.`),
  };
}
