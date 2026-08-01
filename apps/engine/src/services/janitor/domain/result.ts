/**
 * Domain — Result<T, E>.
 *
 * Functional error handling per i flussi dove il fallimento è ATTESO e
 * informativo (lock-contended, rule-disabled, dry-run-cancelled). Usato
 * SOLO ai confini delle use case — internamente le eccezioni native
 * restano per gli errori sistemici (IO, parse).
 *
 * Doctrine 2026: throw per errori sistemici, Result per errori di dominio.
 * Federico-grade: niente `null` con "occhio guarda il return type", niente
 * tuple `[err, data]` magiche — discriminated union esplicita.
 */

export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Mappa value se ok, altrimenti propaga error. Stile Rust/Elm. */
export function mapResult<T, U, E>(r: Result<T, E>, f: (v: T) => U): Result<U, E> {
  return r.ok ? Ok(f(r.value)) : r;
}

/** flatMap (and_then) — chain di operazioni che possono fallire. */
export function andThen<T, U, E>(r: Result<T, E>, f: (v: T) => Result<U, E>): Result<U, E> {
  return r.ok ? f(r.value) : r;
}

/** Tutti i Result devono essere ok, altrimenti ritorna il primo Err. */
export function combineResults<T, E>(rs: readonly Result<T, E>[]): Result<readonly T[], E> {
  const out: T[] = [];
  for (const r of rs) {
    if (!r.ok) return r;
    out.push(r.value);
  }
  return Ok(out);
}
