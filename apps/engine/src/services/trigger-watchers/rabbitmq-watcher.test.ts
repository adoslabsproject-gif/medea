/**
 * rabbitmq-watcher — bug-bounty + contract. Nessun broker reale: la connessione
 * AMQP è un fake iniettato via `deps.connect`, il clock e i timer sono controllati.
 *
 * Contract pinnati (mutation-verify: ognuno fallirebbe su una regressione della
 * semantica di consegna o della resilienza):
 *   • AT-LEAST-ONCE: ack SOLO su run riuscito; nack+requeue su run fallito;
 *   • auto-ack: noAck=true, mai ack/nack applicativo;
 *   • filtro pointer: no-match in manual-ack → ack (consumato, non un errore);
 *   • anti-flood: oltre budget → drop + nack requeue (manual);
 *   • reconnect: close → backoff esponenziale con reset su consume; teardown idempotente;
 *   • guard: URL/queue mancanti e host SSRF → null (nessun consumer).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger } from '@/lib/logger.js';
import {
  startRabbitWatcher,
  teardownRabbitWatcher,
  RABBIT_BACKOFF_INITIAL_MS,
  type AmqpChannel,
  type AmqpConnection,
  type AmqpMessage,
  type RabbitWatcherDeps,
} from './rabbitmq-watcher.js';
import type { CanvasNode, Workflow } from '@flowforge/core-schema';

vi.mock('@/lib/logger.js');

// ── Fake AMQP: cattura l'onMessage del consume + gli event listener ──
interface FakeChannel extends AmqpChannel {
  __emit(msg: AmqpMessage | null): void;
  __fire(event: 'error' | 'close', err?: Error): void;
  ack: ReturnType<typeof vi.fn>;
  nack: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}
interface FakeConnection extends AmqpConnection {
  __fire(event: 'error' | 'close', err?: Error): void;
  channel: FakeChannel;
  close: ReturnType<typeof vi.fn>;
}

function makeFakeConnection(opts: { assertQueueThrows?: boolean } = {}): FakeConnection {
  let onMsg: ((msg: AmqpMessage | null) => void) | null = null;
  const chListeners: Record<string, (err?: Error) => void> = {};
  const channel: FakeChannel = {
    assertQueue: vi.fn(async () => { if (opts.assertQueueThrows) throw new Error('queue conflict'); return {}; }),
    prefetch: vi.fn(),
    consume: vi.fn(async (_q: string, cb: (msg: AmqpMessage | null) => void) => { onMsg = cb; return { consumerTag: 'ct-1' }; }),
    ack: vi.fn(),
    nack: vi.fn(),
    close: vi.fn(async () => undefined),
    on: vi.fn((event: 'error' | 'close', l: (err?: Error) => void) => { chListeners[event] = l; return channel; }),
    __emit: (msg) => { onMsg?.(msg); },
    __fire: (event, err) => { chListeners[event]?.(err); },
  };
  const connListeners: Record<string, (err?: Error) => void> = {};
  const connection: FakeConnection = {
    createChannel: vi.fn(async () => channel),
    close: vi.fn(async () => undefined),
    on: vi.fn((event: 'error' | 'close', l: (err?: Error) => void) => { connListeners[event] = l; return connection; }),
    channel,
    __fire: (event, err) => { connListeners[event]?.(err); },
  };
  return connection;
}

function wf(): Workflow {
  return { id: 'wf-r', tenantId: 'ten-1', name: 'r', enabled: true, nodes: [], edges: [] } as unknown as Workflow;
}
function node(config: Record<string, unknown> = {}): CanvasNode {
  return { id: 'n1', defId: 'trigger_rabbitmq', x: 0, y: 0,
    config: { url: 'amqp://guest:guest@rabbit.example.com:5672', queue: 'jobs', ...config } } as unknown as CanvasNode;
}
const msg = (s: string): AmqpMessage => ({ content: Buffer.from(s, 'utf8') });

let dispatchRun: ReturnType<typeof vi.fn>;
let conn: FakeConnection;
function deps(over: Partial<RabbitWatcherDeps> = {}): RabbitWatcherDeps {
  return { dispatchRun, connect: async () => conn, ...over };
}
/** Attende i microtask pendenti (connect() è async). */
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

beforeEach(() => {
  vi.clearAllMocks();
  dispatchRun = vi.fn(async () => ({ runId: 'run-1', status: 'completed', steps: [] }));
  conn = makeFakeConnection();
});
afterEach(() => { vi.useRealTimers(); });

