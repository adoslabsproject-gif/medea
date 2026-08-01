/**
 * Test y-collab — relay WS Yjs.
 *
 * Il cuore è il ROUND-TRIP del protocollo: il server (y-collab) e il client
 * (y-websocket) devono parlare lo STESSO protocollo y-protocols. Il test simula
 * un client reale con le stesse librerie e verifica la convergenza dei doc —
 * il tipo di test che avrebbe scovato il disallineamento raw/length-prefix che
 * il source-string matching non vedeva. Più: difese (size-cap, auth, origin,
 * soft-error, quarantine, snapshot recovery).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import {
  encodeSyncStep1, encodeSyncUpdate, encodeAwarenessStates, processCollabMessage,
} from './y-collab.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const yCollabSource = readFileSync(join(__dirname, 'y-collab.ts'), 'utf-8');

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/** Simula il client y-websocket: legge un frame SYNC e produce l'eventuale risposta. */
function clientProcessSync(clientDoc: Y.Doc, message: Uint8Array): Uint8Array | null {
  const decoder = decoding.createDecoder(message);
  const messageType = decoding.readVarUint(decoder);
  expect(messageType).toBe(MESSAGE_SYNC);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.readSyncMessage(decoder, encoder, clientDoc, 'client');
  return encoding.length(encoder) > 1 ? encoding.toUint8Array(encoder) : null;
}

describe('y-collab — 🚨 ROUND-TRIP protocollo (server ↔ client y-protocols reale)', () => {
  it('server→client: lo stato del server raggiunge il client e converge', () => {
    const serverDoc = new Y.Doc();
    serverDoc.getMap('nodes').set('n1', 'http');
    const serverAw = new awarenessProtocol.Awareness(serverDoc);
    const clientDoc = new Y.Doc();

    // Il client (vuoto) chiede lo stato col proprio STEP_1; il server risponde
    // STEP_2 col diff; il client lo applica → converge. È il flusso reale di
    // y-websocket (ogni lato manda STEP_1 e l'altro risponde STEP_2).
    const clientStep1 = encodeSyncStep1(clientDoc);
    const serverReply = processCollabMessage(serverDoc, serverAw, clientStep1, 'wsA');
    expect(serverReply).not.toBeNull();
    clientProcessSync(clientDoc, serverReply!);

    expect(clientDoc.getMap('nodes').get('n1')).toBe('http');
  });

  it('client→server: un edit del client viene applicato al doc del server', () => {
    const serverDoc = new Y.Doc();
    const serverAw = new awarenessProtocol.Awareness(serverDoc);
    const clientDoc = new Y.Doc();
    let frame: Uint8Array | null = null;
    clientDoc.on('update', (update: Uint8Array) => { frame = encodeSyncUpdate(update); });
    clientDoc.getMap('nodes').set('n2', 'slack');

    expect(frame).not.toBeNull();
    processCollabMessage(serverDoc, serverAw, frame!, 'wsB');
    expect(serverDoc.getMap('nodes').get('n2')).toBe('slack');
  });

  it('🚨 REGRESSION: il vecchio formato raw NON faceva convergere il client; il nuovo sì', () => {
    const serverDoc = new Y.Doc();
    serverDoc.getMap('m').set('k', 'v');
    const serverAw = new awarenessProtocol.Awareness(serverDoc);
    const rawUpdate = Y.encodeStateAsUpdate(serverDoc);

    // Vecchio formato del server: [MESSAGE_SYNC, SYNC_STEP_2][raw update] SENZA
    // il length-prefix che y-protocols si aspetta. Il client o lancia
    // "Unexpected end of array" o legge garbage — in NESSUN caso converge.
    const rawFrame = Uint8Array.from([MESSAGE_SYNC, 1, ...rawUpdate]);
    const brokenClient = new Y.Doc();
    try { clientProcessSync(brokenClient, rawFrame); } catch { /* end-of-array atteso */ }
    expect(brokenClient.getMap('m').get('k')).not.toBe('v'); // NON converge

    // Nuovo protocollo: client chiede con STEP_1, server risponde, converge.
    const okClient = new Y.Doc();
    const reply = processCollabMessage(serverDoc, serverAw, encodeSyncStep1(okClient), 'ws');
    expect(reply).not.toBeNull();
    clientProcessSync(okClient, reply!);
    expect(okClient.getMap('m').get('k')).toBe('v'); // converge ✓
  });

  it('convergenza a 3 nodi: due edit client separati arrivano entrambi al server', () => {
    const serverDoc = new Y.Doc();
    const serverAw = new awarenessProtocol.Awareness(serverDoc);
    const clientDoc = new Y.Doc();
    const frames: Uint8Array[] = [];
    clientDoc.on('update', (u: Uint8Array) => { frames.push(encodeSyncUpdate(u)); });
    clientDoc.getMap('nodes').set('a', '1');
    clientDoc.getMap('nodes').set('b', '2');
    for (const f of frames) processCollabMessage(serverDoc, serverAw, f, 'wsC');
    expect(serverDoc.getMap('nodes').get('a')).toBe('1');
    expect(serverDoc.getMap('nodes').get('b')).toBe('2');
  });

  it('awareness: frame del server decodificabile dal client → presence propagata', () => {
    const doc = new Y.Doc();
    const aw = new awarenessProtocol.Awareness(doc);
    aw.setLocalStateField('user', { id: 'ada', name: 'Ada' });
    const frame = encodeAwarenessStates(aw, Array.from(aw.getStates().keys()));
    expect(frame).not.toBeNull();

    const clientAw = new awarenessProtocol.Awareness(new Y.Doc());
    const decoder = decoding.createDecoder(frame!);
    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_AWARENESS);
    awarenessProtocol.applyAwarenessUpdate(clientAw, decoding.readVarUint8Array(decoder), 'srv');
    const found = Array.from(clientAw.getStates().values()).some(
      (s) => (s as { user?: { id: string } }).user?.id === 'ada',
    );
    expect(found).toBe(true);
  });

  it('encodeAwarenessStates([]) → null (nessuno stato → nessun frame)', () => {
    const aw = new awarenessProtocol.Awareness(new Y.Doc());
    expect(encodeAwarenessStates(aw, [])).toBeNull();
  });

  it('processCollabMessage ignora messageType sconosciuto senza throw', () => {
    const doc = new Y.Doc();
    const aw = new awarenessProtocol.Awareness(doc);
    expect(processCollabMessage(doc, aw, Uint8Array.from([99, 0, 0]), 'x')).toBeNull();
  });

  it('processCollabMessage su SYNC_STEP_1 del client ritorna SYNC_STEP_2 (risposta diretta)', () => {
    const serverDoc = new Y.Doc();
    serverDoc.getMap('m').set('k', 'v');
    const serverAw = new awarenessProtocol.Awareness(serverDoc);
    // Client manda STEP_1 (il suo state vector vuoto).
    const clientDoc = new Y.Doc();
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, clientDoc);
    const reply = processCollabMessage(serverDoc, serverAw, encoding.toUint8Array(enc), 'ws');
    expect(reply).not.toBeNull(); // il server risponde STEP_2 col suo stato
    clientProcessSync(clientDoc, reply!);
    expect(clientDoc.getMap('m').get('k')).toBe('v');
  });
});

