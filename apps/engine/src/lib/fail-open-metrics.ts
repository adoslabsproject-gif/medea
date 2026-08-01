/**
 * fail-open-metrics — osservabilità centralizzata dei fail-open di sicurezza.
 *
 * Un "fail-open" è una scelta deliberata: quando un controllo di hardening non
 * può decidere (DB transiente, valore corrotto), si sceglie la DISPONIBILITÀ
 * invece dell'enforcement, per non trasformare il controllo in un
 * single-point-of-failure (un errore DB non deve negare TUTTE le sessioni o
 * bloccare TUTTI i run). Il rischio non è il singolo scatto — è il fail-open
 * SILENZIOSO e PERSISTENTE: sotto un guasto DB continuato, una garanzia di
 * sicurezza (revoca sessione, gate billing, quota) resta degradata senza che
 * nessuno se ne accorga fino allo scadere naturale dei token.
 *
 * Questo modulo rende OGNI scatto osservabile e alertabile:
 *   • counter Prometheus `flowforge_fail_open_total{control}` — SEMPRE
 *     incrementato (mai throttled): Grafana alerta su rate sostenuto > 0.
 *   • log sul canale `security` (via loggerFor) — throttled per fingerprint
 *     (control+errore) a 1/finestra così un flood non annega il canale, ma la
 *     PRIMA occorrenza e ogni nuovo tipo di errore sono immediati.
 *
 * NON invia a Sentinel: richiederebbe un nuovo EventType lato portal e sarebbe
 * un fix parziale cross-app. La metrica Prometheus + il canale security sono
 * già il segnale che Grafana/Loki alertano — lo standard enterprise.
 */

import { counterInc } from '@/lib/metrics-store.js';
import { loggerFor, errorFingerprint } from '@/lib/logger.js';

/** Prefisso `security.` → il logger instrada sul canale `security`. */
const log = loggerFor('security.fail-open');

/** Controlli strumentati — union chiusa così un typo non crea una serie-metrica fantasma. */
export type FailOpenControl =
  | 'session_revocation.single'
  | 'session_revocation.cutoff'
  | 'execution_gate'
  | 'vector_quota';

/** Finestra di throttle del LOG (non della metrica). */
const LOG_THROTTLE_MS = 60_000;
/** fingerprint → ultimo timestamp loggato. */
const lastLogAt = new Map<string, number>();

/**
 * Registra uno scatto di fail-open. La metrica è incrementata sempre; il log
 * (canale security) è throttled per (control, tipo-errore) a 1/finestra.
 *
 * @param control  identità del controllo degradato (union chiusa).
 * @param err      l'errore che ha impedito la decisione (per fingerprint + payload).
 * @param extra    contesto aggiuntivo per il log (mai secret/PII).
 */
export function recordFailOpen(control: FailOpenControl, err: unknown, extra?: Record<string, unknown>): void {
  // 1) Metrica SEMPRE — è il segnale alertabile, non deve mai essere throttled.
  counterInc({
    name: 'flowforge_fail_open_total',
    help: 'Scatti di fail-open dei controlli di sicurezza (revoca sessioni, execution gate, quota vettoriale) — un rate sostenuto > 0 indica un guasto DB persistente che degrada una garanzia di sicurezza in silenzio',
    tags: { control },
  });

  // 2) Log security throttled per (control, fingerprint errore).
  const fp = errorFingerprint(err, `fail-open:${control}`);
  const now = Date.now();
  const last = lastLogAt.get(fp);
  if (last !== undefined && now - last < LOG_THROTTLE_MS) return;
  lastLogAt.set(fp, now);
  // GC lazy: la mappa resta piccola (pochi control × pochi tipi errore).
  if (lastLogAt.size > 256) {
    for (const [k, ts] of lastLogAt) {
      if (now - ts >= LOG_THROTTLE_MS) lastLogAt.delete(k);
    }
  }
  log.warn(
    { control, err, ...extra },
    `[FAIL-OPEN] controllo "${control}" degradato: decisione impossibile → si è scelto di NON bloccare. Se persiste, la garanzia è sospesa fino a scadenza naturale dei token`,
  );
}

/** Solo per test: azzera lo stato di throttle tra i casi. */
export function __resetFailOpenThrottleForTest(): void {
  lastLogAt.clear();
}
