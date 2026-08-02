/**
 * coherence-validator — coerenza fra il NodeDef e l'executor generati.
 *
 * Un codice sintatticamente valido può comunque essere SBAGLIATO: legge
 * `config.apiKey` ma `apiKey` non è tra i configFields → a runtime sarà
 * undefined; usa un secret mai dichiarato come field `secret` → context.secrets
 * non lo conterrà; un campo `select` senza `options` è inutilizzabile in UI.
 * Questi sono i bug che un senior coglie rileggendo def+codice insieme.
 *
 * Severità `error` (rompe il nodo) vs `warning` (sospetto, non blocca). Alimenta
 * il loop di repair e, per i warning, le note all'utente. Puro.
 *
 * @module services/node-generator/coherence-validator
 */
import { analyzeExecutor } from '@/services/node-generator/executor-ast.js';

export interface CoherenceDefView {
  // `| undefined` espliciti: compatibile con NodeDef sotto exactOptionalPropertyTypes.
  configFields?:
    | readonly { key: string; type?: string | undefined; options?: readonly string[] | undefined }[]
    | undefined;
}

export type CoherenceViolationKind =
  | 'unknown_config_key'
  | 'undeclared_secret'
  | 'select_without_options';

export interface CoherenceViolation {
  kind: CoherenceViolationKind;
  severity: 'error' | 'warning';
  message: string;
}

export function validateCoherence(
  def: CoherenceDefView,
  executorSource: string,
): CoherenceViolation[] {
  const facts = analyzeExecutor(executorSource);
  const fields = def.configFields ?? [];
  const fieldKeys = new Set(fields.map((f) => f.key));
  const secretKeys = new Set(fields.filter((f) => f.type === 'secret').map((f) => f.key));
  const out: CoherenceViolation[] = [];

  // 1. config.<key> usata ma non dichiarata nei configFields.
  for (const key of facts.configKeysUsed) {
    if (!fieldKeys.has(key)) {
      out.push({
        kind: 'unknown_config_key',
        severity: 'error',
        message: `L'executor legge \`config.${key}\` ma "${key}" non è tra i configFields del nodo: aggiungilo o correggi il riferimento.`,
      });
    }
  }
  // 2. context.secrets['NAME'] usato ma NAME non è un configField di type 'secret'.
  for (const name of facts.secretsUsed) {
    if (!secretKeys.has(name)) {
      out.push({
        kind: 'undeclared_secret',
        severity: 'error',
        message: `L'executor usa il secret "${name}" ma non esiste un configField "${name}" di type "secret": dichiaralo.`,
      });
    }
  }
  // 3. campo select senza options → inutilizzabile.
  for (const f of fields) {
    if (f.type === 'select' && (!f.options || f.options.length === 0)) {
      out.push({
        kind: 'select_without_options',
        severity: 'warning',
        message: `Il configField "${f.key}" è di type "select" ma non ha "options".`,
      });
    }
  }
  return out;
}
