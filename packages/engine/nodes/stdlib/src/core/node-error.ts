/**
 * NodeError hierarchy — discriminated union per error handling enterprise.
 *
 * Pattern: ogni errore espone:
 *   • code        — discriminator string (machine-readable, mai cambia)
 *   • retryable   — flag che l'engine usa per decidere retry vs. surrender
 *   • context     — payload diagnostico (url, status, host, attemptedAt, …)
 *   • cause       — Error originale opzionale (chain via `Error.cause`)
 *
 * Sostituisce `throw new Error("HTTP node: 401")` con `new HttpError({status:401, ...})`
 * che il middleware telemetry estrae per emettere span attributes corretti
 * (http.status_code, error.type, etc. — OTEL semantic conventions).
 *
 * Quando un executor v2 ritorna `Result.err(NodeError)`, l'engine decide:
 *   • retryable=true  → applica retry policy (NodeExecutorStrategy)
 *   • retryable=false → marca step come error immediato, niente retry
 */

export type NodeErrorCode =
  | 'VALIDATION_ERROR'
  | 'HTTP_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'CIRCUIT_OPEN'
  | 'IDEMPOTENCY_CONFLICT'
  | 'QUOTA_EXCEEDED'
  | 'AUTH_ERROR'
  | 'UPSTREAM_ERROR'
  | 'BODY_TOO_LARGE'
  | 'ABORTED'
  | 'CONFIG_ERROR'
  | 'INTERNAL_ERROR';

export type NodeErrorContext = Readonly<Record<string, unknown>>;

export interface NodeErrorOptions {
  code: NodeErrorCode;
  message: string;
  retryable?: boolean;
  context?: NodeErrorContext;
  cause?: Error;
}

export class NodeError extends Error {
  readonly code: NodeErrorCode;
  readonly retryable: boolean;
  readonly context: NodeErrorContext;

