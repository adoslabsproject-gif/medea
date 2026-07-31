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

  // All'apertura si prova ad avviarlo. Se è già in piedi non succede niente:
  // il comando è idempotente.
  useEffect(() => {
    setChecking(true);
    void startRuntime()
      .then(setStatus)
      .catch((e: unknown) => {
        setStatus({ running: false, error: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        setChecking(false);
      });
  }, []);

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
