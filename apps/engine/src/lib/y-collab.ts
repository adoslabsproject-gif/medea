/**
 * Real-time multi-user workflow collaboration via Y.js CRDT.
 *
 * Each workflow has a Yjs document keyed by workflow id; the WS server
 * attaches /collab/:workflowId/:tenantToken and pipes Yjs sync messages.
 * Persistence: the doc is serialized to workflow_collab table periodically;
 * on reconnect, the doc is rehydrated from the last snapshot.
 */

import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { Server as HttpServer } from 'node:http';
import { verifySessionToken } from '@flowforge/auth-local';
import { getDatabase } from '@/storage/db.js';
import { logger } from './logger.js';
import { parseSessionFromCookieHeader } from './session-cookie.js';

interface CollabRoom {
  doc: Y.Doc;
  /** Awareness server-side (y-protocols): presence completa anche ai nuovi client. */
  awareness: awarenessProtocol.Awareness;
  clients: Set<WebSocket>;
  dirty: boolean;
  saveTimer: ReturnType<typeof setTimeout> | null;
  /** Cappella Sistina #4: crash count per quarantena workflow problematici. */
  crashCount: number;
  lastCrashAt: number;
  quarantined: boolean;
}

// Tipi di messaggio top-level (y-protocols): byte iniziale di ogni frame.
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/** Cappella Sistina #4: dopo N crash in M ms, il room va in quarantena. */
const CRASH_QUARANTINE_THRESHOLD = 5;
const CRASH_QUARANTINE_WINDOW_MS = 60_000;

// ─── Protocollo y-protocols (estratto per testabilità round-trip) ─────────────
// Queste funzioni implementano ESATTAMENTE il protocollo che il client
// y-websocket parla (y-protocols/sync + awareness, frame length-prefixed). Sono
// pure → testabili con un vero client y-protocols, senza WebSocket reale.

/** Frame SYNC_STEP_1 (state vector del doc): primo handshake verso un nuovo client. */
export function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

/** Frame SYNC update (per ribroadcast di un update applicato). */
export function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

/** Frame AWARENESS per gli stati indicati, o null se nessuno. */
export function encodeAwarenessStates(awareness: awarenessProtocol.Awareness, clients: number[]): Uint8Array | null {
  if (clients.length === 0) return null;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, clients));
  return encoding.toUint8Array(encoder);
}

/**
 * Processa un frame in arrivo dal client. Applica sync/awareness al doc/awareness
 * (origin = la connessione, così i listener ribroadcastano agli altri) e ritorna
 * l'eventuale risposta diretta da inviare al mittente (es. SYNC_STEP_2 in
 * risposta a SYNC_STEP_1), o null se non c'è nulla da rispondere.
 */
export function processCollabMessage(
  doc: Y.Doc,
  awareness: awarenessProtocol.Awareness,
  message: Uint8Array,
  origin: unknown,
): Uint8Array | null {
  const decoder = decoding.createDecoder(message);
  const messageType = decoding.readVarUint(decoder);
  if (messageType === MESSAGE_SYNC) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, doc, origin);
    // length > 1: oltre al byte messageType c'è una risposta (SYNC_STEP_2).
    return encoding.length(encoder) > 1 ? encoding.toUint8Array(encoder) : null;
  }
  if (messageType === MESSAGE_AWARENESS) {
    awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), origin);
    return null;
  }
  return null;
}

/**
 * Cappella Sistina #2 — Soft uncaughtException handler per errori da lib0/y-*.
 *
 * Default Node: uncaughtException → process.exit. Per i nostri use-case di
 * WS Y.js mal-formati (client browser corrotto, peer malicious, doc snapshot
 * vecchio incompatibile), il crash del processo NON è la risposta corretta:
 * il container restart toglie SERVIZIO A TUTTI i workflow per via di UN
 * doc rotto di UN tenant. Soluzione:
 *
 *  - Se errore proviene da modulo `lib0/*` o `yjs/*` → log strutturato +
 *    increment counter audit + CONTINUE (process resta vivo).
 *  - Se errore proviene da altro modulo → comportamento default (exit/restart).
 *
 * Installazione idempotente — multipli call non duplicano i listener.
 */