describe('y-collab — memory leak fix on ws.close', () => {
  it('on close → cleanup rooms.delete quando ultimo client', () => {
    expect(yCollabSource).toMatch(/room\.clients\.size\s*===\s*0[\s\S]+?rooms\.delete/);
  });
  it('cleanup chiama saveRoom se dirty', () => {
    expect(yCollabSource).toMatch(/if\s*\(room\.dirty\)\s*saveRoom/);
  });
  it('cleanup distrugge il Y.Doc e l\'awareness', () => {
    expect(yCollabSource).toMatch(/room\.doc\.destroy/);
    expect(yCollabSource).toMatch(/room\.awareness\.destroy/);
  });
});

describe('y-collab — WS auth dual-name cookie', () => {
  it('importa parseSessionFromCookieHeader', () => {
    expect(yCollabSource).toMatch(/parseSessionFromCookieHeader/);
  });
  it('cookie preferito su URL query (anti-leak nginx logs)', () => {
    expect(yCollabSource).toMatch(/cookieToken\s*!==\s*''\s*\?\s*cookieToken\s*:\s*\(?url\.searchParams\.get\(['"]token['"]\)/);
  });
});

describe('y-collab — N16 audit: WS Origin allowlist (CSWSH defense)', () => {
  it('isOriginAllowed + allowlist prod/dev', () => {
    expect(yCollabSource).toMatch(/function isOriginAllowed/);
    expect(yCollabSource).toMatch(/\\\.app\\\.automazionezeli\\\.com/);
    expect(yCollabSource).toMatch(/127\\\.0\\\.0\\\.1|localhost/);
  });
  it('Origin assente → allow; rejected → socket.destroy()', () => {
    expect(yCollabSource).toMatch(/if\s*\(!origin\)\s*return\s+true/);
    expect(yCollabSource).toMatch(/socket\.destroy\(\)/);
  });
  it('check Origin PRECEDE wss.handleUpgrade', () => {
    expect(yCollabSource.indexOf('isOriginAllowed(origin)')).toBeLessThan(yCollabSource.indexOf('wss.handleUpgrade(request, socket, head'));
  });
});

describe('y-collab — N9 audit: size cap (DoS guard)', () => {
  it('MAX_YJS_MESSAGE_BYTES, default 1MB, env-configurabile', () => {
    expect(yCollabSource).toMatch(/MAX_YJS_MESSAGE_BYTES/);
    expect(yCollabSource).toMatch(/1024\s*\*\s*1024|1048576/);
    expect(yCollabSource).toMatch(/FLOWFORGE_YJS_MAX_MESSAGE_BYTES/);
  });
  it('drop con log.warn + return su oversize (no disconnect)', () => {
    expect(yCollabSource).toMatch(/buf\.length\s*>\s*MAX_YJS_MESSAGE_BYTES[\s\S]+?logger\.warn[\s\S]+?return/);
  });
  it('🚨 il size-cap PRECEDE processCollabMessage (no decode prima del cap)', () => {
    const capIdx = yCollabSource.indexOf('buf.length > MAX_YJS_MESSAGE_BYTES');
    const procIdx = yCollabSource.indexOf('processCollabMessage(room.doc');
    expect(capIdx).toBeGreaterThan(0);
    expect(procIdx).toBeGreaterThan(0);
    expect(capIdx).toBeLessThan(procIdx);
  });
  it('🚨 il message handler è in try/catch con recordRoomCrash (anti-restart-loop)', () => {
    const procIdx = yCollabSource.indexOf('processCollabMessage(room.doc');
    expect(procIdx).toBeGreaterThan(0);
    const head = yCollabSource.slice(Math.max(0, procIdx - 600), procIdx);
    expect(head).toMatch(/try\s*\{/); // la chiamata è dentro un try
    const tail = yCollabSource.slice(procIdx, procIdx + 600);
    expect(tail).toMatch(/catch[\s\S]+?recordRoomCrash/);
  });
});

describe('y-collab — soft uncaughtException handler', () => {
  it('main.ts differenzia errori lib0/yjs vs altri', () => {
    const mainSrc = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');
    expect(mainSrc).toMatch(/isYjsError|lib0|yjs/);
    expect(mainSrc).toMatch(/softened|NON exit|return/);
  });
  it('installYjsSoftErrorHandler idempotente', async () => {
    const { installYjsSoftErrorHandler, __resetYjsSoftErrorHandler } = await import('./y-collab.js');
    __resetYjsSoftErrorHandler();
    installYjsSoftErrorHandler();
    expect(() => installYjsSoftErrorHandler()).not.toThrow();
    __resetYjsSoftErrorHandler();
  });
});

describe('y-collab — auto-recovery on corrupt snapshot', () => {
  it('getRoom DELETE riga workflow_collab su applyUpdate fail (rehydrate)', () => {
    expect(yCollabSource).toMatch(/Y\.applyUpdate\(doc, new Uint8Array\(row\.doc_snapshot\)\)[\s\S]+?catch[\s\S]+?DELETE FROM workflow_collab/);
  });
});

describe('y-collab — crash quarantine', () => {
  const mkRoom = (over: Partial<{ crashCount: number; lastCrashAt: number }> = {}) =>
    ({ doc: null as never, awareness: null as never, clients: new Set(), dirty: false, saveTimer: null, crashCount: 0, lastCrashAt: 0, quarantined: false, ...over });

  it('under threshold → no quarantena', async () => {
    const { recordRoomCrash } = await import('./y-collab.js');
    const room = mkRoom();
    for (let i = 0; i < 4; i++) expect(recordRoomCrash(room as never, 'wf1', 'ten1')).toBe(false);
    expect(room.quarantined).toBe(false);
    expect(room.crashCount).toBe(4);
  });
  it('oltre threshold → quarantined=true', async () => {
    const { recordRoomCrash } = await import('./y-collab.js');
    const room = mkRoom();
    for (let i = 0; i < 5; i++) recordRoomCrash(room as never, 'wf1', 'ten1');
    expect(room.quarantined).toBe(true);
  });
  it('reset finestra dopo CRASH_QUARANTINE_WINDOW_MS', async () => {
    const { recordRoomCrash } = await import('./y-collab.js');
    const room = mkRoom({ crashCount: 3, lastCrashAt: Date.now() - 70_000 });
    expect(recordRoomCrash(room as never, 'wf1', 'ten1')).toBe(false);
    expect(room.crashCount).toBe(1);
  });
  it('releaseRoomQuarantine: false se room non esiste', async () => {
    const { releaseRoomQuarantine } = await import('./y-collab.js');
    expect(releaseRoomQuarantine('non-existent', 'no-tenant')).toBe(false);
  });
});
