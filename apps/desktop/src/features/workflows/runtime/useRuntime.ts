/**
 * Il runtime: avviarlo e sapere se è pronto.
 *
 * Si avvia **aprendo la sezione**, non premendo «Esegui»: metterci qualche
 * secondo la prima volta è accettabile mentre si guarda il canvas, molto meno
 * dopo aver premuto un pulsante. E chiedere solo lo stato senza mai avviarlo
 * lascerebbe il pulsante spento per sempre.
 */

import { useCallback, useEffect, useState } from 'react';

import { runtimeStatus, startRuntime, type RuntimeStatus } from './client';
import { refreshCommunityNodes } from './community';
import { provisionRuntime } from './provision';
import { startRunWatcher } from './watcher';

/** Ogni quanto si ricontrolla, quando non è in piedi. */
const RECHECK_MS = 5000;

export interface RuntimeState {
  status: RuntimeStatus;
  checking: boolean;
  refresh: () => void;
  /** Riconsegna segreti e account: da chiamare quando cambiano. */
  provision: () => void;
}

export function useRuntime(): RuntimeState {
  const [status, setStatus] = useState<RuntimeStatus>({ running: false });
  const [checking, setChecking] = useState(true);

  /** Guarda e basta: serve al controllo periodico. */
  const refresh = useCallback(() => {
    setChecking(true);
    void runtimeStatus()
      .then(setStatus)
      .catch(() => {
        setStatus({ running: false, error: 'non raggiungibile' });
      })
      .finally(() => {
        setChecking(false);
      });
  }, []);

  /**
   * Consegna al runtime segreti e account di posta.
   *
   * Senza, `{{secrets.X}}` si risolve nel vuoto e `action_send_email` non
   * trova l'account: il workflow gira e fallisce per una ragione che non si
   * capisce guardando il canvas.
   */
  const provision = useCallback(() => {
    void provisionRuntime().then((report) => {
      if (report.problems.length > 0) {
        // Non è un errore che ferma tutto: i pezzi passati sono passati.
        console.warn('[runtime] problemi nel consegnare le credenziali', report.problems);
      }
    });
  }, []);

  // All'apertura si prova ad avviarlo. Se è già in piedi non succede niente:
  // il comando è idempotente.
  useEffect(() => {
    setChecking(true);
    void startRuntime()
      .then((s) => {
        setStatus(s);
        if (s.running) {
          provision();
          // I nodi aggiuntivi vivono nel motore: senza questa chiamata la
          // palette mostrerebbe solo i preinstallati, e un pacchetto appena
          // installato sembrerebbe sparito.
          void refreshCommunityNodes();
        }
      })
      .catch((e: unknown) => {
        setStatus({ running: false, error: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        setChecking(false);
      });
  }, [provision]);

  // Finché la sezione è aperta si registra ogni esecuzione, comprese quelle
  // partite da sole mentre la si guarda. Un secondo ascoltatore non pesa: il
  // flusso è uno solo, e riscrivere la stessa riga dello storico è innocuo.
  useEffect(() => {
    if (!status.running) return;
    return startRunWatcher();
  }, [status.running]);

  // Finché non è in piedi si ricontrolla: parte in pochi secondi, e l'utente
  // non deve ricaricare niente per accorgersene.
  useEffect(() => {
    if (status.running) return;
    const timer = setInterval(refresh, RECHECK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [status.running, refresh]);

  return { status, checking, refresh, provision };
}
