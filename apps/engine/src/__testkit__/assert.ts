/**
 * Test assertion helpers — narrowing type-safe per accessi ad array/optional.
 *
 * Perché esistono: `noUncheckedIndexedAccess` rende `arr[0]` di tipo `T |
 * undefined`. La scorciatoia `arr[0]!` (non-null assertion) silenzia il
 * compilatore ma NON rende il test più robusto: se l'array è vuoto il test
 * crasha lo stesso, con un `TypeError` criptico invece di dire COSA mancava.
 *
 * Questi helper fanno l'opposto: asseriscono l'invariante in modo esplicito
 * (documentazione viva), restringono davvero il tipo (TS riconosce `asserts`
 * / il return type), e falliscono con un messaggio che nomina l'elemento e la
 * lunghezza reale dell'array. Un test che si rompe lo fa parlando.
 */

/** Lancia se `value` è null/undefined; altrimenti lo restringe a `T`. */
export function assertDefined<T>(
  value: T | null | undefined,
  label = 'value',
): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(`assertDefined: ${label} è ${value === null ? 'null' : 'undefined'} (atteso definito)`);
  }
}

/** Ritorna `arr[index]`, lanciando con contesto (indice + lunghezza) se assente. */
export function at<T>(arr: readonly T[], index: number, label = 'array'): T {
  const value = arr[index];
  if (value === undefined) {
    throw new Error(`at: ${label}[${index}] è undefined (len=${arr.length})`);
  }
  return value;
}

/** Primo elemento di `arr`, lanciando con contesto se l'array è vuoto. */
export function first<T>(arr: readonly T[], label = 'array'): T {
  return at(arr, 0, label);
}
