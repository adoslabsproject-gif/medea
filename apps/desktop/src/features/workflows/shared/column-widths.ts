/**
 * Le larghezze delle colonne, e come rimetterle a posto.
 *
 * Una colonna allargata per sbaglio non deve diventare un problema: oltre al
 * doppio click sul bordo c'è un comando che riporta tutto alle misure di
 * partenza, perché quando una larghezza è sbagliata di solito lo sono anche
 * le altre.
 */

/** Le chiavi con cui le colonne dell'editor ricordano la loro misura. */
export const COLUMN_WIDTH_KEYS = [
  'medea.workflows.listWidth',
  'medea.workflows.paletteWidth',
  'medea.workflows.inspectorWidth',
  'medea.workflows.assistantWidth',
] as const;

/** Dimentica le misure salvate: alla prossima apertura valgono quelle di
 *  partenza. */
export function resetColumnWidths(): void {
  for (const key of COLUMN_WIDTH_KEYS) localStorage.removeItem(key);
}