describe('startRabbitWatcher — guard (nessun consumer)', () => {
  it('URL non amqp:// → null', () => {
    expect(startRabbitWatcher(wf(), node({ url: 'http://x' }), deps())).toBeNull();
  });
  it('queue mancante → null', () => {
    expect(startRabbitWatcher(wf(), node({ queue: '' }), deps())).toBeNull();
  });
  it('host privato (SSRF) senza allowlist → null', () => {
    expect(startRabbitWatcher(wf(), node({ url: 'amqp://guest@127.0.0.1:5672' }), deps())).toBeNull();
  });
});

describe('startRabbitWatcher — consegna manual-ack (AT-LEAST-ONCE)', () => {
  it('happy path: messaggio → dispatchRun(triggerType rabbitmq, data parsato) → ACK', async () => {
    const job = startRabbitWatcher(wf(), node(), deps())!;
    await flush();
    conn.channel.__emit(msg('{"orderId":7}'));
    await flush();
    expect(dispatchRun).toHaveBeenCalledTimes(1);
    const arg = dispatchRun.mock.calls[0]![0] as { triggerType: string; triggerInput: { data: unknown; raw: string } };
    expect(arg.triggerType).toBe('rabbitmq');
    expect(arg.triggerInput.data).toEqual({ orderId: 7 });
    expect(arg.triggerInput.raw).toBe('{"orderId":7}');
    expect(conn.channel.ack).toHaveBeenCalledTimes(1);
    expect(conn.channel.nack).not.toHaveBeenCalled();
    teardownRabbitWatcher(job);
  });

  it('🚨 run FALLITO → NACK con requeue (mai ACK): il messaggio non si perde', async () => {
    dispatchRun.mockRejectedValue(new Error('engine down'));
    const job = startRabbitWatcher(wf(), node(), deps())!;
    await flush();
    conn.channel.__emit(msg('{"x":1}'));
    await flush();
    expect(conn.channel.ack).not.toHaveBeenCalled();
    expect(conn.channel.nack).toHaveBeenCalledWith(expect.anything(), false, true); // requeue=true
    teardownRabbitWatcher(job);
  });

  it('consume è aperto in noAck=false (manual)', async () => {
    const job = startRabbitWatcher(wf(), node(), deps())!;
    await flush();
    expect(conn.channel.consume).toHaveBeenCalledWith('jobs', expect.any(Function), { noAck: false });
    teardownRabbitWatcher(job);
  });
});

describe('startRabbitWatcher — auto-ack (AT-MOST-ONCE)', () => {
  it('ackMode=auto → consume noAck=true, nessun ack/nack applicativo anche su run fallito', async () => {
    dispatchRun.mockRejectedValue(new Error('boom'));
    const job = startRabbitWatcher(wf(), node({ ackMode: 'auto' }), deps())!;
    await flush();
    expect(conn.channel.consume).toHaveBeenCalledWith('jobs', expect.any(Function), { noAck: true });
    conn.channel.__emit(msg('{"x":1}'));
    await flush();
    expect(conn.channel.ack).not.toHaveBeenCalled();
    expect(conn.channel.nack).not.toHaveBeenCalled();
    teardownRabbitWatcher(job);
  });
});

describe('startRabbitWatcher — filtro pointer + parsing', () => {
  it('pointer no-match (manual) → ACK senza dispatch (consumato, non è un errore)', async () => {
    const job = startRabbitWatcher(wf(), node({ messagePointer: '/type' }), deps())!;
    await flush();
    conn.channel.__emit(msg('{"other":1}'));
    await flush();
    expect(dispatchRun).not.toHaveBeenCalled();
    expect(conn.channel.ack).toHaveBeenCalledTimes(1);
    teardownRabbitWatcher(job);
  });
  it('pointer match → dispatch con "matched"', async () => {
    const job = startRabbitWatcher(wf(), node({ messagePointer: '/type' }), deps())!;
    await flush();
    conn.channel.__emit(msg('{"type":"created"}'));
    await flush();
    expect(dispatchRun).toHaveBeenCalledTimes(1);
    expect((dispatchRun.mock.calls[0]![0] as { triggerInput: { matched: unknown } }).triggerInput.matched).toBe('created');
    teardownRabbitWatcher(job);
  });
  it('jsonParse=false → data resta la stringa grezza', async () => {
    const job = startRabbitWatcher(wf(), node({ jsonParse: 'false' }), deps())!;
    await flush();
    conn.channel.__emit(msg('{"a":1}'));
    await flush();
    expect((dispatchRun.mock.calls[0]![0] as { triggerInput: { data: unknown } }).triggerInput.data).toBe('{"a":1}');
    teardownRabbitWatcher(job);
  });
  it('JSON malformato con jsonParse on → fallback alla stringa (no throw)', async () => {
    const job = startRabbitWatcher(wf(), node(), deps())!;
    await flush();
    conn.channel.__emit(msg('{rotto'));
    await flush();
    expect((dispatchRun.mock.calls[0]![0] as { triggerInput: { data: unknown } }).triggerInput.data).toBe('{rotto');
    teardownRabbitWatcher(job);
  });
  it('msg null (consumer cancellato dal broker) → nessun dispatch, nessun crash', async () => {
    const job = startRabbitWatcher(wf(), node(), deps())!;
    await flush();
    conn.channel.__emit(null);
    await flush();
    expect(dispatchRun).not.toHaveBeenCalled();
    teardownRabbitWatcher(job);
  });
});

