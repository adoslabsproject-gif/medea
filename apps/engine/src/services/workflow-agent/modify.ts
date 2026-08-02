/**
 * modify — orchestratore della MODIFICA agentica di un workflow esistente
 * (parità chatter↔creazione, GAP #1).
 *
 * Porta il chatter di modifica allo STESSO livello agentico della creazione: non
 * un router deterministico a 5 tool deboli, ma il loop a strumenti del
 * workflow-agent applicato a un workflow ESISTENTE. Pipeline (come farebbe Claude
 * Code):
 *   1. SEED del builder col workflow corrente  → read-before-edit
 *   2. LOOP agentico (search/add/connect/set_config/delete/disconnect/validate)
 *      con feedback immediato dei tool → il modello si auto-corregge in-loop
 *   3. pending-secrets → AVVISO sui segreti ancora da configurare a mano
 *   4. DIFF snapshot iniziale↔finale → `WorkflowPatch` (lo stesso che l'editor
 *      già renderizza con Accept/Reject e applica)
 *
 * Provider-agnostico (LlmTurn INIETTATO → testabile senza modello reale, niente
 * greensmoke). Niente I/O qui: workflow corrente e segreti configurati sono
 * passati dal chiamante (la route li carica dal DB del tenant).
 *
 * @module services/workflow-agent/modify
 */
import type { NodeCatalogEntry } from '@/services/ai-scaffold/node-catalog.js';
import type { LlmTurn } from '@/services/db-agent/chat/types.js';
import {
  analyzePendingSecrets,
  type PendingSecretRef,
} from '@/services/ai-scaffold/pending-secrets.js';
import { runWorkflowAgent, type WorkflowAgentStep } from '@/services/workflow-agent/loop.js';
import { WorkflowBuilder, type WorkflowSnapshot } from '@/services/workflow-agent/state.js';
import { buildWorkflowModifyPrompt } from '@/services/workflow-agent/modify-prompt.js';
import { diffSnapshots, patchHasOps, type WorkflowPatch } from '@/services/workflow-agent/diff.js';

export interface ModifyWorkflowInput {
  catalog: NodeCatalogEntry[];
  /** Workflow ESISTENTE da modificare (nodi+edge correnti). */
  currentWorkflow: WorkflowSnapshot;
  /** Messaggio dell'utente dal chatter dell'editor. */
  request: string;
  llmTurn: LlmTurn;
  /** Segreti già configurati sul tenant (per l'avviso pending-secrets). */
  configuredSecrets: ReadonlySet<string>;
  /** Contesto opzionale (DB del tenant, credenziali disponibili). */
  extraContext?: string;
  maxIterations?: number;
  onStep?: (step: WorkflowAgentStep) => void;
}

export interface ModifyWorkflowResult {
  /** Patch da proporre all'editor (vuoto se nessuna modifica). */
  patch: WorkflowPatch;
  /** Segreti referenziati e NON ancora configurati (banner "Configura ora"). */
  pendingSecrets: PendingSecretRef[];
  /** Violazioni di catalog residue nel workflow risultante. */
  remainingIssues: string[];
  /** Messaggio in italiano per il chatter. */
  message: string;
  steps: WorkflowAgentStep[];
  iterations: number;
  stoppedReason: 'finish' | 'final' | 'max_iterations';
}

/**
 * Riassunto in italiano DETERMINISTICO della modifica: conta le operazioni del
 * patch + segnala issue residue e segreti da configurare. Se il modello ha dato
 * una spiegazione testuale (es. "crea il nodo nell'IDE") e non ci sono modifiche,
 * usa quella. Puro → testabile.
 */
export function summarizeModification(
  patch: WorkflowPatch,
  remainingIssues: string[],
  pendingSecrets: PendingSecretRef[],
  modelText: string,
): string {
  if (!patchHasOps(patch)) {
    const t = modelText.trim();
    return t.length > 0
      ? t
      : 'Non ho applicato modifiche: la richiesta non comporta cambiamenti al workflow.';
  }
  const parts: string[] = [];
  const added = patch.addNodes?.length ?? 0;
  const removed = patch.removeNodeIds?.length ?? 0;
  const updated = patch.updateNodes?.length ?? 0;
  const edgesAdded = patch.addEdges?.length ?? 0;
  const edgesRemoved = patch.removeEdgeIds?.length ?? 0;
  if (added > 0) parts.push(`aggiunto ${added.toString()} nodo/i`);
  if (updated > 0) parts.push(`riconfigurato ${updated.toString()} nodo/i`);
  if (removed > 0) parts.push(`rimosso ${removed.toString()} nodo/i`);
  if (edgesAdded > 0) parts.push(`creato ${edgesAdded.toString()} collegamento/i`);
  if (edgesRemoved > 0) parts.push(`rimosso ${edgesRemoved.toString()} collegamento/i`);
  const lines = [
    `Ho preparato questa modifica: ${parts.join(', ')}. Controlla l'anteprima e conferma.`,
  ];
  if (pendingSecrets.length > 0) {
    const names = pendingSecrets.map((s) => s.name).join(', ');
    lines.push(`⚠️ Da configurare a mano prima di attivare: ${names}.`);
  }
  if (remainingIssues.length > 0) {
    lines.push(`⚠️ Restano da sistemare: ${remainingIssues.join(' ')}`);
  }
  return lines.join('\n');
}

export async function modifyWorkflow(input: ModifyWorkflowInput): Promise<ModifyWorkflowResult> {
  const builder = new WorkflowBuilder(input.catalog);
  builder.seed(input.currentWorkflow);

  const systemPrompt = buildWorkflowModifyPrompt({
    currentWorkflow: input.currentWorkflow,
    request: input.request,
    ...(input.extraContext ? { extraContext: input.extraContext } : {}),
  });

  const agent = await runWorkflowAgent({
    catalog: input.catalog,
    prompt: {
      goal: input.request,
      ...(input.extraContext ? { extraContext: input.extraContext } : {}),
    },
    llmTurn: input.llmTurn,
    builder,
    systemPrompt,
    initialUserMessage: `Modifica il workflow secondo questa richiesta: ${input.request}. Leggi lo stato corrente sopra prima di agire.`,
    ...(input.maxIterations ? { maxIterations: input.maxIterations } : {}),
    ...(input.onStep ? { onStep: input.onStep } : {}),
  });

  const patch = diffSnapshots(input.currentWorkflow, agent.snapshot);
  const pendingSecrets = analyzePendingSecrets({
    nodes: agent.snapshot.nodes.map((n) => ({ id: n.id, config: n.config })),
    configuredSecrets: input.configuredSecrets,
  });
  const message = summarizeModification(
    patch,
    agent.remainingIssues,
    pendingSecrets,
    agent.finalText,
  );

  return {
    patch,
    pendingSecrets,
    remainingIssues: agent.remainingIssues,
    message,
    steps: agent.steps,
    iterations: agent.iterations,
    stoppedReason: agent.stoppedReason,
  };
}
