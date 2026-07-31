/**
 * Gli eventi del runtime, in diretta.
 *
 * Prima Medea chiedeva «a che punto sei?» ogni 400 ms. Funzionava, ma solo
 * mentre qualcuno guardava: un workflow partito da un cron alle tre di notte
 * eseguiva e non lasciava traccia nello storico, perché non c'era nessun giro
 * di domande ad accorgersene. Con lo streaming è il runtime a dire cosa
 * succede, e succede anche quando non lo si sta guardando.
 *
 * La connessione è **una sola** per tutta l'app: apre al primo ascoltatore e
 * chiude quando l'ultimo se ne va. Aprirne una per pannello vorrebbe dire N
 * copie dello stesso flusso, e il runtime tiene una coda per ciascuna.
 */

import { forgetSession, session } from './client';
import { createSseReader, parseData } from './sse';

/** Quanto si aspetta prima di riprovare, e fino a quanto si allunga l'attesa. */
const RETRY_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export interface RuntimeEvent {
  name: string;
  tenantId?: string;
  data: unknown;
  ts: string;
}

type Listener = (event: RuntimeEvent) => void;

const listeners = new Set<Listener>();
let controller: AbortController | null = null;
let retryMs = RETRY_MS;

function announce(event: RuntimeEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (e) {
      // Un ascoltatore che scoppia non deve portarsi via lo stream: gli altri
      // stanno ancora aspettando i loro eventi.
      console.error('[runtime] un ascoltatore ha fallito', e);
    }
  }
}

/** Legge lo stream fino a quando cade. Non ritorna finché è vivo. */
async function readStream(signal: AbortSignal): Promise<void> {
  const s = await session();
  const response = await fetch(`${s.baseUrl}/api/v1/dashboard/stream`, {
    headers: { authorization: `Bearer ${s.token}`, accept: 'text/event-stream' },
    signal,
  });

  if (response.status === 401) {
    forgetSession();
    throw new Error('sessione scaduta');
  }
  if (!response.ok || !response.body) {
    throw new Error(`il runtime ha risposto ${String(response.status)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const read = createSseReader();

  // Arrivati qui la connessione regge: l'attesa fra un tentativo e l'altro
  // torna breve, altrimenti una caduta isolata la lascerebbe a mezzo minuto
  // per sempre.
  retryMs = RETRY_MS;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const message of read(decoder.decode(value, { stream: true }))) {
      if (message.event === 'ping' || message.event === 'hello') continue;
      const event = parseData(message) as RuntimeEvent | null;
      if (event) announce(event);
    }
  }
}

/** Tiene aperta la connessione finché c'è qualcuno che ascolta. */
async function keepAlive(controller: AbortController): Promise<void> {
  // Letto attraverso una funzione: il compilatore altrimenti si convince che
  // il valore non possa cambiare fra un controllo e l'altro, mentre è
  // esattamente quello che fa quando qualcuno smette di ascoltare.
  const stopped = () => controller.signal.aborted;

  for (;;) {
    if (stopped()) return;
    try {
      await readStream(controller.signal);
    } catch (e) {
      if (stopped()) return;
      console.warn('[runtime] flusso eventi interrotto', e);
    }
    if (stopped()) return;
    await new Promise((resolve) => setTimeout(resolve, retryMs));
    // Se il runtime è giù non ha senso bussare ogni secondo per ore.
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  }
}

/**
 * Si mette in ascolto. Restituisce la funzione per smettere.
 *
 * Il primo ascoltatore apre la connessione, l'ultimo che se ne va la chiude.
 */
export function subscribeRuntime(listener: Listener): () => void {
  listeners.add(listener);

  controller ??= (() => {
    const c = new AbortController();
    void keepAlive(c);
    return c;
  })();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      controller?.abort();
      controller = null;
      retryMs = RETRY_MS;
    }
  };
}

/** Chiude tutto. Serve al riavvio del runtime: la vecchia sessione non vale più. */
export function closeRuntimeEvents(): void {
  controller?.abort();
  controller = null;
  if (listeners.size > 0) {
    const c = new AbortController();
    controller = c;
    void keepAlive(c);
  }
}
