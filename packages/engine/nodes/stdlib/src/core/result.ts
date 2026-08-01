/**
 * Result<T, E> — tipo functional Either per error handling esplicito.
 *
 * Sostituisce il pattern `throw new Error()` con un valore tipato che il chiamante
 * DEVE discriminare. Vantaggi enterprise vs throw:
 *   • Errori sono parte della firma tipata (non esiste "throws checked" in TS,
 *     ma il chiamante non puo\` ignorare un Result senza fare narrowing).
 *   • Compongono con .map / .flatMap senza try/catch nidificati.
 *   • Engine puo\` distinguere errori retryable da non-retryable senza sniffing.
 *
 * Convenzione: gli executor v2 ritornano Result. Il middleware "throw-shim"
 * converte un throw legacy in Err automaticamente per back-compat.
 *
 * Reference design: Rust std::result, fp-ts Either, Effect Effect.either.
 */

export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T, E = never>(value: T): Result<T, E> => ({ ok: true, value });
export const err = <E, T = never>(error: E): Result<T, E> => ({ ok: false, error });

export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is { ok: false; error: E } {
  return !r.ok;
}

/**
 * Map the success branch. Errors pass through untouched.
 *
 *   ok(5).pipe(map(x => x * 2))   → ok(10)
 *   err('x').pipe(map(x => x*2))  → err('x')
 */
export function map<T, U, E>(r: Result<T, E>, fn: (v: T) => U): Result<U, E> {
  return r.ok ? ok(fn(r.value)) : r;
}

/**
 * Chain a second Result-producing function. Short-circuits on the first error.
 *
 *   ok(5).pipe(flatMap(x => x > 0 ? ok(x) : err('neg')))
 */
export function flatMap<T, U, E>(r: Result<T, E>, fn: (v: T) => Result<U, E>): Result<U, E> {
  return r.ok ? fn(r.value) : r;
}

/** Map the error branch. Success passes through untouched. */
export function mapErr<T, E, F>(r: Result<T, E>, fn: (e: E) => F): Result<T, F> {
  return r.ok ? r : err(fn(r.error));
}

/**
 * Unwrap or throw. Use ONLY at trust boundaries (engine calling executor) —
 * inside executor code, prefer pattern matching (`if (r.ok) ... else ...`).
 */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  if (r.error instanceof Error) throw r.error;
  throw new Error(`unwrap on Err: ${JSON.stringify(r.error)}`);
}

export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

/**
 * Adapter: wrap a throwing sync function in a Result.
 *
 *   fromTry(() => JSON.parse(s))  // → ok(obj) | err(SyntaxError)
 */
export function fromTry<T>(fn: () => T): Result<T> {
  try {
    return ok(fn());
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Adapter: wrap a Promise in a Result-returning Promise.
 *
 *   const r = await fromPromise(fetch(url))
 *   if (r.ok) ... else ...
 */
export async function fromPromise<T>(p: Promise<T>): Promise<Result<T>> {
  try {
    return ok(await p);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Collect an array of Results into a single Result of array. Fails on the
 * first error (short-circuit). Equivalent of Promise.all but for Result.
 */
export function collect<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const out: T[] = [];
  for (const r of results) {
    if (!r.ok) return r;
    out.push(r.value);
  }
  return ok(out);
}
