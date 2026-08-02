/**
 * executor-validator — giudizio sul codice executor a partire dai fatti AST
 * (executor-ast). Distingue la SEVERITÀ: `security` (costrutti vietati / import)
 * è non-negoziabile e blocca l'emissione; `error` (sintassi, firma, niente return)
 * rende il nodo inutilizzabile → alimenta il loop di repair.
 *
 * Tutte le violazioni hanno un messaggio AZIONABILE (entra nel prompt di repair).
 *
 * @module services/node-generator/executor-validator
 */
import { analyzeExecutor, type ExecutorAstFacts } from '@/services/node-generator/executor-ast.js';

export type ExecutorViolationKind =
  | 'syntax_error'
  | 'missing_execute'
  | 'not_async'
  | 'bad_arity'
  | 'no_return'
  | 'forbidden_global'
  | 'forbidden_import';

export interface ExecutorViolation {
  kind: ExecutorViolationKind;
  severity: 'security' | 'error';
  message: string;
}

/** Valida i fatti AST già estratti (separato per testabilità senza re-parse). */
export function validateExecutorFacts(facts: ExecutorAstFacts): ExecutorViolation[] {
  const out: ExecutorViolation[] = [];

  for (const e of facts.syntaxErrors) {
    out.push({
      kind: 'syntax_error',
      severity: 'error',
      message: `Errore di sintassi nell'executor: ${e}`,
    });
  }
  // Senza una funzione execute parseable non ha senso giudicare il resto.
  if (!facts.execute.found) {
    out.push({
      kind: 'missing_execute',
      severity: 'error',
      message: 'Manca la funzione `async function execute(config, input, context)`.',
    });
  } else {
    if (!facts.execute.isAsync) {
      out.push({
        kind: 'not_async',
        severity: 'error',
        message: 'La funzione `execute` deve essere `async`.',
      });
    }
    if (facts.execute.paramNames.length < 3) {
      out.push({
        kind: 'bad_arity',
        severity: 'error',
        message: 'La funzione `execute` deve avere 3 parametri: (config, input, context).',
      });
    }
    if (!facts.hasReturnValue && facts.syntaxErrors.length === 0) {
      out.push({
        kind: 'no_return',
        severity: 'error',
        message: "L'executor deve restituire un oggetto con `return { ... }`.",
      });
    }
  }
  if (facts.forbiddenRefs.length > 0) {
    out.push({
      kind: 'forbidden_global',
      severity: 'security',
      message: `L'executor referenzia identificatori vietati: ${facts.forbiddenRefs.join(', ')}. Vietati require/eval/process/globalThis/Function/fs/child_process e affini.`,
    });
  }
  if (facts.hasImport) {
    out.push({
      kind: 'forbidden_import',
      severity: 'security',
      message: "L'executor non può usare `import` (statico o dinamico). Usa il `fetch` globale.",
    });
  }
  return out;
}

/** Convenience: analizza la sorgente e valida in un colpo. */
export function validateExecutor(source: string): ExecutorViolation[] {
  return validateExecutorFacts(analyzeExecutor(source));
}

/** True se c'è almeno una violazione di sicurezza (mai emettere codice così). */
export function hasSecurityViolation(violations: readonly ExecutorViolation[]): boolean {
  return violations.some((v) => v.severity === 'security');
}
