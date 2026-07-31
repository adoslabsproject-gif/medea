/**
 * Come si raggruppano i tipi di campo dichiarati dai nodi.
 *
 * Il catalogo usa una ventina di nomi diversi — `code`, `javascript`, `json`,
 * `sql` — che dal punto di vista di chi compila sono la stessa cosa: un
 * riquadro a larghezza fissa su più righe. Raggrupparli qui evita che lo
 * smistamento diventi una catena di venti confronti.
 */

/** Tipi che si scrivono su più righe con carattere a larghezza fissa. */
export const CODE_TYPES: ReadonlySet<string> = new Set([
  'code',
  'json',
  'javascript',
  'python',
  'sql',
  'html',
]);

/** Tipi lunghi in cui ha senso inserire riferimenti a nodi e segreti. */
export const LONG_TEXT_TYPES: ReadonlySet<string> = new Set([
  'textarea',
  'expression',
  'markdown',
  'prompt',
  'rich-text',
]);

/** Campi il cui valore si sceglie da un elenco di risorse reali. */
export const PICKER_TYPES: ReadonlySet<string> = new Set([
  'db-picker',
  'db-table-picker',
  'db-collection-picker',
  'workflow-picker',
  'credential-picker',
  'file-picker',
  'directory-picker',
  'account-picker',
  'email-account-picker',
]);

/** Il valore di un campo in forma testuale, senza mai "[object Object]". */
export function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value);
}
