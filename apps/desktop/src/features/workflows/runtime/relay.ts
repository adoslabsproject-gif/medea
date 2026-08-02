/**
 * Il canale verso l'esterno: farsi raggiungere da internet senza aprire porte.
 *
 * Un computer di casa sta dietro un NAT e da fuori non lo raggiunge nessuno.
 * Può però aprire un canale **in uscita**: Medea tiene un WebSocket verso il
 * relay, e le chiamate che arrivano da internet scendono dentro quel canale.
 * Nessuna porta aperta sul computer, nessun indirizzo IP da conoscere.
 *
 * ───── Perché è spento di default ─────
 *
 * Accendere questo canale significa che una chiamata partita da internet può
 * far eseguire un workflow su questo computer. È una cosa che si sceglie, non
 * un'impostazione che si trova già fatta.
 *
 * ───── Perché qui non c'è nessun WebSocket ─────
 *
 * Il canale lo tiene aperto il processo, non questa pagina. La pagina vive
 * sotto una CSP che elenca a uno a uno gli indirizzi raggiungibili: finché il
 * WebSocket partiva da qui, funzionava solo il relay scritto in quell'elenco,
 * e chiunque volesse usare **il proprio** — un server suo, un dominio suo, un
 * indirizzo IP — veniva bloccato dal browser senza un motivo visibile.
 *
 * Spostare la connessione dall'altra parte toglie quel limite senza allargare
 * la CSP, che resta stretta per tutto il resto. Qui restano i comandi e
 * l'ascolto dello stato.
 *
 * Il confine su cosa può passare — **solo i percorsi `/webhooks/…`** — è
 * applicato dove passa il traffico, cioè in `src-tauri/src/relay/frames.rs`.
 *
 * @module features/workflows/runtime/relay
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface RelayConfig {
  /** L'indirizzo del relay: quello pubblico, o il proprio. */
  baseUrl: string;
  /** Il segreto di questa installazione. Non lascia mai il computer, se non
   *  per presentarsi al relay. */
  token: string;
}

export interface RelayState {
  connected: boolean;
  /** L'identificativo pubblico, quando il relay lo conferma. */
  installId?: string;
  error?: string;
}

type Listener = (state: RelayState) => void;

let state: RelayState = { connected: false };
const listeners = new Set<Listener>();

/** Un solo ascolto dell'evento per tutta la sessione, avviato alla prima
 *  richiesta e mai smontato: il canale vive quanto l'applicazione. */
let ascolto: Promise<unknown> | null = null;

function publish(next: RelayState): void {
  state = next;
  for (const listener of listeners) listener(next);
}

function ascoltaStato(): void {
  ascolto ??= listen<RelayState>('relay://stato', (event) => {
    publish(event.payload);
  });
}

export function relayState(): RelayState {
  return state;
}

export function subscribeRelay(listener: Listener): () => void {
  ascoltaStato();
  listeners.add(listener);
  // Chi arriva dopo che il canale è già aperto deve vedere subito com'è
  // messo, invece di aspettare il prossimo cambiamento.
  void invoke<RelayState>('relay_status').then(publish);
  return () => {
    listeners.delete(listener);
  };
}

/** Apre il canale. Idempotente: chiamarla due volte non ne apre due. */
export function startRelay(config: RelayConfig): void {
  ascoltaStato();
  void invoke('relay_start', { baseUrl: config.baseUrl, token: config.token }).catch(
    (e: unknown) => {
      publish({
        connected: false,
        error: e instanceof Error ? e.message : String(e),
      });
    },
  );
}

/** Chiude il canale e smette di riprovare. */
export function stopRelay(): void {
  void invoke('relay_stop');
  publish({ connected: false });
}
