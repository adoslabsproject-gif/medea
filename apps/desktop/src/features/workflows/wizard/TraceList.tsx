/**
 * La cronologia dei passi, mentre accadono.
 *
 * Scorre da sola sull'ultima riga: chi guarda vuole sapere cosa sta facendo
 * *adesso*, e inseguire la lista a mano mentre si allunga è un lavoro che non
 * dovrebbe esistere.
 *
 * Ogni riga si apre. Di norma bastano l'etichetta e l'esito, ma quando un
 * workflow esce diverso da come lo si era chiesto la domanda diventa «in quale
 * punto ha capito male», e per rispondere servono la richiesta fatta allo
 * strumento e quello che ha risposto. Sono lì sotto, chiusi finché non
 * servono.
 */

import { useEffect, useRef, useState } from 'react';

import styles from './TraceList.module.css';
import type { TraceEntry } from './types';

interface Props {
  entries: readonly TraceEntry[];
  /** Vero mentre l'agente lavora: l'ultima riga resta «in corso». */
  live: boolean;
}

/** Il log di un passo, leggibile: niente JSON su una riga sola. */
function formatta(valore: unknown): string {
  if (valore === undefined) return '—';
  if (typeof valore === 'string') return valore;
  try {
    return JSON.stringify(valore, null, 2);
  } catch {
    // Un valore che JSON non sa serializzare — un ciclo, una funzione — non
    // si stampa con String(): darebbe «[object Object]», che non è un log.
    return '(non rappresentabile)';
  }
}

export function TraceList({ entries, live }: Props) {
  const end = useRef<HTMLDivElement>(null);
  const [aperta, setAperta] = useState<string | null>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [entries.length]);

  return (
    <ol className={styles.list}>
      {entries.map((entry) => {
        const chiave = `${String(entry.step)}-${entry.tool}`;
        const espansa = aperta === chiave;
        const haDettagli = entry.args !== undefined || entry.result !== undefined;

        return (
          <li key={chiave} className={entry.ok ? styles.row : `${styles.row} ${styles.failed}`}>
            <button
              type="button"
              className={styles.riga}
              aria-expanded={espansa}
              disabled={!haDettagli}
              onClick={() => {
                setAperta(espansa ? null : chiave);
              }}
            >
              <span className={styles.numero}>{String(entry.step).padStart(2, '0')}</span>
              <span className={styles.mark} aria-hidden="true">
                {entry.ok ? '✓' : '✕'}
              </span>
              <span className={styles.body}>
                <span className={styles.label}>{entry.label}</span>
                {entry.detail && <code className={styles.detail}>{entry.detail}</code>}
                {entry.error && <span className={styles.error}>{entry.error}</span>}
              </span>
              {haDettagli && (
                <span className={styles.freccia} aria-hidden="true">
                  {espansa ? '▾' : '▸'}
                </span>
              )}
            </button>

            {espansa && (
              <div className={styles.log}>
                <div className={styles.logBlocco}>
                  <span className={styles.logTitolo}>Richiesta</span>
                  <pre className={styles.logCorpo}>{formatta(entry.args)}</pre>
                </div>
                <div className={styles.logBlocco}>
                  <span className={styles.logTitolo}>Risposta</span>
                  <pre className={styles.logCorpo}>{formatta(entry.result)}</pre>
                </div>
              </div>
            )}
          </li>
        );
      })}

      {live && (
        <li className={`${styles.row} ${styles.pending}`}>
          <span className={styles.riga}>
            <span className={styles.mark} aria-hidden="true">
              ·
            </span>
            <span className={styles.label}>Sta pensando…</span>
          </span>
        </li>
      )}
      <div ref={end} />
    </ol>
  );
}
