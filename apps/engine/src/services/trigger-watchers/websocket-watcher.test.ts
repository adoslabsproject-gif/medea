/**
 * Bug-bounty — trigger-watchers/websocket-watcher.
 *
 * Nel monolite il watcher usava `new WebSocket` + `this.runs` inline → backoff,
 * anti-flood e reconnect erano testabili SOLO con un server ws reale (e infatti
 * la caratterizzazione e2e in trigger-watchers.service.test.ts non li copre).
 * Con la factory iniettata pinniamo qui le invarianti di resilienza:
 *   - config invalida → null, NESSUN socket creato (niente risorse leakate);
 *   - backoff esponenziale ESATTO: 1s→2s→4s→…→cap 30s, reset a 1s su open;
 *   - reconnect='false' → un drop è definitivo;
 *   - anti-flood sliding-window 1s con clock iniettato (drop oltre il budget,
 *     finestra che scorre → il budget si riapre);
 *   - JSON pointer: no-match → NESSUN run; match → `matched` nel payload;
 *   - teardown: idempotente, cancella reconnect pendente, close post-teardown
 *     non riconnette MAI (no zombie reconnect loop);
 *   - dispatch fallito → loggato, MAI unhandled rejection.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  startWebSocketWatcher,
  teardownWebSocketWatcher,
  parseWsHeaders,
  WS_BACKOFF_INITIAL_MS,
  WS_BACKOFF_CAP_MS,
  type WatcherSocket,
  type WebSocketWatcherDeps,
} from './websocket-watcher.js';
import type { TriggerRunInput, TriggerRunResult } from './run-dispatcher.js';
import type { CanvasNode, Workflow } from '@medea/engine-core-schema';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function makeWf(over: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-ws',
    tenantId: 'tenant-a',
    name: 'WS',
    enabled: true,
    schemaVersion: '1.0.0',
    nodes: [],
    edges: [],
    nodeDefs: [],
    createdAt: '2026-06-12',
    updatedAt: '2026-06-12',
    ...over,
  } as Workflow;
}

function makeNode(config: Record<string, string>): CanvasNode {
  return { id: 'n1', defId: 'trigger_websocket', config } as unknown as CanvasNode;
}

/** Contravarianza: ogni listener concreto ((), (raw), (err)) è assegnabile qui. */
type AnyListener = (...args: never[]) => void;

class FakeSocket implements WatcherSocket {
  listeners = new Map<string, AnyListener[]>();
  sent: string[] = [];
  pings = 0;
  closeCalls = 0;
  on(event: string, listener: AnyListener): unknown {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
    return this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  ping(): void {
    this.pings += 1;
  }
  close(): void {
    this.closeCalls += 1;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) (cb as (...a: unknown[]) => void)(...args);
  }
  /** Simula un messaggio in arrivo come Buffer (= RawData reale di `ws`). */
  message(text: string): void {
    this.emit('message', Buffer.from(text, 'utf8'));
  }
}

function makeDeps(over: Partial<WebSocketWatcherDeps> = {}): {
  deps: WebSocketWatcherDeps;
  sockets: FakeSocket[];
  createSocket: ReturnType<typeof vi.fn>;
  dispatched: TriggerRunInput[];
} {
  const sockets: FakeSocket[] = [];
  const dispatched: TriggerRunInput[] = [];
  const createSocket = vi.fn((_url: string, _headers: Record<string, string> | null) => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  });
  const deps: WebSocketWatcherDeps = {
    dispatchRun: async (input: TriggerRunInput): Promise<TriggerRunResult> => {
      dispatched.push(input);
      return { runId: 'r-1', status: 'success', errorCount: 0 };
    },
    createSocket,
    ...over,
  };
  return { deps, sockets, createSocket, dispatched };
}

const VALID = { url: 'ws://example.test/feed', pingIntervalSec: '0', maxMessagesPerSec: '0' };

