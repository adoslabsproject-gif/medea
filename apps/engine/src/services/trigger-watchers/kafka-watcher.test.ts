/**
 * kafka-watcher — bug-bounty + contract. Nessun broker reale: il client Kafka è
 * un fake iniettato via `deps.createClient`, timer e clock controllati.
 *
 * Contract pinnati (mutation-verify sulla semantica offset/resilienza):
 *   • AT-LEAST-ONCE: run riuscito → eachMessage RITORNA (offset committato);
 *     run fallito → eachMessage THROW (offset NON committato → re-consumo);
 *   • filtro no-match + anti-flood → ritorna (commit): niente re-consumo infinito;
 *   • crash del consumer → reconnect con backoff esponenziale + reset su run;
 *   • connect fallito → reconnect; teardown idempotente (closing → mai più);
 *   • guard: brokers/topic mancanti → null; SASL parsato solo se completo.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  startKafkaWatcher,
  teardownKafkaWatcher,
  KAFKA_BACKOFF_INITIAL_MS,
  type KafkaClientLike,
  type KafkaClientConfig,
  type KafkaConsumerLike,
  type EachMessagePayload,
} from './kafka-watcher.js';
import type { CanvasNode, Workflow } from '@medea/engine-core-schema';

vi.mock('@/lib/logger.js');

// ── Fake Kafka: cattura eachMessage + i listener 'consumer.crash' ──
interface FakeConsumer extends KafkaConsumerLike {
  __deliver(payload: EachMessagePayload): Promise<void>;
  __crash(): void;
  connect: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}
interface FakeClient extends KafkaClientLike {
  consumerInstance: FakeConsumer;
  consumer: ReturnType<typeof vi.fn>;
}

function makeFakeClient(opts: { connectThrows?: boolean } = {}): FakeClient {
  let each: ((p: EachMessagePayload) => Promise<void>) | null = null;
  const listeners: Record<string, (evt?: unknown) => void> = {};
  const consumer: FakeConsumer = {
    connect: vi.fn(async () => {
      if (opts.connectThrows) throw new Error('ECONNREFUSED broker');
    }),
    subscribe: vi.fn(async () => undefined),
    run: vi.fn(
      async ({ eachMessage }: { eachMessage: (p: EachMessagePayload) => Promise<void> }) => {
        each = eachMessage;
      },
    ),
    disconnect: vi.fn(async () => undefined),
    on: vi.fn((event: string, l: (evt?: unknown) => void) => {
      listeners[event] = l;
    }),
    __deliver: (p) => {
      if (!each) throw new Error('run() non ancora chiamato');
      return each(p);
    },
    __crash: () => {
      listeners['consumer.crash']?.();
    },
  };
  const client: FakeClient = {
    consumer: vi.fn(() => consumer),
    consumerInstance: consumer,
  };
  return client;
}

function wf(): Workflow {
  return {
    id: 'wf-k',
    tenantId: 'ten-1',
    name: 'k',
    enabled: true,
    nodes: [],
    edges: [],
  } as unknown as Workflow;
}
function node(config: Record<string, unknown> = {}): CanvasNode {
  return {
    id: 'n1',
    defId: 'trigger_kafka',
    x: 0,
    y: 0,
    config: {
      brokers: 'kafka1.example.com:9092,kafka2.example.com:9092',
      topic: 'orders',
      ...config,
    },
  } as unknown as CanvasNode;
}
const payload = (s: string | null, over: Partial<EachMessagePayload> = {}): EachMessagePayload => ({
  topic: 'orders',
  partition: 0,
  message: { value: s === null ? null : Buffer.from(s, 'utf8') },
  ...over,
});

let dispatchRun: ReturnType<typeof vi.fn>;
let client: FakeClient;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  dispatchRun = vi.fn(async () => ({ runId: 'run-1', status: 'completed', steps: [] }));
  client = makeFakeClient();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('startKafkaWatcher — guard', () => {
  it('brokers mancanti → null', () => {
    expect(
      startKafkaWatcher(wf(), node({ brokers: '' }), { dispatchRun, createClient: () => client }),
    ).toBeNull();
  });
  it('topic mancante → null', () => {
    expect(
      startKafkaWatcher(wf(), node({ topic: '' }), { dispatchRun, createClient: () => client }),
    ).toBeNull();
  });
  it('groupId default = flowforge-<wfId> se non specificato', async () => {
    const job = startKafkaWatcher(wf(), node(), { dispatchRun, createClient: () => client })!;
    await flush();
    expect(client.consumer).toHaveBeenCalledWith({ groupId: 'flowforge-wf-k' });
    teardownKafkaWatcher(job);
  });
});

describe('startKafkaWatcher — consumo + connessione', () => {
  it('connect → subscribe(topic, fromBeginning) → run', async () => {
    const job = startKafkaWatcher(wf(), node({ fromBeginning: 'true' }), {
      dispatchRun,
      createClient: () => client,
    })!;
    await flush();
    expect(client.consumerInstance.connect).toHaveBeenCalledTimes(1);
    expect(client.consumerInstance.subscribe).toHaveBeenCalledWith({
      topic: 'orders',
      fromBeginning: true,
    });
    expect(client.consumerInstance.run).toHaveBeenCalledTimes(1);
    teardownKafkaWatcher(job);
  });

  it('messaggio → dispatchRun(triggerType kafka, data + topic + partition)', async () => {
    const job = startKafkaWatcher(wf(), node(), { dispatchRun, createClient: () => client })!;
    await flush();
    await client.consumerInstance.__deliver(payload('{"id":9}', { partition: 3 }));
    expect(dispatchRun).toHaveBeenCalledTimes(1);
    const arg = dispatchRun.mock.calls[0]![0] as {
      triggerType: string;
      triggerInput: { data: unknown; topic: string; partition: number };
    };
    expect(arg.triggerType).toBe('kafka');
    expect(arg.triggerInput.data).toEqual({ id: 9 });
    expect(arg.triggerInput.topic).toBe('orders');
    expect(arg.triggerInput.partition).toBe(3);
    teardownKafkaWatcher(job);
  });
});

describe('startKafkaWatcher — AT-LEAST-ONCE via offset', () => {
  it('🚨 run riuscito → eachMessage RITORNA (offset committato, nessun throw)', async () => {
    const job = startKafkaWatcher(wf(), node(), { dispatchRun, createClient: () => client })!;
    await flush();
    await expect(client.consumerInstance.__deliver(payload('{"x":1}'))).resolves.toBeUndefined();
    teardownKafkaWatcher(job);
  });

  it('🚨 run FALLITO → eachMessage THROW (offset NON committato → re-consumo)', async () => {
    dispatchRun.mockRejectedValue(new Error('engine down'));
    const job = startKafkaWatcher(wf(), node(), { dispatchRun, createClient: () => client })!;
    await flush();
    await expect(client.consumerInstance.__deliver(payload('{"x":1}'))).rejects.toThrow(
      /kafka run failed/,
    );
    teardownKafkaWatcher(job);
  });

  it('value null (tombstone) → ritorna senza dispatch (commit, avanza)', async () => {
    const job = startKafkaWatcher(wf(), node(), { dispatchRun, createClient: () => client })!;
    await flush();
    await expect(client.consumerInstance.__deliver(payload(null))).resolves.toBeUndefined();
    expect(dispatchRun).not.toHaveBeenCalled();
    teardownKafkaWatcher(job);
  });
});

describe('startKafkaWatcher — filtro + parsing', () => {
  it('pointer no-match → RITORNA (commit) senza dispatch né throw', async () => {
    const job = startKafkaWatcher(wf(), node({ messagePointer: '/type' }), {
      dispatchRun,
      createClient: () => client,
    })!;
    await flush();
    await expect(
      client.consumerInstance.__deliver(payload('{"other":1}')),
    ).resolves.toBeUndefined();
    expect(dispatchRun).not.toHaveBeenCalled();
    teardownKafkaWatcher(job);
  });
  it('pointer match → dispatch con "matched"', async () => {
    const job = startKafkaWatcher(wf(), node({ messagePointer: '/type' }), {
      dispatchRun,
      createClient: () => client,
    })!;
    await flush();
    await client.consumerInstance.__deliver(payload('{"type":"created"}'));
    expect(
      (dispatchRun.mock.calls[0]![0] as { triggerInput: { matched: unknown } }).triggerInput
        .matched,
    ).toBe('created');
    teardownKafkaWatcher(job);
  });
  it('jsonParse=false → data resta stringa grezza', async () => {
    const job = startKafkaWatcher(wf(), node({ jsonParse: 'false' }), {
      dispatchRun,
      createClient: () => client,
    })!;
    await flush();
    await client.consumerInstance.__deliver(payload('{"a":1}'));
    expect(
      (dispatchRun.mock.calls[0]![0] as { triggerInput: { data: unknown } }).triggerInput.data,
    ).toBe('{"a":1}');
    teardownKafkaWatcher(job);
  });
});

describe('startKafkaWatcher — anti-flood', () => {
  it('oltre budget → RITORNA (commit) + niente dispatch; il budget si libera dopo 1s', async () => {
    let t = 1_000_000;
    const job = startKafkaWatcher(wf(), node({ maxMessagesPerSec: 2 }), {
      dispatchRun,
      createClient: () => client,
      now: () => t,
    })!;
    await flush();
    await client.consumerInstance.__deliver(payload('{"i":1}'));
    await client.consumerInstance.__deliver(payload('{"i":2}'));
    await expect(client.consumerInstance.__deliver(payload('{"i":3}'))).resolves.toBeUndefined(); // droppato ma commit
    expect(dispatchRun).toHaveBeenCalledTimes(2);
    t += 1_100;
    await client.consumerInstance.__deliver(payload('{"i":4}'));
    expect(dispatchRun).toHaveBeenCalledTimes(3);
    teardownKafkaWatcher(job);
  });
});

describe('startKafkaWatcher — SASL/TLS', () => {
  it('SASL passato al client SOLO se mechanism+username presenti', async () => {
    const factory = vi.fn(() => client);
    const job = startKafkaWatcher(
      wf(),
      node({ ssl: 'true', saslMechanism: 'scram-sha-256', saslUsername: 'u', saslPassword: 'p' }),
      { dispatchRun, createClient: factory },
    )!;
    await flush();
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        ssl: true,
        sasl: { mechanism: 'scram-sha-256', username: 'u', password: 'p' },
      }),
    );
    teardownKafkaWatcher(job);
  });
  it('SASL mechanism=none o username vuoto → nessun sasl nel config', async () => {
    const factory = vi.fn((_config: KafkaClientConfig) => client);
    const job = startKafkaWatcher(wf(), node({ saslMechanism: 'none' }), {
      dispatchRun,
      createClient: factory,
    })!;
    await flush();
    expect(factory.mock.calls[0]![0].sasl).toBeUndefined();
    teardownKafkaWatcher(job);
  });
});

describe('startKafkaWatcher — resilienza (crash/backoff/teardown)', () => {
  it('crash del consumer → reconnect con backoff, nuovo consumer connesso', async () => {
    vi.useFakeTimers();
    const c1 = makeFakeClient();
    const c2 = makeFakeClient();
    let n = 0;
    const factory = vi.fn(() => (n++ === 0 ? c1 : c2));
    const job = startKafkaWatcher(wf(), node(), { dispatchRun, createClient: factory })!;
    await vi.advanceTimersByTimeAsync(0);
    expect(factory).toHaveBeenCalledTimes(1);
    c1.consumerInstance.__crash();
    await vi.advanceTimersByTimeAsync(KAFKA_BACKOFF_INITIAL_MS);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(c2.consumerInstance.run).toHaveBeenCalledTimes(1);
    teardownKafkaWatcher(job);
    vi.useRealTimers();
  });

  it('connect FALLITO → reconnect schedulato (non muore)', async () => {
    vi.useFakeTimers();
    const bad = makeFakeClient({ connectThrows: true });
    const good = makeFakeClient();
    let n = 0;
    const factory = vi.fn(() => (n++ === 0 ? bad : good));
    const job = startKafkaWatcher(wf(), node(), { dispatchRun, createClient: factory })!;
    await vi.advanceTimersByTimeAsync(0);
    expect(factory).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(KAFKA_BACKOFF_INITIAL_MS);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(good.consumerInstance.run).toHaveBeenCalledTimes(1);
    teardownKafkaWatcher(job);
    vi.useRealTimers();
  });

  it('🚨 teardown idempotente: dopo disconnect un crash NON riconnette', async () => {
    vi.useFakeTimers();
    const factory = vi.fn(() => client);
    const job = startKafkaWatcher(wf(), node(), { dispatchRun, createClient: factory })!;
    await vi.advanceTimersByTimeAsync(0);
    teardownKafkaWatcher(job);
    expect(client.consumerInstance.disconnect).toHaveBeenCalled();
    client.consumerInstance.__crash(); // dopo il teardown
    await vi.advanceTimersByTimeAsync(60_000);
    expect(factory).toHaveBeenCalledTimes(1); // MAI riconnesso
    vi.useRealTimers();
  });

  it('reconnect=false → dopo crash NON riconnette', async () => {
    vi.useFakeTimers();
    const factory = vi.fn(() => client);
    const job = startKafkaWatcher(wf(), node({ reconnect: 'false' }), {
      dispatchRun,
      createClient: factory,
    })!;
    await vi.advanceTimersByTimeAsync(0);
    client.consumerInstance.__crash();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(factory).toHaveBeenCalledTimes(1);
    teardownKafkaWatcher(job);
    vi.useRealTimers();
  });

  it('doppio teardown non lancia', async () => {
    const job = startKafkaWatcher(wf(), node(), { dispatchRun, createClient: () => client })!;
    await flush();
    expect(() => {
      teardownKafkaWatcher(job);
      teardownKafkaWatcher(job);
    }).not.toThrow();
  });
});
