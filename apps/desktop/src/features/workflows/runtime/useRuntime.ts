/**
 * Lo stato del runtime, per la barra dell'editor.
 *
 * Serve a rispondere a una domanda sola: **si può eseguire?** Un pulsante
 * «Esegui» che non fa niente perché il runtime non è partito è peggio di un
 * pulsante spento che dice perché.
 */

import { useCallback, useEffect, useState } from 'react';

import { runtimeStatus, type RuntimeStatus } from './client';

/** Ogni quanto si ricontrolla, quando non è in piedi. */
const RECHECK_MS = 5000;

export interface RuntimeState {
  status: RuntimeStatus;
  checking: boolean;
  refresh: () => void;
}

export function useRuntime(): RuntimeState {
  const [status, setStatus] = useState<RuntimeStatus>({ running: false });
  const [checking, setChecking] = useState(true);

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

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Finché non è in piedi si ricontrolla: parte in pochi secondi, e l'utente
  // non deve ricaricare niente per accorgersene.
  useEffect(() => {
    if (status.running) return;
    const timer = setInterval(refresh, RECHECK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [status.running, refresh]);

  return { status, checking, refresh };
}