describe('startWebSocketWatcher — config gate', () => {
  it('URL mancante → null e NESSUN socket creato (no leak di risorse)', () => {
    const { deps, createSocket } = makeDeps();
    const job = startWebSocketWatcher(makeWf(), makeNode({}), deps);
    expect(job).toBeNull();
    expect(createSocket).not.toHaveBeenCalled();
  });

  it('URL http:// (non ws/wss) → null', () => {
    const { deps, createSocket } = makeDeps();
    expect(startWebSocketWatcher(makeWf(), makeNode({ url: 'http://nope' }), deps)).toBeNull();
    expect(createSocket).not.toHaveBeenCalled();
  });

  it('wss:// case-insensitive + trim → accettata, socket creato con la URL trimmata', () => {
    const { deps, createSocket } = makeDeps();
    const job = startWebSocketWatcher(
      makeWf(),
      makeNode({ ...VALID, url: '  WSS://secure.test  ' }),
      deps,
    );
    expect(job).not.toBeNull();
    expect(createSocket).toHaveBeenCalledWith('WSS://secure.test', null);
  });

  it('headersJson valido → passato alla factory (solo i valori stringa)', () => {
    const { deps, createSocket } = makeDeps();
    startWebSocketWatcher(
      makeWf(),
      makeNode({ ...VALID, headersJson: '{"Authorization":"Bearer x","n":1}' }),
      deps,
    );
    expect(createSocket).toHaveBeenCalledWith('ws://example.test/feed', {
      Authorization: 'Bearer x',
    });
  });

  // H5 — validare lo SCHEMA non basta: senza check dell'HOST un ws:// verso un IP
  // privato/interno è SSRF (IMDS, Redis interno, cross-tenant su flowforge-net).
  it('🚨 H5 SSRF: ws:// verso IMDS 169.254.169.254 → null, NESSUN socket creato', () => {
    const { deps, createSocket } = makeDeps();
    expect(
      startWebSocketWatcher(
        makeWf(),
        makeNode({ ...VALID, url: 'ws://169.254.169.254/latest/meta-data' }),
        deps,
      ),
    ).toBeNull();
    expect(createSocket).not.toHaveBeenCalled();
  });

  it('🚨 H5 SSRF: wss:// verso IP privato 10.x (servizio interno) → null', () => {
    const { deps, createSocket } = makeDeps();
    expect(
      startWebSocketWatcher(makeWf(), makeNode({ ...VALID, url: 'wss://10.0.0.5:6379' }), deps),
    ).toBeNull();
    expect(createSocket).not.toHaveBeenCalled();
  });
});

describe('messaggi → run dispatch', () => {
  it('messaggio JSON → dispatch con data parsata, raw originale, receivedAt ISO, tenant del workflow', async () => {
    const { deps, sockets, dispatched } = makeDeps();
    startWebSocketWatcher(makeWf(), makeNode(VALID), deps);
    sockets[0]!.message('{"type":"trade","price":42}');
    await Promise.resolve();
    expect(dispatched).toHaveLength(1);
    const input = dispatched[0]!;
    expect(input.workflowId).toBe('wf-ws');
    expect(input.tenantId).toBe('tenant-a');
    expect(input.triggerType).toBe('websocket');
    const ti = input.triggerInput as Record<string, unknown>;
    expect(ti.data).toEqual({ type: 'trade', price: 42 });
    expect(ti.raw).toBe('{"type":"trade","price":42}');
    expect(typeof ti.receivedAt).toBe('string');
    expect(() => new Date(ti.receivedAt as string).toISOString()).not.toThrow();
    // Senza pointer il payload NON deve contenere la chiave `matched`.
    expect('matched' in ti).toBe(false);
  });

  it('jsonParse="false" → data resta la stringa grezza', () => {
    const { deps, sockets, dispatched } = makeDeps();
    startWebSocketWatcher(makeWf(), makeNode({ ...VALID, jsonParse: 'false' }), deps);
    sockets[0]!.message('{"k":1}');
    expect((dispatched[0]!.triggerInput as Record<string, unknown>).data).toBe('{"k":1}');
  });

  it('JSON invalido con jsonParse on → fallback alla stringa grezza (niente crash)', () => {
    const { deps, sockets, dispatched } = makeDeps();
    startWebSocketWatcher(makeWf(), makeNode(VALID), deps);
    sockets[0]!.message('not-json{{');
    expect((dispatched[0]!.triggerInput as Record<string, unknown>).data).toBe('not-json{{');
  });

  it('messagePointer senza match → NESSUN run; con match → `matched` nel payload', () => {
    const { deps, sockets, dispatched } = makeDeps();
    startWebSocketWatcher(makeWf(), makeNode({ ...VALID, messagePointer: '/type' }), deps);
    sockets[0]!.message('{"other":1}');
    expect(dispatched).toHaveLength(0);
    sockets[0]!.message('{"type":"fill"}');
    expect(dispatched).toHaveLength(1);
    expect((dispatched[0]!.triggerInput as Record<string, unknown>).matched).toBe('fill');
  });

  it('dispatch rigettato → loggato come errore, MAI unhandled rejection', async () => {
    const { logger } = await import('@/lib/logger.js');
    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const { sockets, ...rest } = makeDeps({
      dispatchRun: async () => {
        throw new Error('run boom');
      },
    });
    startWebSocketWatcher(makeWf(), makeNode(VALID), rest.deps);
    sockets[0]!.message('{"a":1}');
    await new Promise((r) => setImmediate(r));
    expect(errSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-ws' }),
      'websocket run failed',
    );
  });
});

