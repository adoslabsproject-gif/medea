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
 * ───── Il confine ─────
 *
 * Si inoltrano **solo i percorsi `/webhooks/…`**. Il relay applica lo stesso
 * controllo dalla sua parte; qui si ripete perché è la cosa che non deve
 * fallire nemmeno se l'altra metà venisse sostituita da qualcos'altro. Senza,
 * chi conosce l'identificativo pubblico potrebbe raggiungere tutta l'API
 * locale del motore — quella che crea workflow ed esegue codice.
 */

import { session } from './client';

/** Quanto si aspetta prima di riprovare, e fino a quanto si allunga l'attesa. */
const RETRY_MS = 2_000;
const RETRY_MAX_MS = 60_000;

/** Solo i webhook passano. Vedi il commento in cima. */
const FORWARDABLE = /^\/webhooks\/[A-Za-z0-9/_-]*$/;

export interface RelayConfig {
  /** L'indirizzo del relay, per esempio `https://app.automazionezeli.com/relay`. */
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

let socket: WebSocket | null = null;
let retryMs = RETRY_MS;
let stopped = true;
let state: RelayState = { connected: false };
const listeners = new Set<Listener>();

function publish(next: RelayState): void {
  state = next;
  for (const listener of listeners) listener(next);
}

export function relayState(): RelayState {
  return state;
}

export function subscribeRelay(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** L'indirizzo del WebSocket, ricavato da quello del relay. */
function socketUrl(baseUrl: string): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/socket`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

interface RequestFrame {
  type: 'request';
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Gira la chiamata al motore locale e restituisce cosa risponde.
 *
 * Un errore qui non è un errore del relay: è il motore che non risponde, e
 * chi ha chiamato deve leggerlo come tale invece di aspettare il timeout.
 */
async function serve(frame: RequestFrame): Promise<{ status: number; body: string }> {
  if (!FORWARDABLE.test(frame.path.split('?')[0] ?? '')) {
    return { status: 403, body: JSON.stringify({ error: 'Solo i webhook passano da qui.' }) };
  }

  try {
    const s = await session();
    const response = await fetch(`${s.baseUrl}${frame.path}`, {
      method: frame.method,
      headers: frame.headers,
      ...(frame.method === 'GET' || frame.method === 'HEAD' ? {} : { body: frame.body }),
    });
    return { status: response.status, body: await response.text() };
  } catch (e) {
    return {
      status: 502,
      body: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
    };
  }
}

function connect(config: RelayConfig): void {
  if (stopped) return;

  const ws = new WebSocket(socketUrl(config.baseUrl));
  socket = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'hello', token: config.token }));
  };

  ws.onmessage = (event: MessageEvent<string>) => {
    let frame: unknown;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    const message = frame as Record<string, unknown>;

    if (message.type === 'ready' && typeof message.installId === 'string') {
      // Arrivati qui il canale regge: l'attesa fra un tentativo e l'altro
      // torna breve, altrimenti una caduta isolata la lascerebbe a un minuto
      // per sempre.
      retryMs = RETRY_MS;
      publish({ connected: true, installId: message.installId });
      return;
    }

    if (message.type === 'request') {
      const request = message as unknown as RequestFrame;
      void serve(request).then((result) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'response', id: request.id, ...result }));
        }
      });
    }
  };

  ws.onclose = () => {
    if (socket === ws) socket = null;
    publish({ connected: false, ...(state.installId ? { installId: state.installId } : {}) });
    if (stopped) return;
    setTimeout(() => {
      connect(config);
    }, retryMs);
    // Se il relay è irraggiungibile non ha senso bussare ogni due secondi.
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  };

  ws.onerror = () => {
    publish({ connected: false, error: 'il relay non risponde' });
  };
}

/** Apre il canale. Idempotente: chiamarla due volte non ne apre due. */
export function startRelay(config: RelayConfig): void {
  if (socket) return;
  stopped = false;
  retryMs = RETRY_MS;
  connect(config);
}

/** Chiude il canale e smette di riprovare. */
export function stopRelay(): void {
  stopped = true;
  socket?.close();
  socket = null;
  publish({ connected: false });
}
