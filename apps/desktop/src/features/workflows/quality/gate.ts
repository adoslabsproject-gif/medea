/**
 * Il quality gate: tutte le regole in un colpo, con un verdetto.
 *
 * La promessa che difende è una sola — quando l'utente preme «Importa», il
 * workflow funziona. Un problema `critical` significa che a runtime si
 * romperebbe di sicuro, quindi il workflow non passa e i problemi tornano al
 * modello perché li corregga. Un problema `medium` è un avviso: il workflow
 * gira, ma qualcosa non è come dovrebbe. `info` è solo una nota.
 */

import type { CanvasNode, Workflow, WorkflowEdge } from '../types';

import {
  checkCodeNodeLangMismatch,
  checkObsoleteModel,
  checkSwitchDefault,
  checkSwitchInvalidCaseKey,
} from './rules-config';
import { checkDbColumnNotInSchema, checkDbTableNotInSchema } from './rules-db';
import {
  checkCircularReferences,
  checkDeadEnd,
  checkDuplicateNodes,
  checkOrphanTriggers,
} from './rules-graph';
import {
  checkAuditNotTerminal,
  checkSensitiveHardcoded,
  checkTriggerWithoutAction,
} from './rules-intent';
import { checkMockPlaceholders, checkSuspiciousResourceIds } from './rules-placeholder';
import {
  checkErrorBranchInverted,
  checkErrorHandlerNoSink,
  checkLookupWithoutBranch,
} from './rules-semantic';
import {
  checkAggregationInsideLoop,
  checkArrayToScalarWithoutLoop,
  checkFanInWithoutMerge,
} from './rules-shape';
import type {
  QualityDatabase,
  QualityGateInput,
  QualityGateResult,
  QualityIssue,
  QualityRule,
  QualitySeverity,
} from './types';

/** Le 21 regole, nell'ordine in cui vengono applicate. L'ordine non cambia il
 *  verdetto — i problemi vengono comunque riordinati per gravità — ma tiene
 *  l'elenco leggibile: prima la struttura, poi i valori, poi il senso. */
export const QUALITY_RULES: readonly { code: string; run: QualityRule }[] = [
  { code: 'ORPHAN_TRIGGER', run: checkOrphanTriggers },
  { code: 'CIRCULAR_REFERENCE', run: checkCircularReferences },
  { code: 'DEAD_END_BRANCH', run: checkDeadEnd },
  { code: 'DUPLICATE_NODES', run: checkDuplicateNodes },
  { code: 'ARRAY_TO_SCALAR_WITHOUT_LOOP', run: checkArrayToScalarWithoutLoop },
  { code: 'FAN_IN_WITHOUT_MERGE', run: checkFanInWithoutMerge },
  { code: 'AGGREGATION_INSIDE_LOOP', run: checkAggregationInsideLoop },
  { code: 'MOCK_PLACEHOLDER', run: checkMockPlaceholders },
  { code: 'SUSPICIOUS_RESOURCE_ID', run: checkSuspiciousResourceIds },
  { code: 'SWITCH_NO_DEFAULT', run: checkSwitchDefault },
  { code: 'SWITCH_INVALID_CASE_KEY', run: checkSwitchInvalidCaseKey },
  { code: 'CODE_NODE_LANG_MISMATCH', run: checkCodeNodeLangMismatch },
  { code: 'OBSOLETE_MODEL', run: checkObsoleteModel },
  { code: 'DB_TABLE_NOT_IN_SCHEMA', run: checkDbTableNotInSchema },
  { code: 'DB_COLUMN_NOT_IN_SCHEMA', run: checkDbColumnNotInSchema },
  { code: 'ERROR_BRANCH_INVERTED', run: checkErrorBranchInverted },
  { code: 'ERROR_HANDLER_NO_SINK', run: checkErrorHandlerNoSink },
  { code: 'LOOKUP_WITHOUT_BRANCH', run: checkLookupWithoutBranch },
  { code: 'TRIGGER_WITHOUT_ACTION', run: checkTriggerWithoutAction },
  { code: 'AUDIT_NOT_TERMINAL', run: checkAuditNotTerminal },
  { code: 'SENSITIVE_HARDCODED', run: checkSensitiveHardcoded },
];

const SEVERITY_RANK: Record<QualitySeverity, number> = { critical: 0, medium: 1, info: 2 };

export function runQualityGate(input: QualityGateInput): QualityGateResult {
  const issues: QualityIssue[] = [];
  for (const rule of QUALITY_RULES) issues.push(...rule.run(input));

  // Ordine stabile: prima i problemi gravi, poi per nodo. Lo stesso workflow
  // deve produrre sempre lo stesso elenco, altrimenti i test e il confronto
  // fra due tentativi diventano inaffidabili.
  issues.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return (a.nodeId ?? '').localeCompare(b.nodeId ?? '');
  });

  const shouldReject = issues.some((i) => i.severity === 'critical');
  return { ok: !shouldReject, issues, shouldReject };
}

/** Il gate applicato a un workflow completo. */
export function gateWorkflow(
  workflow: Pick<Workflow, 'nodes' | 'edges'>,
  databases?: readonly QualityDatabase[],
): QualityGateResult {
  return runQualityGate(toGateInput(workflow.nodes, workflow.edges, databases));
}

export function toGateInput(
  nodes: readonly CanvasNode[],
  edges: readonly WorkflowEdge[],
  databases?: readonly QualityDatabase[],
): QualityGateInput {
  return {
    nodes: nodes.map((n) => ({ id: n.id, defId: n.defId, config: n.config })),
    edges: edges.map((e) => ({
      from: e.from,
      to: e.to,
      ...(e.fromPort ? { fromPort: e.fromPort } : {}),
    })),
    ...(databases ? { databases } : {}),
  };
}

/** I problemi in forma leggibile dal modello, per il giro di correzione. */
export function describeIssues(issues: readonly QualityIssue[]): string[] {
  return issues.map((i) => {
    const where = i.nodeId ? ` [nodo ${i.nodeId}${i.field ? `.${i.field}` : ''}]` : '';
    return `${i.severity.toUpperCase()} ${i.code}${where}: ${i.message}`;
  });
}