describe('anti-flood sliding window (clock iniettato)', () => {
  it('oltre il budget nello stesso secondo → drop; finestra scorsa → budget riaperto', () => {
    let nowMs = 100_000;
    const { deps, sockets, dispatched } = makeDeps({ now: () => nowMs });
    startWebSocketWatcher(makeWf(), makeNode({ ...VALID, maxMessagesPerSec: '2' }), deps);
    const s = sockets[0]!;
    s.message('{"i":1}');
    s.message('{"i":2}');
    s.message('{"i":3}'); // 3° nello stesso ms → oltre budget 2
    expect(dispatched).toHaveLength(2);
    nowMs += 999; // ancora dentro la finestra di 1s
    s.message('{"i":4}');
    expect(dispatched).toHaveLength(2);
    nowMs += 2; // 1001ms dal primo → finestra scorsa
    s.message('{"i":5}');
    expect(dispatched).toHaveLength(3);
  });

  it('FIX bug fail-open: maxMessagesPerSec non numerico → default 20 ATTIVO (non anti-flood spento)', () => {
    const { deps, sockets, dispatched } = makeDeps({ now: () => 0 });
    startWebSocketWatcher(
      makeWf(),
      makeNode({ url: 'ws://x.test', pingIntervalSec: '0', maxMessagesPerSec: 'abc' }),
      deps,
    );
    for (let i = 0; i < 25; i += 1) sockets[0]!.message(`{"i":${String(i)}}`);
    expect(dispatched).toHaveLength(20); // default 20, non illimitato
  });

  it('FIX bug NaN: pingIntervalSec non numerico → default 30s di keepalive (non ping spento)', () => {
    vi.useFakeTimers();
    const { deps, sockets } = makeDeps();
    startWebSocketWatcher(
      makeWf(),
      makeNode({ url: 'ws://x.test', pingIntervalSec: 'abc', maxMessagesPerSec: '0' }),
      deps,
    );
    sockets[0]!.emit('open');
    vi.advanceTimersByTime(30_000);
    expect(sockets[0]!.pings).toBe(1);
  });

  it('maxMessagesPerSec=0 → illimitato', () => {
    const { deps, sockets, dispatched } = makeDeps({ now: () => 0 });
    startWebSocketWatcher(makeWf(), makeNode({ ...VALID, maxMessagesPerSec: '0' }), deps);
    for (let i = 0; i < 50; i += 1) sockets[0]!.message(`{"i":${String(i)}}`);
    expect(dispatched).toHaveLength(50);
  });
});

describe('open: subscribe + keepalive ping', () => {
  it('on open invia subscribeMessage (trimmato) e avvia il ping al periodo configurato', () => {
    vi.useFakeTimers();
    const { deps, sockets } = makeDeps();
    startWebSocketWatcher(
      makeWf(),
      makeNode({
        url: 'ws://example.test',
        subscribeMessage: ' {"op":"subscribe"} ',
        pingIntervalSec: '5',
        maxMessagesPerSec: '0',
      }),
      deps,
    );
    const s = sockets[0]!;
    s.emit('open');
    expect(s.sent).toEqual(['{"op":"subscribe"}']);
    vi.advanceTimersByTime(4_999);
    expect(s.pings).toBe(0);
    vi.advanceTimersByTime(1);
    expect(s.pings).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(s.pings).toBe(3);
  });

  it('pingIntervalSec=0 → nessun ping timer', () => {
    vi.useFakeTimers();
    const { deps, sockets } = makeDeps();
    const job = startWebSocketWatcher(makeWf(), makeNode(VALID), deps);
    sockets[0]!.emit('open');
    expect(job!.pingTimer).toBeNull();
    vi.advanceTimersByTime(120_000);
    expect(sockets[0]!.pings).toBe(0);
  });

  it('send del subscribe che lancia → warn, il watcher sopravvive', async () => {
    const { logger } = await import('@/lib/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const { deps, sockets, dispatched } = makeDeps();
    startWebSocketWatcher(makeWf(), makeNode({ ...VALID, subscribeMessage: '{"op":"sub"}' }), deps);
    const s = sockets[0]!;
    s.send = () => {
      throw new Error('send boom');
    };
    s.emit('open');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-ws' }),
      'websocket subscribe send failed',
    );
    s.message('{"alive":true}');
    expect(dispatched).toHaveLength(1);
  });
});