describe('startRabbitWatcher — anti-flood', () => {
  it('oltre budget/sec → messaggio scartato + NACK requeue (manual), clock controllato', async () => {
    let t = 1_000_000;
    const job = startRabbitWatcher(wf(), node({ maxMessagesPerSec: 2 }), deps({ now: () => t }))!;
    await flush();
    conn.channel.__emit(msg('{"i":1}'));
    conn.channel.__emit(msg('{"i":2}'));
    conn.channel.__emit(msg('{"i":3}')); // oltre budget nello stesso secondo
    await flush();
    expect(dispatchRun).toHaveBeenCalledTimes(2);
    expect(conn.channel.nack).toHaveBeenCalledTimes(1); // il 3° droppato → nack requeue
    // Avanza oltre la finestra: il budget si libera.
    t += 1_100;
    conn.channel.__emit(msg('{"i":4}'));
    await flush();
    expect(dispatchRun).toHaveBeenCalledTimes(3);
    teardownRabbitWatcher(job);
  });
});

describe('startRabbitWatcher — resilienza (reconnect/backoff/teardown)', () => {
  it('connection close → reconnect schedulato con backoff esponenziale, reset su consume', async () => {
    vi.useFakeTimers();
    const conn1 = makeFakeConnection();
    const conn2 = makeFakeConnection();
    let n = 0;
    const connect = vi.fn(async () => (n++ === 0 ? conn1 : conn2));
    const job = startRabbitWatcher(wf(), node(), deps({ connect }))!;
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(1);
    // Drop della connessione → schedule reconnect a backoff iniziale.
    conn1.__fire('close');
    await vi.advanceTimersByTimeAsync(RABBIT_BACKOFF_INITIAL_MS);
    expect(connect).toHaveBeenCalledTimes(2);
    // La 2ª connessione ha ri-consumato → backoff resettato (consume avviato).
    expect(conn2.channel.consume).toHaveBeenCalledTimes(1);
    teardownRabbitWatcher(job);
    vi.useRealTimers();
  });

  it('connect FALLITO → reconnect schedulato (non muore)', async () => {
    vi.useFakeTimers();
    let n = 0;
    const good = makeFakeConnection();
    const connect = vi.fn(async () => { if (n++ === 0) throw new Error('ECONNREFUSED'); return good; });
    const job = startRabbitWatcher(wf(), node(), deps({ connect }))!;
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RABBIT_BACKOFF_INITIAL_MS);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(good.channel.consume).toHaveBeenCalledTimes(1);
    teardownRabbitWatcher(job);
    vi.useRealTimers();
  });

  it('🚨 teardown idempotente: dopo close() un successivo drop NON riconnette', async () => {
    vi.useFakeTimers();
    const connect = vi.fn(async () => conn);
    const job = startRabbitWatcher(wf(), node(), deps({ connect }))!;
    await vi.advanceTimersByTimeAsync(0);
    teardownRabbitWatcher(job);
    expect(conn.close).toHaveBeenCalled();
    conn.__fire('close'); // arriva DOPO il teardown
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(1); // MAI riconnesso
    vi.useRealTimers();
  });

  it('reconnect=false → alla chiusura NON riconnette', async () => {
    vi.useFakeTimers();
    const connect = vi.fn(async () => conn);
    const job = startRabbitWatcher(wf(), node({ reconnect: 'false' }), deps({ connect }))!;
    await vi.advanceTimersByTimeAsync(0);
    conn.__fire('close');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(1);
    teardownRabbitWatcher(job);
    vi.useRealTimers();
  });
});

describe('teardownRabbitWatcher — idempotenza', () => {
  it('doppio teardown non lancia', async () => {
    const job = startRabbitWatcher(wf(), node(), deps())!;
    await flush();
    expect(() => { teardownRabbitWatcher(job); teardownRabbitWatcher(job); }).not.toThrow();
    expect(logger).toBeDefined();
  });
});