let yjsSoftErrorHandlerInstalled = false;
let yjsSoftErrorCount = 0;
export function installYjsSoftErrorHandler(): void {
  if (yjsSoftErrorHandlerInstalled) return;
  yjsSoftErrorHandlerInstalled = true;
  const isYjsModuleError = (err: unknown): boolean => {
    if (!(err instanceof Error)) return false;
    const stack = err.stack ?? '';
    return /[/\\]node_modules[/\\](?:\.pnpm[/\\])?(lib0|yjs)[@/\\]/.test(stack);
  };
  process.on('uncaughtException', (err: unknown) => {
    if (!isYjsModuleError(err)) {
      // Non un errore Yjs → propagate (lasciamo che il fatal-handler del runtime processi)
      throw err;
    }
    yjsSoftErrorCount++;
    logger.error(
      { err, count: yjsSoftErrorCount, soft: true },
      '[y-collab] uncaughtException da lib0/yjs — softened (container NON exit)',
    );
  });
}

/** Solo per test — reset state. */
export function __resetYjsSoftErrorHandler(): void {
  yjsSoftErrorHandlerInstalled = false;
  yjsSoftErrorCount = 0;
}

/** Solo per test — leggi counter. */
export function getYjsSoftErrorCount(): number {
  return yjsSoftErrorCount;
}

/**
 * N9 audit (2026-05-29): cap massimo per messaggio WebSocket Y.js.
 * Y.applyUpdate alloca memoria proporzionalmente al payload; senza cap
 * un client autenticato (XSS o curl) puo\` OOM-are il container con un
 * singolo ws.send di 100MB. broadcast() amplifica a N clients.
 *
 * 1 MB cap copre tutti i workflow realistici (i nostri telemetri mostrano
 * max ~150 KB per workflow con 500+ nodi). Configurabile via env per
 * use case enterprise con workflow > 1MB.
 */
export const MAX_YJS_MESSAGE_BYTES = Number(
  process.env.FLOWFORGE_YJS_MAX_MESSAGE_BYTES ?? 1024 * 1024,
);

function ensureCollabTable(): void {
  const { sqlite } = getDatabase();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workflow_collab (
      workflow_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      doc_snapshot BLOB NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

const rooms = new Map<string, CollabRoom>();

function getRoom(workflowId: string, tenantId: string): CollabRoom {
  ensureCollabTable();
  const key = `${tenantId}:${workflowId}`;
  let room = rooms.get(key);
  if (room) return room;

  const doc = new Y.Doc();
  // Rehydrate from snapshot if exists.
  // Cappella Sistina #3 (2026-06-09): auto-recovery on corrupt snapshot.
  // Se applyUpdate fail, NON rifare per tutta la vita del processo: NULL la
  // riga DB (snapshot vecchio = bug), reset a Y.Doc nuovo, audit trail.
  const { sqlite } = getDatabase();
  const row = sqlite
    .prepare('SELECT doc_snapshot FROM workflow_collab WHERE workflow_id = ? AND tenant_id = ?')
    .get(workflowId, tenantId) as { doc_snapshot: Buffer } | undefined;
  if (row) {
    try {
      Y.applyUpdate(doc, new Uint8Array(row.doc_snapshot));
    } catch (err) {
      logger.error(
        { err, workflowId, tenantId, snapshotBytes: row.doc_snapshot.length },
        '[y-collab] CORRUPT snapshot — auto-recovery: NULL row, fresh Y.Doc, audit-trail',
      );
      // Cancella la riga corrotta — la prossima save creerà un nuovo snapshot
      // dal Y.Doc fresco. Senza questa cancellazione, ogni reconnect re-applica
      // lo stesso bug fino a riavvio container.
      try {
        sqlite
          .prepare('DELETE FROM workflow_collab WHERE workflow_id = ? AND tenant_id = ?')
          .run(workflowId, tenantId);
      } catch (delErr) {
        logger.warn({ err: delErr, workflowId }, '[y-collab] failed to delete corrupt snapshot');
      }
    }
  }

  const awareness = new awarenessProtocol.Awareness(doc);
  // L'awareness server-side non ha uno stato locale "proprio": è solo l'hub che
  // aggrega la presence dei client. Rimuoviamo il clientID locale del Y.Doc.
  awareness.setLocalState(null);

  room = {
    doc,
    awareness,
    clients: new Set(),
    dirty: false,
    saveTimer: null,
    crashCount: 0,
    lastCrashAt: 0,
    quarantined: false,
  };
  rooms.set(key, room);

  // doc → tutti i client (tranne l'origin che l'ha prodotto): update SYNC
  // length-prefixed via y-protocols, il formato che il client y-websocket legge.
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (!room) return;
    room.dirty = true;
    if (room.saveTimer) clearTimeout(room.saveTimer);
    room.saveTimer = setTimeout(() => { saveRoom(workflowId, tenantId); }, 2000);

    const msg = encodeSyncUpdate(update);
    for (const client of room.clients) {
      if (client === origin || client.readyState !== WebSocket.OPEN) continue;
      try { client.send(msg); } catch (err) { logger.warn({ err }, '[y-collab] sync broadcast failed'); }
    }
  });

  // awareness → tutti i client: presence (chi è online + cursore/colore).
  awareness.on('update', (changes: { added: number[]; updated: number[]; removed: number[] }, _origin: unknown) => {
    if (!room) return;
    const changed = changes.added.concat(changes.updated, changes.removed);
    const msg = encodeAwarenessStates(awareness, changed);
    if (!msg) return;
    for (const client of room.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      try { client.send(msg); } catch (err) { logger.warn({ err }, '[y-collab] awareness broadcast failed'); }
    }
  });

  return room;
}

