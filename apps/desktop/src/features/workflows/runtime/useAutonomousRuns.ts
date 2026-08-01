/**
 * Le automazioni attive girano anche se la sezione workflow è chiusa.
 *
 * È il punto che separa un editor da un prodotto: se il cron delle otto
 * funziona solo mentre si guarda il canvas, non è automazione, è un pulsante
 * con un ritardo. Quindi all'avvio di Medea si guarda se esiste almeno un
 * workflow attivo e, se esiste, il runtime parte e si mette in ascolto.
 *
 * Se non ce n'è nessuno il runtime **non** viene avviato: sono decine di MB e
 * un processo in più per niente.
 */

import { useEffect } from 'react';

import { workflowApi } from '../api';

import { startRuntime } from './client';
import { provisionRuntime } from './provision';
import { startRelay, stopRelay } from './relay';
import { relayEnabled, relayToken, relayUrl } from './relay-settings';
import { startRunWatcher } from './watcher';

export function useAutonomousRuns(): void {
  useEffect(() => {
    let stop: (() => void) | null = null;
    // Il montaggio può finire prima dell'avvio del runtime — in sviluppo
    // React monta due volte di fila. Senza questo, il secondo giro lascerebbe
    // un ascoltatore orfano attaccato al flusso.
    const mounted = new AbortController();
    // Letto attraverso una funzione: altrimenti il compilatore dà per scontato
    // che il valore resti quello del primo controllo.
    const gone = () => mounted.signal.aborted;

    void (async () => {
      try {
        const workflows = await workflowApi.list();
        if (gone() || !workflows.some((w) => w.enabled)) return;

        const status = await startRuntime();
        if (gone() || !status.running) return;

        // Le credenziali servono prima che scatti il primo cron, non dopo.
        await provisionRuntime();
        if (gone()) return;

        stop = startRunWatcher();

        // Il canale verso l'esterno, se qualcuno lo ha acceso. Spento di
        // default: una chiamata da internet che fa eseguire un workflow su
        // questo computer è una cosa che si sceglie.
        const url = relayUrl();
        if (relayEnabled() && url) {
          startRelay({ baseUrl: url, token: await relayToken() });
        }
      } catch (e) {
        console.warn('[workflow] automazioni non avviate', e);
      }
    })();

    return () => {
      mounted.abort();
      stop?.();
      stopRelay();
    };
  }, []);
}