  constructor(opts: NodeErrorOptions) {
    super(opts.message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'NodeError';
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
    this.context = opts.context ?? {};
  }

  /** Serialize for logging / audit. Strips cause chain to avoid PII leak. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      context: this.context,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Discriminated subclasses — costruttori specializzati che enforcano
// retryable corretto e shape del context per ogni famiglia di errore.
// ─────────────────────────────────────────────────────────────────────

export class ValidationError extends NodeError {
  constructor(message: string, context?: NodeErrorContext) {
    super({ code: 'VALIDATION_ERROR', message, retryable: false, ...(context ? { context } : {}) });
    this.name = 'ValidationError';
  }
}

export class HttpError extends NodeError {
  readonly status: number;
  constructor(opts: { status: number; statusText?: string; url?: string; bodyExcerpt?: string; retryAfterMs?: number; cause?: Error }) {
    const message = `HTTP ${opts.status}${opts.statusText ? ` ${opts.statusText}` : ''}${opts.url ? ` @ ${opts.url}` : ''}`;
    const retryable = opts.status >= 500 || opts.status === 408 || opts.status === 429;
    const context: NodeErrorContext = {
      status: opts.status,
      ...(opts.statusText ? { statusText: opts.statusText } : {}),
      ...(opts.url ? { url: opts.url } : {}),
      ...(opts.bodyExcerpt ? { bodyExcerpt: opts.bodyExcerpt.slice(0, 500) } : {}),
      // Retry-After (secondi o data HTTP) normalizzato in ms — l'engine lo
      // rispetta al posto del backoff esponenziale (no martellamento del provider).
      ...(opts.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}),
    };
    super({ code: 'HTTP_ERROR', message, retryable, context, ...(opts.cause ? { cause: opts.cause } : {}) });
    this.name = 'HttpError';
    this.status = opts.status;
  }
}

/**
 * Parsa l'header `Retry-After` (RFC 7231): "120" (secondi) oppure una data HTTP
 * ("Wed, 21 Oct 2025 07:28:00 GMT"). Ritorna i millisecondi da attendere, o
 * `null` se assente/non valido/nel passato.
 */
export function parseRetryAfter(headerValue: string | null | undefined, now = Date.now()): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (/^\d+$/u.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  const delta = date - now;
  return delta > 0 ? delta : null;
}

/** Estrae il Retry-After (ms) da un errore, se è un HttpError che lo porta. */
export function retryAfterMsOf(err: unknown): number | null {
  if (err instanceof NodeError) {
    const v = err.context.retryAfterMs;
    if (typeof v === 'number' && v >= 0) return v;
  }
  return null;
}

export class NetworkError extends NodeError {
  constructor(message: string, opts?: { url?: string; cause?: Error }) {
    const context: NodeErrorContext = opts?.url ? { url: opts.url } : {};
    super({ code: 'NETWORK_ERROR', message, retryable: true, context, ...(opts?.cause ? { cause: opts.cause } : {}) });
    this.name = 'NetworkError';
  }
}

export class TimeoutError extends NodeError {
  constructor(opts: { url?: string; timeoutMs: number; cause?: Error }) {
    const message = `Timeout dopo ${String(opts.timeoutMs)}ms${opts.url ? ` @ ${opts.url}` : ''}`;
    const context: NodeErrorContext = { timeoutMs: opts.timeoutMs, ...(opts.url ? { url: opts.url } : {}) };
    super({ code: 'TIMEOUT', message, retryable: true, context, ...(opts.cause ? { cause: opts.cause } : {}) });
    this.name = 'TimeoutError';
  }
}

export class CircuitOpenError extends NodeError {
  constructor(opts: { breakerName: string; nextProbeAt: number; cause?: Error }) {
    const message = `Circuit breaker "${opts.breakerName}" aperto — fail fast`;
    const context: NodeErrorContext = { breakerName: opts.breakerName, nextProbeAt: opts.nextProbeAt };
    super({ code: 'CIRCUIT_OPEN', message, retryable: false, context, ...(opts.cause ? { cause: opts.cause } : {}) });
    this.name = 'CircuitOpenError';
  }
}

export class IdempotencyConflictError extends NodeError {
  constructor(opts: { key: string; previousAt: number }) {
    const message = `Idempotency conflict — key "${opts.key}" gia\` eseguito a ${new Date(opts.previousAt).toISOString()}`;
    super({
      code: 'IDEMPOTENCY_CONFLICT',
      message,
      retryable: false,
      context: { key: opts.key, previousAt: opts.previousAt },
    });
    this.name = 'IdempotencyConflictError';
  }
}

export class QuotaExceededError extends NodeError {
  constructor(opts: { quotaName: string; limit: number; used: number }) {
    const message = `Quota "${opts.quotaName}" superata: ${String(opts.used)}/${String(opts.limit)}`;
    super({
      code: 'QUOTA_EXCEEDED',
      message,
      retryable: false,
      context: { quotaName: opts.quotaName, limit: opts.limit, used: opts.used },
    });
    this.name = 'QuotaExceededError';
  }
}

export class AuthError extends NodeError {
  constructor(opts: { reason: string; url?: string }) {
    const message = `Auth fallita: ${opts.reason}${opts.url ? ` @ ${opts.url}` : ''}`;
    const context: NodeErrorContext = { reason: opts.reason, ...(opts.url ? { url: opts.url } : {}) };
    super({ code: 'AUTH_ERROR', message, retryable: false, context });
    this.name = 'AuthError';
  }
}

export class AbortedError extends NodeError {
  constructor(reason = 'cancelled by user') {
    super({ code: 'ABORTED', message: reason, retryable: false });
    this.name = 'AbortedError';
  }
}

export class ConfigError extends NodeError {
  constructor(message: string, opts?: { fieldKey?: string }) {
    const context: NodeErrorContext = opts?.fieldKey ? { fieldKey: opts.fieldKey } : {};
    super({ code: 'CONFIG_ERROR', message, retryable: false, context });
    this.name = 'ConfigError';
  }
}

/**
 * Adapter: converte qualunque errore (Error legacy, NodeError, valore non-Error)
 * in NodeError. Usato dal middleware "throw-shim" per back-compat con executor v1
 * che ancora throwano stringhe / Error generici.
 */
export function asNodeError(e: unknown): NodeError {
  if (e instanceof NodeError) return e;
  if (e instanceof Error) {
    // Heuristica: messaggi che contengono "timeout" diventano TimeoutError;
    // resto va in INTERNAL_ERROR retryable=false (conservativo).
    //
    // Cappella Sistina #223 fix: PRIMA wrappavamo con `timeoutMs: 0` perdendo
    // il messaggio originale (l'utente vedeva "Timeout dopo 0ms" senza sapere
    // cosa era davvero scaduto). Ora cerchiamo di estrarre il timeout dal
    // messaggio (regex `(\d+)\s*ms`); se non c'è, NON usiamo TimeoutError
    // (rimane INTERNAL_ERROR con il messaggio originale preservato — molto
    // più diagnosticabile che "0ms").
    if (/timeout/iu.test(e.message)) {
      const m = /(\d+)\s*ms\b/iu.exec(e.message);
      if (m?.[1]) {
        const parsed = Number(m[1]);
        if (Number.isFinite(parsed) && parsed > 0) {
          return new TimeoutError({ timeoutMs: parsed, cause: e });
        }
      }
      // Timeout senza ms estraibile → preserva il messaggio originale.
      return new NodeError({ code: 'TIMEOUT', message: e.message, retryable: true, cause: e });
    }
    return new NodeError({ code: 'INTERNAL_ERROR', message: e.message, retryable: false, cause: e });
  }
  return new NodeError({ code: 'INTERNAL_ERROR', message: String(e), retryable: false });
}

// ─────────────────────────────────────────────────────────────────────
// Categorie semantiche + azione suggerita — il livello che la UI usa per
// DECIDERE cosa proporre all'utente (n8n-grade error UX). I `code` sono
// machine-readable e granulari; le categorie li raggruppano in famiglie
// con un'azione umana coerente.
// ─────────────────────────────────────────────────────────────────────

export type NodeErrorCategory =
  | 'validation' // input/config del nodo da correggere
  | 'auth' // credenziali/permessi
  | 'network' // problema transitorio di rete/servizio → riprovabile
  | 'rate_limit' // limite di chiamate del provider
  | 'business' // richiesta rifiutata dalla logica del servizio remoto
  | 'aborted' // annullato
  | 'internal'; // bug/imprevisto

/**
 * Classifica un NodeError (o la sua forma `{ code, retryable }`) in una
 * categoria semantica. HTTP_ERROR è ambiguo: 5xx/408/429 (retryable) → network,
 * 4xx (non retryable) → business.
 */
export function categoryOf(err: { code: NodeErrorCode; retryable?: boolean }): NodeErrorCategory {
  switch (err.code) {
    case 'VALIDATION_ERROR':
    case 'CONFIG_ERROR':
    case 'BODY_TOO_LARGE':
      return 'validation';
    case 'AUTH_ERROR':
      return 'auth';
    case 'NETWORK_ERROR':
    case 'TIMEOUT':
    case 'CIRCUIT_OPEN':
    case 'UPSTREAM_ERROR':
      return 'network';
    case 'QUOTA_EXCEEDED':
      return 'rate_limit';
    case 'HTTP_ERROR':
      return err.retryable ? 'network' : 'business';
    case 'IDEMPOTENCY_CONFLICT':
      return 'business';
    case 'ABORTED':
      return 'aborted';
    case 'INTERNAL_ERROR':
      return 'internal';
  }
}

/** Azione suggerita (IT) per ogni categoria — testo mostrato dalla UI. */
export function actionHintFor(category: NodeErrorCategory): string {
  switch (category) {
    case 'validation': return 'Controlla i parametri del nodo: un valore è mancante, troppo grande o non valido.';
    case 'auth': return 'Verifica le credenziali o la connessione: token scaduto, chiave errata o permessi insufficienti.';
    case 'network': return 'Problema temporaneo di rete o del servizio remoto. Riprova, o attiva i tentativi automatici nel nodo.';
    case 'rate_limit': return 'Hai raggiunto il limite di chiamate del provider. Rallenta, aggiungi un ritardo o aumenta la quota.';
    case 'business': return 'Il servizio remoto ha rifiutato la richiesta (regola di business). Controlla i dati inviati.';
    case 'aborted': return 'Esecuzione annullata.';
    case 'internal': return 'Errore interno imprevisto. Controlla i log del run o segnala il problema.';
  }
}

/** True se la categoria è tipicamente risolvibile con un retry automatico. */
export function isTransientCategory(category: NodeErrorCategory): boolean {
  return category === 'network' || category === 'rate_limit';
}