/**
 * Cappella Sistina #4 — crash quarantine per workflowId.
 *
 * Se un room ha CRASH_QUARANTINE_THRESHOLD crash entro
 * CRASH_QUARANTINE_WINDOW_MS, viene marcato `quarantined=true` e tutte le
 * future connessioni vengono chiuse con codice 1011 ("Internal error: quarantined").
 * Risolve: client buggy che ri-tenta in loop → DoS al server. Reset manuale:
 * riavvio container OR API admin POST /collab/quarantine/release/:wfid.
 */
export function recordRoomCrash(room: CollabRoom, workflowId: string, tenantId: string): boolean {
  const now = Date.now();
  if (now - room.lastCrashAt > CRASH_QUARANTINE_WINDOW_MS) {
    // Reset finestra
    room.crashCount = 1;
    room.lastCrashAt = now;
    return false;
  }
  room.crashCount++;
  room.lastCrashAt = now;
  if (room.crashCount >= CRASH_QUARANTINE_THRESHOLD && !room.quarantined) {
    room.quarantined = true;
    logger.error(
      { workflowId, tenantId, crashCount: room.crashCount, windowMs: CRASH_QUARANTINE_WINDOW_MS },
      '[y-collab] room QUARANTINED — too many crashes, blocking new connections',
    );
    return true;
  }
  return room.quarantined;
}

/** Solo admin/test — rilascia un room dalla quarantena. */
export function releaseRoomQuarantine(workflowId: string, tenantId: string): boolean {
  const room = rooms.get(`${tenantId}:${workflowId}`);
  if (!room) return false;
  room.quarantined = false;
  room.crashCount = 0;
  logger.info({ workflowId, tenantId }, '[y-collab] room released from quarantine');
  return true;
}

function saveRoom(workflowId: string, tenantId: string): void {
  const key = `${tenantId}:${workflowId}`;
  const room = rooms.get(key);
  if (!room?.dirty) return;
  try {
    const snapshot = Y.encodeStateAsUpdate(room.doc);
    const { sqlite } = getDatabase();
    sqlite
      .prepare(
        'INSERT INTO workflow_collab (workflow_id, tenant_id, doc_snapshot, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (workflow_id) DO UPDATE SET doc_snapshot = excluded.doc_snapshot, updated_at = excluded.updated_at',
      )
      .run(workflowId, tenantId, Buffer.from(snapshot), new Date().toISOString());
    room.dirty = false;
  } catch (err) {
    logger.error({ err, workflowId }, 'Failed to persist Y.Doc');
  }
}

// (parseCookieHeader interno rimosso 2026-05-29: sostituito da
// parseSessionFromCookieHeader del helper centralizzato session-cookie.ts
// che gestisce dual-name `__Host-ff_session` + legacy `ff_session`.)

/**
 * N16 audit (2026-05-29): allowlist Origin per WebSocket upgrade.
 *
 * Mitigato gia\` da SameSite=Lax cookie (browser non manda cookie
 * cross-site su WS) + verifySessionToken, ma defense-in-depth: rifiuta
 * upgrade da Origin esterni cosi\` un attacker non puo\` nemmeno aprire
 * la socket (no auth attempt = no DoS al token verify).
 *
 * Allowlist:
 *  - Subdomain `<slug>.app.automazionezeli.com` (production)
 *  - `127.0.0.1:*` / `localhost:*` (development)
 *  - Origin assente (es. curl --no-include-origin, native client) → allow
 *    perche\` non e\` browser → no CSWSH risk; auth resta richiesta.
 */
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/[a-z0-9-]+\.app\.automazionezeli\.com$/i,
  /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i,
];
function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // native client / curl: cookie+token-based auth
  return ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin));
}

