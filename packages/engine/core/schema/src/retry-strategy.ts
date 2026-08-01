/**
 * Retry ownership — UN SOLO livello di retry, mai annidato (review nodi).
 *
 * Problema: alcuni nodi (es. action_http) ritentano INTERNAMENTE con semantica ricca
 * (retryOnStatus + Retry-After), MENTRE l'engine ha un proprio retry loop su
 * `config.retryCount`. Senza coordinamento → retry ANNIDATO (3×3 = 9 tentativi reali),
 * latenza e ban provider.
 *
 * Soluzione: una sola fonte di verità su CHI ritenta. Lo stesso resolver è usato
 * dall'engine (decide se il loop dell'engine è attivo) E dal nodo self-managed (decide
 * se il suo retry interno è attivo). Mutua esclusione garantita: per ogni (config,
 * capability) esattamente uno dei due è "owner".
 *
 * Modulo PURO (zero IO) → testabile e condiviso (engine runtime + stdlib).
 */

/** Strategia retry dichiarabile sulla config del nodo. `auto` = decide la capability del nodo. */
export type RetryStrategy = 'auto' | 'workflow' | 'node' | 'none';

/** Chi possiede il retry per un nodo. */
export type RetryOwner = 'workflow' | 'node' | 'none';

const VALID: ReadonlySet<string> = new Set(['workflow', 'node', 'none']);

/**
 * Risolve il proprietario del retry.
 *
 * @param explicit   valore `retryStrategy` dalla config nodo (qualunque cosa, anche
 *                   undefined/garbage → trattato come 'auto').
 * @param selfManagedRetry  true se il NodeDef dichiara di gestire il retry da sé
 *                   (es. action_http). Determina il default in modalità 'auto'.
 *
 * Regole:
 *  - explicit ∈ {workflow,node,none} → vince (override esplicito dell'utente).
 *  - altrimenti (auto / valore ignoto) → 'node' se il nodo è self-managed, sennò 'workflow'.
 *
 * Invariante: il risultato è esattamente uno tra workflow|node|none → MAI doppio retry.
 */
export function resolveRetryOwner(explicit: unknown, selfManagedRetry: boolean): RetryOwner {
  const norm = typeof explicit === 'string' ? explicit.trim().toLowerCase() : '';
  if (VALID.has(norm)) return norm as RetryOwner;
  return selfManagedRetry ? 'node' : 'workflow';
}

/** L'engine applica il suo retry loop SOLO se è lui l'owner. */
export function engineRetriesNode(explicit: unknown, selfManagedRetry: boolean): boolean {
  return resolveRetryOwner(explicit, selfManagedRetry) === 'workflow';
}

/** Un nodo self-managed ritenta internamente SOLO se è lui l'owner. */
export function nodeRetriesInternally(explicit: unknown, selfManagedRetry: boolean): boolean {
  return resolveRetryOwner(explicit, selfManagedRetry) === 'node';
}
