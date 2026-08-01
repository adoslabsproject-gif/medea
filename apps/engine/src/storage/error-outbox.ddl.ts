/**
 * DDL single-source-of-truth della tabella `error_outbox`.
 *
 * Outbox DUREVOLE per la notifica di errore: alla failure di un run si scrivono QUI
 * (atomico col mark-errored, STESSA transazione SQLite — vedi outbox-writer) le righe
 * di dispatch, poi un worker consuma e dispatcha con retry/backoff → AT-LEAST-ONCE,
 * sopravvive a crash/transienti. Rimpiazza il dispatch fire-and-forget (perso su
 * crash) di run.service + failure-notifier.
 *
 * Usato sia da `migrate.ts` (creazione in prod) sia dai test (DB in-memory reale)
 * → niente drift fra schema testato e schema deployato.
 *
 * PER-CANALE (review 2026-06-19, punto #5): UNA riga per (run_id, channel) con
 * channel ∈ {fanout|webhook|email}. Stato/attempts/dead INDIPENDENTI per canale →
 * se il fan-out error-workflow cade, webhook ed email partono lo stesso. Niente
 * stato "per-evento" che accoppia i canali.
 *
 * Dedup (#6): UNIQUE(run_id, channel) → enqueue idempotente per canale. `error_hash`
 * memorizzato per grouping/rate-limit cross-run e per GC mirato.
 * Capolinea (#2): dopo MAX_ATTEMPTS lo status passa a 'dead' (poison → dead-letter,
 * non ritenta in eterno né blocca la coda).
 * Indici: (status, next_attempt_at) per il claim dei "dovuti"; (status, updated_at)
 * per la GC/retention delle righe done/dead vecchie (#6, tabella non cresce all'infinito).
 */
export const ERROR_OUTBOX_DDL = `
  CREATE TABLE IF NOT EXISTS error_outbox (
    id                 TEXT PRIMARY KEY,
    run_id             TEXT NOT NULL,
    channel            TEXT NOT NULL,
    workflow_id        TEXT NOT NULL,
    tenant_id          TEXT NOT NULL,
    error_node_id      TEXT,
    error_message      TEXT,
    error_hash         TEXT,
    duration_ms        INTEGER,
    started_at         TEXT NOT NULL,
    trigger_type       TEXT,
    trigger_input_json TEXT,
    status             TEXT NOT NULL DEFAULT 'pending',
    attempts           INTEGER NOT NULL DEFAULT 0,
    next_attempt_at    TEXT NOT NULL,
    last_error         TEXT,
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(run_id, channel)
  );
  CREATE INDEX IF NOT EXISTS error_outbox_due_idx ON error_outbox(status, next_attempt_at);
  CREATE INDEX IF NOT EXISTS error_outbox_gc_idx ON error_outbox(status, updated_at);
`;
