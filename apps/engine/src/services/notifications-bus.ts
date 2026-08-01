/**
 * notifications-bus — canale push in-process per le notifiche (#7 Tier 3).
 *
 * Autore e destinatario di una @mention vivono nello STESSO container runtime
 * (membri dello stesso workspace), quindi un EventEmitter in-process è
 * sufficiente per il push real-time: `create()` emette sul canale dell'utente,
 * lo stream SSE (`GET /notifications/stream`) di quell'utente riceve all'istante.
 * Niente polling, niente WebSocket dedicato — riusa il modello SSE già in uso
 * per dashboard/liveRun.
 */
import { EventEmitter } from 'node:events';
import type { Notification } from './notifications.service.js';

const emitter = new EventEmitter();
// Molti client connessi (uno stream per tab/utente) → niente cap arbitrario sui
// listener: il warning di default (10) sarebbe rumore, non un leak reale.
emitter.setMaxListeners(0);

function channel(userId: string): string {
  return `notif:${userId}`;
}

export const notificationsBus = {
  /** Pubblica una notifica appena creata verso lo stream dell'utente. */
  emitToUser(userId: string, notification: Notification): void {
    emitter.emit(channel(userId), notification);
  },
  /** Sottoscrive lo stream di un utente. Ritorna la funzione di unsubscribe. */
  subscribe(userId: string, handler: (n: Notification) => void): () => void {
    const ch = channel(userId);
    emitter.on(ch, handler);
    return () => { emitter.off(ch, handler); };
  },
  /** Numero di stream attivi per un utente (per test/diagnostica). */
  listenerCount(userId: string): number {
    return emitter.listenerCount(channel(userId));
  },
};