export function attachCollabServer(httpServer: HttpServer, publicKeyPem: string): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    if (request.url?.startsWith('/collab/')) {
      const origin = request.headers.origin;
      if (!isOriginAllowed(origin)) {
        logger.warn(
          { origin, url: request.url },
          'WS upgrade rejected: Origin not in allowlist (N16 audit)',
        );
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', (ws, request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const workflowId = parts[1] ?? '';
    // HIGH fix (2026-05-29): token preferenzialmente dal cookie session
    // (HttpOnly, mai loggato in nginx access logs); query string accettata
    // SOLO come fallback per legacy clients.
    // Dual-name lookup (`__Host-ff_session` in prod, `ff_session` legacy).
    const cookieToken = parseSessionFromCookieHeader(request.headers.cookie) ?? '';
    const token = cookieToken !== '' ? cookieToken : (url.searchParams.get('token') ?? '');
    if (!workflowId || !token) {
      ws.close(1008, 'Missing workflow id or token');
      return;
    }

    void verifySessionToken(token, publicKeyPem).then((payload) => {
      if (!payload) {
        ws.close(1008, 'Invalid token');
        return;
      }
      const room = getRoom(workflowId, payload.tenantId);

      // Cappella Sistina #4: quarantine check.
      if (room.quarantined) {
        logger.warn({ workflowId, tenantId: payload.tenantId }, '[y-collab] connection rejected — room quarantined');
        ws.close(1011, 'Workflow temporarily unavailable (quarantined)');
        return;
      }
      room.clients.add(ws);

      // Traccia gli awareness clientID controllati DA QUESTA connessione, per
      // rimuoverli puliti al disconnect (presence aggiornata all'istante).
      const controlledIds = new Set<number>();
      const onAwarenessChange = (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown): void => {
        if (origin !== ws) return;
        for (const id of changes.added) controlledIds.add(id);
        for (const id of changes.removed) controlledIds.delete(id);
      };
      room.awareness.on('update', onAwarenessChange);

      // Handshake y-protocols (il protocollo che il client y-websocket parla):
      //  1) SYNC_STEP_1 = il nostro state vector → il client risponde col diff.
      //  2) Awareness corrente → il nuovo client vede subito chi è online.
      try {
        ws.send(encodeSyncStep1(room.doc));
        const awFrame = encodeAwarenessStates(room.awareness, Array.from(room.awareness.getStates().keys()));
        if (awFrame) ws.send(awFrame);
      } catch (err) {
        logger.warn({ err, workflowId }, '[y-collab] initial sync send failed');
        recordRoomCrash(room, workflowId, payload.tenantId);
      }

      ws.on('message', (raw) => {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        // N9 audit: size cap PRIMA del decode (DoS guard — applyUpdate alloca
        // proporzionalmente al payload).
        if (buf.length > MAX_YJS_MESSAGE_BYTES) {
          logger.warn({ workflowId, size: buf.length, max: MAX_YJS_MESSAGE_BYTES }, 'Y.js message dropped: oversized (DoS guard)');
          return;
        }
        try {
          // processCollabMessage applica sync/awareness (origin=ws → i listener
          // doc/awareness ribroadcastano agli altri) e ritorna l'eventuale
          // risposta diretta (es. SYNC_STEP_2 in risposta a SYNC_STEP_1).
          const reply = processCollabMessage(room.doc, room.awareness, new Uint8Array(buf), ws);
          if (reply) ws.send(reply);
        } catch (err) {
          // Messaggio malformato / doc incompatibile: log + crash-count, MAI exit.
          // Il soft-error-handler globale resta la rete finale anti-restart-loop.
          logger.warn({ err, workflowId, size: buf.length }, '[y-collab] message handling failed');
          recordRoomCrash(room, workflowId, payload.tenantId);
        }
      });

      ws.on('close', () => {
        room.clients.delete(ws);
        room.awareness.off('update', onAwarenessChange);
        // Presence: rimuove subito gli stati awareness di questa connessione
        // (senza, il peer resterebbe "online" fino al timeout outdated ~30s).
        if (controlledIds.size > 0) {
          awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(controlledIds), null);
        }
        // Memory leak fix: ultimo client uscito → save dirty + destroy + unmap.
        if (room.clients.size === 0) {
          if (room.saveTimer) {
            clearTimeout(room.saveTimer);
            room.saveTimer = null;
          }
          if (room.dirty) saveRoom(workflowId, payload.tenantId);
          try { room.awareness.destroy(); } catch { /* ok */ }
          try { room.doc.destroy(); } catch { /* ok */ }
          rooms.delete(`${payload.tenantId}:${workflowId}`);
        }
      });
    }).catch((err: unknown) => {
      logger.warn({ err }, 'Collab WS auth failed');
      ws.close(1011, 'Auth error');
    });
  });

  return wss;
}
