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

import type { NodeDef, Workflow } from '../types';

import { indexByDefId, selectCatalog } from './catalog';
import { parseScaffoldJson, ScaffoldParseError } from './parse';
import {
  buildScaffoldPrompt,
  SCAFFOLD_SYSTEM_PROMPT,
  SCAFFOLD_SYSTEM_PROMPT_TUNED,
} from './prompt';
import { repairScaffold } from './repair';
import { isScaffoldOutput, type ScaffoldOutput } from './schema';
import { describeViolations, validateScaffold, type Violation } from './validate';

/** Nodi sempre presenti nel catalogo mostrato al modello. */
const CORE_DEF_IDS = [
  'trigger_manual',
  'trigger_webhook',
  'trigger_cron',
  'trigger_imap',
  'logic_if',
  'logic_switch',
  'logic_loop',
  'logic_merge',
  'action_http',
  'action_send_email',
  'action_set_fields',
  'action_template',
  'db_query',
  'db_insert',
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
  tablesToCreate: ScaffoldOutput['tablesToCreate'];
}

export interface ScaffoldFailure {
  ok: false;
  attempts: number;
  /** Perché non ce l'ha fatta, in forma leggibile. */
  reason: string;
  violations: Violation[];
}

export type ScaffoldResult = ScaffoldSuccess | ScaffoldFailure;

export interface ScaffoldRequest {
  goal: string;
  catalog: NodeDef[];
  llm: ScaffoldLlm;
  resources?: string[];
  /** Notifica di avanzamento per la UI. */
  onProgress?: (phase: string, attempt: number) => void;
}

export async function runScaffold(req: ScaffoldRequest): Promise<ScaffoldResult> {
  const index = indexByDefId(req.catalog);
  const shown = selectCatalog(req.catalog, req.goal, CORE_DEF_IDS);
  const system = req.llm.isTuned ? SCAFFOLD_SYSTEM_PROMPT_TUNED : SCAFFOLD_SYSTEM_PROMPT;

  let previousErrors: string | undefined;
  let lastViolations: Violation[] = [];
  let lastReason = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
      raw = await req.llm.complete({
        system,
        user,
        schema: (await import('./schema')).SINGLESHOT_OUTPUT_SCHEMA,
      });
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

    req.onProgress?.('riparazione', attempt);
    const repairs = repairScaffold(output, index);

    req.onProgress?.('validazione', attempt);
    const violations = validateScaffold(output, index);

    if (violations.length === 0) {
      return {
        ok: true,
        workflow: {
          name: output.name,
          ...(output.description ? { description: output.description } : {}),
          nodes: output.nodes.map((n) => ({
            id: n.id,
            defId: n.defId,
            x: n.x ?? 0,
            y: n.y ?? 0,
            config: n.config,
            ...(n.label ? { label: n.label } : {}),
          })),
          edges: output.edges.map((e) => ({
            from: e.from,
            to: e.to,
            ...(e.fromPort ? { fromPort: e.fromPort } : {}),
          })),
          executionTarget: 'local',
        },
        reasoning: output.reasoning,
        attempts: attempt,
        repairs: repairs.applied,
        tablesToCreate: output.tablesToCreate,
      };
    }

    lastViolations = violations;
    lastReason = `${violations.length} problemi nel workflow generato`;
    previousErrors = describeViolations(violations);
  }

  return {
    ok: false,
    attempts: MAX_ATTEMPTS,
    reason: `Dopo ${MAX_ATTEMPTS} tentativi il workflow non è valido: ${lastReason}`,
    violations: lastViolations,
  };
}
