/**
 * Safe JSON parser — non-throwing wrapper di `JSON.parse`.
 *
 * Motivazione: `JSON.parse` throw su input malformato → boundary attorno
 * a fonti non-fidate richiede sempre try/catch. Senza wrapper, ogni
 * caller scrive try/catch boilerplate. Worse: alcuni caller saltano il
 * try e crashano l'event loop quando l'LLM/external API restituisce HTML
 * 5xx invece di JSON, o quando una row DB ha valore corrotto.
 *
 * Loci protetti:
 *   - orchestrator parsing `tool_calls.function.arguments` da LLM
 *   - executors db-write/db-query con value da SQLite
 *   - LLM provider adapters (Anthropic/OpenAI response.body)
 *
 * Pattern: `Result<T, Error>` discriminato — il caller deve esplicitamente
 * gestire `ok === false` (vs `value === null` ambiguo: null è un JSON valido).
 */

export type SafeJsonResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error };

export function safeJsonParse<T = unknown>(input: string): SafeJsonResult<T> {
  if (typeof input !== 'string') {
    return { ok: false, error: new TypeError(`Expected string, got ${typeof input}`) };
  }
  try {
    return { ok: true, value: JSON.parse(input) as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/**
 * Variante con fallback — utile quando un valore di default vale più di
 * un branching del caller. Non perdiamo error context: se serve loggare
 * il parse failure, usare `safeJsonParse` invece.
 */
export function safeJsonParseOr<T>(input: string, fallback: T): T {
  const r = safeJsonParse<T>(input);
  return r.ok ? r.value : fallback;
}
