/**
 * Il ciclo dello scaffold: genera, ripara, valida, e se serve riprova.
 *
 * La garanzia non sta nel modello ma qui: `runScaffold` restituisce un
 * workflow **valido** oppure un fallimento esplicito con il motivo. Non
 * esiste un terzo esito in cui salviamo qualcosa di rotto.
 *
 * Il numero di tentativi usati è la misura della qualità del provider: un
 * modello addestrato su questo compito ne usa uno, uno generico due o tre.
 */

import {
  describeIssues,
  runQualityGate,
  toGateInput,
  type QualityDatabase,
  type QualityIssue,
} from '../quality';
import type { CanvasNode, NodeDef, Workflow, WorkflowEdge } from '../types';

import { indexByDefId, selectCatalog } from './catalog';
import { parseScaffoldJson, ScaffoldParseError } from './parse';
import {
  buildScaffoldPrompt,
  SCAFFOLD_SYSTEM_PROMPT,
  SCAFFOLD_SYSTEM_PROMPT_TUNED,
} from './prompt';
import { repairScaffold } from './repair';
import { isScaffoldOutput, schemaConDefIdAmmessi, type ScaffoldOutput } from './schema';
import { describeViolations, validateScaffold, type Violation } from './validate';

/**
 * Nodi sempre presenti nel catalogo mostrato al modello.
 *
 * Copia esatta di `SCAFFOLD_CORE_DEFIDS` del server
 * (`services/catalog-retrieval/scaffold-catalog.ts`). Non è una lista di
 * comodo: il dataset di addestramento è costruito su questi, quindi togliere
 * o aggiungere una voce disallinea il modello dal catalogo che riceve.
 */
export const SCAFFOLD_CORE_DEFIDS: readonly string[] = [
  'trigger_manual',
  'trigger_webhook',
  'trigger_cron',
  'trigger_imap',
  'trigger_form',
  'logic_if',
  'logic_switch',
  'logic_loop',
  'logic_merge',
  'logic_wait',
  'logic_filter',
  'action_http',
  'action_run_js',
  'action_run_python',
  'action_set_fields',
  'action_template',
  'action_json',
  'action_file_write',
  'action_send_email',
  'action_webhook_respond',
  'db_query',
  'db_insert',
  'db_update',
  'agent_extractor',
  'agent_chat',
];

const MAX_ATTEMPTS = 3;

/** Chi sa parlare col modello. Astratto di proposito: lo scaffold non deve
 *  sapere quale provider c'è sotto. */
export interface ScaffoldLlm {
  /** `true` se il provider sa vincolare l'output allo schema da solo. */
  supportsStructuredOutput: boolean;
  /** `true` per i modelli addestrati su questo compito (prompt compatto). */
  isTuned?: boolean;
  complete(args: { system: string; user: string; schema: object }): Promise<string>;
}

export interface ScaffoldSuccess {
  ok: true;
  workflow: Workflow;
  reasoning: string;
  /** Quanti giri sono serviti: 1 è l'ideale. */
  attempts: number;
  /** Correzioni applicate senza disturbare il modello. */
  repairs: string[];
  /** Avvisi rimasti: il workflow funziona, ma qualcosa merita un'occhiata. */
  warnings: string[];
  tablesToCreate: ScaffoldOutput['tablesToCreate'];
}

export interface ScaffoldFailure {
  ok: false;
  attempts: number;
  /** Perché non ce l'ha fatta, in forma leggibile. */
  reason: string;
  violations: Violation[];
  /** I problemi di qualità dell'ultimo tentativo. */
  qualityIssues: QualityIssue[];
}

export type ScaffoldResult = ScaffoldSuccess | ScaffoldFailure;

export interface ScaffoldRequest {
  goal: string;
  catalog: NodeDef[];
  llm: ScaffoldLlm;
  resources?: string[];
  /** Schema dei database noti: accende i controlli su tabelle e colonne. */
  databases?: readonly QualityDatabase[];
  /** Notifica di avanzamento per la UI. */
  onProgress?: (phase: string, attempt: number) => void;
  /** Per fermare la costruzione a metà. */
  signal?: AbortSignal;
}

