/**
 * safe-user-regex — compilazione SICURA di regex fornite dall'autore workflow.
 *
 * PROBLEMA: i nodi text/web accettano un pattern regex DA CONFIG (es.
 * action_text replace/extract, web-extraction regex-multi, sitemap include/exclude,
 * PEC subject filter). `new RegExp(pattern)` di V8 usa un motore backtracking →
 * un pattern "evil" come `(a+)+$` su input lungo causa **ReDoS** (catastrophic
 * backtracking → CPU 100% → DoS del container tenant). L'autore è semi-fidato,
 * ma può sbagliare il pattern: il blocco NON deve essere possibile per costruzione.
 *
 * SOLUZIONE: motore **RE2** (Google) — automa finito che matcha in tempo e
 * spazio LINEARI nella lunghezza dell'input, **senza backtracking** → ReDoS
 * IMPOSSIBILE by design (non una mitigazione reattiva con timeout: il
 * backtracking esponenziale non esiste proprio in RE2).
 *
 * RE2 è drop-in per RegExp: l'istanza ritornata funziona con
 * String.prototype.{replace,match,matchAll,split} e con .test/.exec/.lastIndex.
 *
 * LIMITE NOTO (e gestito, mai silenziato): RE2 NON supporta backreferences (`\1`)
 * né lookbehind/lookahead (`(?<=)`,`(?=)`) — feature che RICHIEDONO backtracking.
 * Se il pattern le usa, `new RE2(...)` lancia → qui rilanciamo {@link UnsafeRegexError}
 * con messaggio chiaro per l'autore. NESSUN fallback a `RegExp` vulnerabile: meglio
 * un errore esplicito che riaprire il buco ReDoS dalla porta sul retro.
 */
import RE2 from 're2';

/** Istanza RE2 — `interface RE2 extends RegExp` → drop-in per String.{replace,match,split} e .exec/.test/.lastIndex. */
export type SafeRegex = InstanceType<typeof RE2>;

/** Pattern oltre questa lunghezza è rifiutato (difesa-in-profondità anti-abuso). */
export const MAX_USER_REGEX_PATTERN_LENGTH = 2000;

/** Sollevata quando un pattern utente è invalido o usa feature non-RE2. */
export class UnsafeRegexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeRegexError';
  }
}

/**
 * Compila `pattern` (regex utente) con RE2. Ritorna un'istanza drop-in di RegExp,
 * immune a ReDoS. Lancia {@link UnsafeRegexError} se il pattern è troppo lungo,
 * sintatticamente invalido, o usa feature non supportate da RE2.
 */
export function safeUserRegex(pattern: string, flags = ''): SafeRegex {
  if (typeof pattern !== 'string') {
    throw new UnsafeRegexError('pattern regex mancante o non stringa');
  }
  if (pattern.length > MAX_USER_REGEX_PATTERN_LENGTH) {
    throw new UnsafeRegexError(
      `pattern regex troppo lungo (${pattern.length} > ${MAX_USER_REGEX_PATTERN_LENGTH} caratteri)`,
    );
  }
  try {
    return new RE2(pattern, flags);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new UnsafeRegexError(
      'regex non valida o usa feature non supportate dal motore sicuro RE2 ' +
        '(backreferences \\1, lookbehind (?<=…), lookahead (?=…) richiedono backtracking ' +
        `e sono vietate per prevenire ReDoS): ${detail}`,
    );
  }
}