describe('backoff esponenziale di riconnessione', () => {
  it('sequenza esatta 1s→2s→4s→…→cap 30s; open resetta a 1s', () => {
    vi.useFakeTimers();
    const { deps, sockets, createSocket } = makeDeps();
    const job = startWebSocketWatcher(makeWf(), makeNode(VALID), deps)!;
    expect(job.backoffMs).toBe(WS_BACKOFF_INITIAL_MS);

    // Drop ripetuti senza mai riconnettersi: delay usato = backoff corrente,
    // poi raddoppia fino al cap.
    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const [i, delay] of expectedDelays.entries()) {
      sockets[sockets.length - 1]!.emit('close');
      expect(job.socket).toBeNull();
      vi.advanceTimersByTime(delay - 1);
      expect(createSocket).toHaveBeenCalledTimes(i + 1); // non ancora riconnesso
      vi.advanceTimersByTime(1);
      expect(createSocket).toHaveBeenCalledTimes(i + 2);
    }
    expect(job.backoffMs).toBe(WS_BACKOFF_CAP_MS);

    // open sulla connessione viva → reset del backoff.
    sockets[sockets.length - 1]!.emit('open');
    expect(job.backoffMs).toBe(WS_BACKOFF_INITIAL_MS);
  });

  it("reconnect='false' → il drop è definitivo, nessuna riconnessione", () => {
    vi.useFakeTimers();
    const { deps, sockets, createSocket } = makeDeps();
    startWebSocketWatcher(makeWf(), makeNode({ ...VALID, reconnect: 'false' }), deps);
    sockets[0]!.emit('close');
    vi.advanceTimersByTime(120_000);
    expect(createSocket).toHaveBeenCalledTimes(1);
  });

  it('close cancella il ping timer (niente ping su socket morto)', () => {
    vi.useFakeTimers();
    const { deps, sockets } = makeDeps();
    const job = startWebSocketWatcher(
      makeWf(),
      makeNode({ url: 'ws://example.test', pingIntervalSec: '5', maxMessagesPerSec: '0' }),
      deps,
    )!;
    const s = sockets[0]!;
    s.emit('open');
    expect(job.pingTimer).not.toBeNull();
    s.emit('close');
    expect(job.pingTimer).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(s.pings).toBe(0);
  });
});

describe('teardownWebSocketWatcher', () => {
  it('chiude il socket vivo e cancella i timer; close post-teardown NON riconnette (no zombie)', () => {
    vi.useFakeTimers();
    const { deps, sockets, createSocket } = makeDeps();
    const job = startWebSocketWatcher(makeWf(), makeNode(VALID), deps)!;
    const s = sockets[0]!;
    teardownWebSocketWatcher(job);
    expect(job.closing).toBe(true);
    expect(job.socket).toBeNull();
    expect(s.closeCalls).toBe(1);
    // Il server chiude DOPO il teardown (race reale): nessun reconnect.
    s.emit('close');
    vi.advanceTimersByTime(120_000);
    expect(createSocket).toHaveBeenCalledTimes(1);
  });

  it('cancella un reconnect PENDENTE (race teardown-durante-backoff)', () => {
    vi.useFakeTimers();
    const { deps, sockets, createSocket } = makeDeps();
    const job = startWebSocketWatcher(makeWf(), makeNode(VALID), deps)!;
    sockets[0]!.emit('close'); // schedula reconnect a 1s
    expect(job.reconnectTimer).not.toBeNull();
    teardownWebSocketWatcher(job);
    expect(job.reconnectTimer).toBeNull();
    vi.advanceTimersByTime(120_000);
    expect(createSocket).toHaveBeenCalledTimes(1);
  });

  it('è idempotente (doppio teardown non lancia)', () => {
    const { deps } = makeDeps();
    const job = startWebSocketWatcher(makeWf(), makeNode(VALID), deps)!;
    teardownWebSocketWatcher(job);
    expect(() => {
      teardownWebSocketWatcher(job);
    }).not.toThrow();
  });

  it('socket.close() che lancia → swallowed (teardown best-effort)', () => {
    const { deps, sockets } = makeDeps();
    const job = startWebSocketWatcher(makeWf(), makeNode(VALID), deps)!;
    sockets[0]!.close = () => {
      throw new Error('already closed');
    };
    expect(() => {
      teardownWebSocketWatcher(job);
    }).not.toThrow();
    expect(job.socket).toBeNull();
  });
});

describe('parseWsHeaders (pura)', () => {
  it.each([
    ['non-string', 42],
    ['stringa vuota', ''],
    ['solo spazi', '   '],
    ['array JSON', '[1,2]'],
    ['null JSON', 'null'],
    ['oggetto senza valori stringa', '{"n":1,"b":true}'],
  ])('%s → null', (_label, raw) => {
    expect(parseWsHeaders('wf-x', raw)).toBeNull();
  });

  it('JSON invalido → null + warn con workflowId (diagnosi operatore)', async () => {
    const { logger } = await import('@/lib/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    expect(parseWsHeaders('wf-x', '{broken')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-x' }),
      'trigger_websocket: headersJson invalido — ignorato',
    );
  });

  it('tiene SOLO i valori stringa, scarta il resto', () => {
    expect(parseWsHeaders('wf-x', '{"Authorization":"Bearer t","X-N":7,"X-Ok":"si"}')).toEqual({
      Authorization: 'Bearer t',
      'X-Ok': 'si',
    });
  });
});