export async function runScaffold(req: ScaffoldRequest): Promise<ScaffoldResult> {
  const index = indexByDefId(req.catalog);
  const shown = selectCatalog(req.catalog, req.goal, [...SCAFFOLD_CORE_DEFIDS]);
  const system = req.llm.isTuned ? SCAFFOLD_SYSTEM_PROMPT_TUNED : SCAFFOLD_SYSTEM_PROMPT;
  // I nodi che il modello può nominare sono esattamente quelli che gli
  // mostriamo: elencarli nello schema rende l'invenzione impossibile invece
  // che da correggere dopo.
  const schemaAmmesso = schemaConDefIdAmmessi(shown.map((d) => d.defId));

  let previousErrors: string | undefined;
  let lastViolations: Violation[] = [];
  let lastQualityIssues: QualityIssue[] = [];
  let lastReason = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Fermato fra un tentativo e l'altro: non se ne comincia un altro.
    if (req.signal?.aborted) {
      return {
        ok: false,
        attempts: attempt - 1,
        reason: 'Interrotto.',
        violations: lastViolations,
        qualityIssues: lastQualityIssues,
      };
    }
    req.onProgress?.('generazione', attempt);

    const user = buildScaffoldPrompt({
      goal: req.goal,
      catalog: shown,
      ...(req.resources ? { resources: req.resources } : {}),
      ...(previousErrors ? { previousErrors } : {}),
      inlineSchema: !req.llm.supportsStructuredOutput,
    });

    let raw: string;
    try {
      raw = await req.llm.complete({ system, user, schema: schemaAmmesso });
    } catch (e) {
      lastReason = `Il provider non ha risposto: ${String(e)}`;
      previousErrors = lastReason;
      continue;
    }

    let output: ScaffoldOutput;
    try {
      const parsed = parseScaffoldJson(raw);
      if (!isScaffoldOutput(parsed)) {
        throw new ScaffoldParseError(
          'Mancano campi obbligatori: servono name, reasoning, nodes ed edges.',
        );
      }
      output = parsed;
    } catch (e) {
      lastReason = e instanceof Error ? e.message : String(e);
      previousErrors = `L'output non era leggibile: ${lastReason}\nRispondi SOLO con l'oggetto JSON.`;
      continue;
    }

    // Riparazione e validazione non devono MAI propagare un'eccezione: un
    // output patologico si traduce in un tentativo fallito, non in un crash.
    let repairs: { applied: string[] };
    let violations: Violation[];
    try {
      req.onProgress?.('riparazione', attempt);
      repairs = repairScaffold(output, index);

      req.onProgress?.('validazione', attempt);
      violations = validateScaffold(output, index);
    } catch (e) {
      lastReason = `L'output ha una forma imprevista: ${e instanceof Error ? e.message : String(e)}`;
      previousErrors = `${lastReason}\nRispondi SOLO con l'oggetto JSON conforme allo schema.`;
      continue;
    }

    if (violations.length > 0) {
      lastViolations = violations;
      lastReason = `${violations.length} problemi nel workflow generato`;
      previousErrors = describeViolations(violations);
      continue;
    }

    // La forma è a posto; resta da capire se funzionerà. Il gate di qualità
    // guarda quello che la validazione non può vedere: segnaposto, cicli,
    // riferimenti a nodi non ancora eseguiti.
    req.onProgress?.('qualità', attempt);
    const nodes = toCanvasNodes(output);
    const edges = toWorkflowEdges(output);
    const quality = runQualityGate(
      toGateInput(nodes, edges, req.databases, new Map(req.catalog.map((d) => [d.defId, d]))),
    );
    lastQualityIssues = quality.issues;

    if (quality.shouldReject) {
      const critical = quality.issues.filter((i) => i.severity === 'critical');
      lastReason = `${critical.length} problemi che renderebbero il workflow non funzionante`;
      previousErrors = describeIssues(critical).join('\n');
      continue;
    }

    return {
      ok: true,
      workflow: {
        name: output.name,
        ...(output.description ? { description: output.description } : {}),
        nodes,
        edges,
        executionTarget: 'local',
      },
      reasoning: output.reasoning,
      attempts: attempt,
      repairs: repairs.applied,
      warnings: quality.issues.filter((i) => i.severity !== 'info').map((i) => i.message),
      tablesToCreate: output.tablesToCreate,
    };
  }

  return {
    ok: false,
    attempts: MAX_ATTEMPTS,
    reason: `Dopo ${MAX_ATTEMPTS} tentativi il workflow non è valido: ${lastReason}`,
    violations: lastViolations,
    qualityIssues: lastQualityIssues,
  };
}

function toCanvasNodes(output: ScaffoldOutput): CanvasNode[] {
  return output.nodes.map((n) => ({
    id: n.id,
    defId: n.defId,
    x: n.x ?? 0,
    y: n.y ?? 0,
    config: n.config,
    ...(n.label ? { label: n.label } : {}),
  }));
}

function toWorkflowEdges(output: ScaffoldOutput): WorkflowEdge[] {
  return output.edges.map((e) => ({
    from: e.from,
    to: e.to,
    ...(e.fromPort ? { fromPort: e.fromPort } : {}),
  }));
}
