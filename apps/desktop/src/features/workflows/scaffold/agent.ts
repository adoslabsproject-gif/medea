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

import { describeIssues, type QualityDatabase, type QualityIssue } from '../quality';
import type { NodeDef, Workflow } from '../types';

import { WorkflowBuilder, type WorkflowSnapshot } from './builder';
import { executeWorkflowTool, WORKFLOW_AGENT_TOOLS } from './tools';
import type { Violation } from './validate';

/** Oltre questo numero di passi si ferma: un modello che gira a vuoto non
 *  deve poter consumare all'infinito. */
/** Quanti passi al massimo prima di arrendersi. Esposto perché l'interfaccia
 *  possa dire «passo 3 di 40» invece di un numero senza scala. */
export const AGENT_MAX_STEPS = 40;
const MAX_STEPS = AGENT_MAX_STEPS;

/** Quante volte gli si può dire «no, non è pronto» prima di arrendersi. Un
 *  modello che non capisce al terzo richiamo non capirà al quarto. */
const MAX_PUSHBACKS = 3;

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
  /** I problemi di qualità che hanno concorso al rifiuto. */
  qualityIssues: QualityIssue[];
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
  /** Schema dei database noti: accende i controlli su tabelle e colonne. */
  databases?: readonly QualityDatabase[];
  onStep?: (step: AgentStep) => void;
  /** Con questo si può fermare il ciclo a metà: viene guardato prima di ogni
   *  passo, e chi lo aziona ferma anche la chiamata in volo. */
  signal?: AbortSignal;
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
  const ctx = {
    builder,
    catalog: req.catalog,
    ...(req.databases ? { databases: req.databases } : {}),
  };
  const system = buildAgentSystemPrompt(req.goal, req.context, Boolean(req.seed));
  const tools = agentToolsForProvider();

  const history: AgentTurn[] = [{ role: 'user', content: req.goal }];
  const steps: AgentStep[] = [];
  let pushbacks = 0;

  for (let step = 1; step <= MAX_STEPS; step++) {
    // Fermato: si esce con quello che si è costruito fin qui, che è più utile
    // di niente — i nodi già messi restano, e si vede dove si era arrivati.
    if (req.signal?.aborted) {
      return failFrom(builder, steps, 'Interrotto.', req.databases);
    }
    let reply: { content: string; toolCalls: AgentToolCall[] };
    try {
      reply = await req.chat({ system, history, tools });
    } catch (e) {
      return failFrom(builder, steps, `Il provider non ha risposto: ${String(e)}`, req.databases);
    }

    if (reply.toolCalls.length === 0) {
      // Nessuno strumento chiamato: o ha finito senza dirlo, o si è perso.
      // Glielo si fa notare una volta, poi si chiude.
      const assessment = assess(builder, req.databases);
      if (builder.snapshot().nodes.length > 0 && assessment.blocking.length === 0) {
        return finishFrom(builder, steps, req.databases);
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

    let rejected = false;
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

      if (!outcome.done) continue;

      const assessment = assess(builder, req.databases);
      if (assessment.blocking.length === 0) return finishFrom(builder, steps, req.databases);

      // Ha dichiarato finito qualcosa che non lo è. Invece di bocciarlo
      // subito gli si dice cosa manca: quasi sempre il giro dopo lo
      // sistema, e un rifiuto secco butterebbe via tutto il lavoro fatto.
      if (pushbacks >= MAX_PUSHBACKS) {
        return failFrom(
          builder,
          steps,
          `Il workflow ha ancora ${assessment.blocking.length} problemi dopo ${String(MAX_PUSHBACKS)} richiami:\n${assessment.blocking.join('\n')}`,
          req.databases,
        );
      }
      pushbacks++;
      history.push({
        role: 'user',
        content: [
          'Non posso accettare il workflow: questi problemi lo renderebbero non funzionante.',
          ...assessment.blocking,
          '',
          'Correggili con set_config / connect / delete_node, poi richiama validate_workflow e infine finish.',
        ].join('\n'),
      });
      rejected = true;
      break;
    }
    if (rejected) continue;
  }

  return failFrom(
    builder,
    steps,
    `L'agente non ha concluso entro ${String(MAX_STEPS)} passi.`,
    req.databases,
  );
}

interface Assessment {
  violations: Violation[];
  qualityIssues: QualityIssue[];
  /** I problemi che impediscono di consegnare il workflow, già in parole. */
  blocking: string[];
}

/**
 * Il giudizio completo: forma e sostanza insieme.
 *
 * Gli avvisi non bloccano — un `logic_switch` senza ramo di default è una
 * scelta discutibile, non un errore — ma i problemi critici sì: quelli a
 * runtime si romperebbero di sicuro.
 */
function assess(builder: WorkflowBuilder, databases?: readonly QualityDatabase[]): Assessment {
  const violations = builder.validate();
  const quality = builder.quality(databases);
  const critical = quality.issues.filter((i) => i.severity === 'critical');
  return {
    violations,
    qualityIssues: quality.issues,
    blocking: [...violations.map((v) => v.message), ...describeIssues(critical)],
  };
}

function failFrom(
  builder: WorkflowBuilder,
  steps: AgentStep[],
  reason: string,
  databases?: readonly QualityDatabase[],
): AgentFailure {
  const assessment = assess(builder, databases);
  return {
    ok: false,
    steps,
    reason,
    violations: assessment.violations,
    qualityIssues: assessment.qualityIssues,
    partial: builder.snapshot(),
  };
}

/** Chiusura: si consegna solo un workflow che sta in piedi. */
function finishFrom(
  builder: WorkflowBuilder,
  steps: AgentStep[],
  databases?: readonly QualityDatabase[],
): AgentResult {
  const assessment = assess(builder, databases);
  const snapshot = builder.snapshot();

  if (assessment.blocking.length > 0) {
    return failFrom(
      builder,
      steps,
      `Il workflow ha ${assessment.blocking.length} problemi non risolti:\n${assessment.blocking.join('\n')}`,
      databases,
    );
  }

  // Ciò che resta sono avvisi e scelte da fare a mano: l'utente li vede, ma
  // il workflow funziona.
  const warnings = assessment.qualityIssues
    .filter((i) => i.severity !== 'info')
    .map((i) => i.message);

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
    remainingIssues: [
      ...builder.orphanNodes().map((id) => `Il nodo "${id}" non è collegato a nulla.`),
      ...warnings,
    ],
  };
}
