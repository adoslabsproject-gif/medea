/**
 * Test 2026-grade — telemetry-emitter.ts (D1 battle-testing).
 *
 * 🚨 PIPELINE-CRITICAL: ogni 30s POST batch ad portal /node-telemetry/ingest.
 *    Bug = telemetria silenziosamente persa → badge nodi non aggiornato.
 *
 * 🚨 FIRE-AND-FORGET: errors loggati ma NON bloccano run. Test 2 failure modes:
 *  - HTTP non-2xx: warn + buffer flushed comunque (no retry — best-effort)
 *  - fetch throw (network down): warn + no propagate
 *
 * 🚨 BUFFER LIMITS:
 *  - flush a 100 eventi (MAX_BUFFER)
 *  - flush a 30s (FLUSH_INTERVAL_MS)
 *  - whichever first
 *
 * 🚨 SKIP RULES:
 *  - defId in {note, sticky, logic_*} → skip
 *  - status !== success && !== error → skip (es. 'pending')
 *  - durationMs negativo → clamped 0
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '@/lib/logger.js';
import type { IEventBus } from '@/ports/event-bus.js';

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

const safeOutboundFetchMock = vi.fn();
vi.mock('@/lib/safe-outbound-fetch.js', () => ({
  safeOutboundFetch: safeOutboundFetchMock,
}));

/** Mock EventBus che esegue handler in sync per controllo deterministico */
function makeMockBus(): {
  bus: IEventBus;
  emit: (defId: string, status: string, extra?: Record<string, unknown>) => Promise<void>;
  subscriberCount: () => number;
} {
  let handler: ((event: { type: string; data: unknown }) => Promise<void>) | null = null;
  let count = 0;
  const bus = {
    subscribeTo: (_type: string, h: (e: { type: string; data: unknown }) => Promise<void>) => {
      handler = h;
      count++;
      return () => {
        handler = null;
        count--;
      };
    },
  } as unknown as IEventBus;
  return {
    bus,
    emit: async (defId: string, status: string, extra: Record<string, unknown> = {}) => {
      if (handler) {
        await handler({
          type: 'run.step',
          data: { step: { defId, status, durationMs: 100, ...extra } },
        });
      }
    },
    subscriberCount: () => count,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  // Reset env entrambi così test isolano
  delete process.env.PORTAL_CALLBACK_TOKEN;
  delete process.env.MEDEA_INTERNAL_TOKEN;
});

afterEach(() => {
  vi.clearAllMocks();
});

async function loadFresh() {
  return import('./telemetry-emitter.js');
}

describe('🚨 start() — guard token mancante', () => {
  it('🚨 nessun INTERNAL_TOKEN → warn + NO subscribe + NO timer', async () => {
    const { telemetryEmitter } = await loadFresh();
    const { bus, subscriberCount } = makeMockBus();
    telemetryEmitter.start(bus, 'tenant-x');
    expect(subscriberCount()).toBe(0);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/MEDEA_INTERNAL_TOKEN missing|telemetry disabled/u),
    );
    telemetryEmitter.stop(); // safe to call
  });

  it('🚨 PORTAL_CALLBACK_TOKEN presente → subscribe attiva', async () => {
    process.env.PORTAL_CALLBACK_TOKEN = 'callback-tok-A';
    const { telemetryEmitter } = await loadFresh();
    const { bus, subscriberCount } = makeMockBus();
    telemetryEmitter.start(bus, 'tenant-x');
    expect(subscriberCount()).toBe(1);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/emitter started/u),
    );
    telemetryEmitter.stop();
  });

  it('🚨 fallback MEDEA_INTERNAL_TOKEN se PORTAL_CALLBACK_TOKEN assente', async () => {
    process.env.MEDEA_INTERNAL_TOKEN = 'legacy-tok';
    const { telemetryEmitter } = await loadFresh();
    const { bus, subscriberCount } = makeMockBus();
    telemetryEmitter.start(bus, 'tenant-x');
    expect(subscriberCount()).toBe(1);
    telemetryEmitter.stop();
  });

  it('🚨 PORTAL_CALLBACK_TOKEN HA PRIORITÀ su MEDEA_INTERNAL_TOKEN', async () => {
    process.env.PORTAL_CALLBACK_TOKEN = 'PRIORITY';
    process.env.MEDEA_INTERNAL_TOKEN = 'fallback';
    safeOutboundFetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { telemetryEmitter } = await loadFresh();
    const { bus, emit } = makeMockBus();
    telemetryEmitter.start(bus, 'tenant-x');
    await emit('action_http', 'success');
    telemetryEmitter.stop();
    await new Promise((r) => setImmediate(r)); // let flush settle
    expect(safeOutboundFetchMock).toHaveBeenCalled();
    const headers = (safeOutboundFetchMock.mock.calls[0]![1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers['X-Internal-Token']).toBe('PRIORITY');
  });

  it('🚨 start() chiamato 2x → idempotente (no double subscribe)', async () => {
    process.env.PORTAL_CALLBACK_TOKEN = 't';
    const { telemetryEmitter } = await loadFresh();
    const { bus, subscriberCount } = makeMockBus();
    telemetryEmitter.start(bus, 'tenant-x');
    telemetryEmitter.start(bus, 'tenant-x'); // 2nd
    expect(subscriberCount()).toBe(1); // NON 2
    telemetryEmitter.stop();
  });
});

describe('🚨 step handler — skip rules', () => {
  beforeEach(() => {
    process.env.PORTAL_CALLBACK_TOKEN = 't';
  });

  it('🚨 SKIP defId="note" / "sticky"', async () => {
    safeOutboundFetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { telemetryEmitter } = await loadFresh();
    const { bus, emit } = makeMockBus();
    telemetryEmitter.start(bus, 'tenant-x');
    await emit('note', 'success');
    await emit('sticky', 'success');
    telemetryEmitter.stop();
    await new Promise((r) => setImmediate(r));
    // Nessun evento → flush vuoto → no fetch
    expect(safeOutboundFetchMock).not.toHaveBeenCalled();
  });

  it('🚨 SKIP defId logic_* (if/switch/loop/merge/delay/subworkflow/wait/wait_signal)', async () => {
    safeOutboundFetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { telemetryEmitter } = await loadFresh();
    const { bus, emit } = makeMockBus();
    telemetryEmitter.start(bus, 'tenant-x');
    for (const defId of [
      'logic_if',
      'logic_switch',
      'logic_loop',
      'logic_merge',
      'logic_delay',
      'logic_subworkflow',
      'logic_wait',
      'logic_wait_signal',
    ]) {
      await emit(defId, 'success');
    }
    telemetryEmitter.stop();
    await new Promise((r) => setImmediate(r));
    expect(safeOutboundFetchMock).not.toHaveBeenCalled();
  });

  it('🚨 SKIP status NOT in {success, error} (es. pending/skipped)', async () => {
    safeOutboundFetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { telemetryEmitter } = await loadFresh();
    const { bus, emit } = makeMockBus();
    telemetryEmitter.start(bus, 'tenant-x');
    await emit('action_http', 'pending');
    await emit('action_http', 'skipped');
    await emit('action_http', 'running');
    telemetryEmitter.stop();
    await new Promise((r) => setImmediate(r));
    expect(safeOutboundFetchMock).not.toHaveBeenCalled();
  });

  it('🚨 SKIP defId mancante (step senza defId)', async () => {
    let handler: ((e: { type: string; data: unknown }) => Promise<void>) | null = null;
    const bus = {
      subscribeTo: (_t: string, h: typeof handler) => {
        handler = h;
        return () => {
          /* noop */
        };
      },
    } as unknown as IEventBus;
    const { telemetryEmitter } = await loadFresh();
    telemetryEmitter.start(bus, 'tenant-x');
    await handler!({ type: 'run.step', data: { step: { status: 'success' } } });
    await handler!({ type: 'run.step', data: {} });
    telemetryEmitter.stop();
    await new Promise((r) => setImmediate(r));
    expect(safeOutboundFetchMock).not.toHaveBeenCalled();
  });

  it('🚨 ACCEPT defId valid + status success → buffer e flush', async () => {
    safeOutboundFetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { telemetryEmitter } = await loadFresh();
    const { bus, emit } = makeMockBus();
    telemetryEmitter.start(bus, 'tenant-x');
    await emit('action_http', 'success');
    telemetryEmitter.stop();
    await new Promise((r) => setImmediate(r));
    expect(safeOutboundFetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (safeOutboundFetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      defId: 'action_http',
      success: true,
      tenantId: 'tenant-x',
    });
  });

  it('🚨 ACCEPT status error → success:false in payload', async () => {
    safeOutboundFetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { telemetryEmitter } = await loadFresh();
    const { bus, emit } = makeMockBus();
    telemetryEmitter.start(bus, 'tenant-x');
    await emit('action_db_insert', 'error', { error: 'NOT NULL violation' });
    telemetryEmitter.stop();
    await new Promise((r) => setImmediate(r));
    const body = JSON.parse(
      (safeOutboundFetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.events[0].success).toBe(false);
    expect(body.events[0].errorMsg).toBe('NOT NULL violation');
  });
});

describe('🚨 durationMs sanitization', () => {
  beforeEach(() => {
    process.env.PORTAL_CALLBACK_TOKEN = 't';
  });

  it('🚨 durationMs negativo → clamped a 0 (NO valori sotto zero in metrics)', async () => {
    safeOutboundFetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { telemetryEmitter } = await loadFresh();
    const { bus, emit } = makeMockBus();
    telemetryEmitter.start(bus, 'tenant-x');
    await emit('action_http', 'success', { durationMs: -50 });
    telemetryEmitter.stop();
    await new Promise((r) => setImmediate(r));
    const body = JSON.parse(
      (safeOutboundFetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.events[0].durationMs).toBe(0);
  });

  it('🚨 durationMs non-numero → 0 default', async () => {
    safeOutboundFetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { telemetryEmitter } = await loadFresh();
    const { bus, emit } = makeMockBus();
    telemetryEmitter.start(bus, 'tenant-x');
    await emit('action_http', 'success', { durationMs: 'wow' });
    telemetryEmitter.stop();
    await new Promise((r) => setImmediate(r));
    const body = JSON.parse(
      (safeOutboundFetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.events[0].durationMs).toBe(0);
  });

  it('🚨 durationMs valido preserved', async () => {
    safeOutboundFetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { telemetryEmitter } = await loadFresh();
    const { bus, emit } = makeMockBus();
    telemetryEmitter.start(bus, 'tenant-x');
    await emit('action_http', 'success', { durationMs: 1234 });
    telemetryEmitter.stop();
    await new Promise((r) => setImmediate(r));
    const body = JSON.parse(
      (safeOutboundFetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.events[0].durationMs).toBe(1234);
  });
});

describe('🚨 flush — HTTP + failure modes', () => {
  beforeEach(() => {
    process.env.PORTAL_CALLBACK_TOKEN = 't';
  });

  it('🚨 happy: POST a /api/v1/internal/node-telemetry/ingest', async () => {
    safeOutboundFetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { telemetryEmitter } = await loadFresh();
    const { bus, emit } = makeMockBus();
    telemetryEmitter.start(bus, 'tenant-x');
    await emit('action_http', 'success');
    telemetryEmitter.stop();
    await new Promise((r) => setImmediate(r));
    const url = String(safeOutboundFetchMock.mock.calls[0]![0]);
    expect(url).toMatch(/\/api\/v1\/internal\/node-telemetry\/ingest$/u);
    const opts = safeOutboundFetchMock.mock.calls[0]![1] as RequestInit;
    expect(opts.method).toBe('POST');
    expect((opts.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('🚨 HTTP non-200 → warn (NO throw)', async () => {
    safeOutboundFetchMock.mockResolvedValue({ ok: false, status: 502 });
    const { telemetryEmitter } = await loadFresh();
    const { bus, emit } = makeMockBus();
    telemetryEmitter.start(bus, 'tenant-x');
    await emit('action_http', 'success');
    telemetryEmitter.stop();
    await new Promise((r) => setImmediate(r));
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 502, count: 1 }),
      expect.stringMatching(/portal ingest non-200/u),
    );
  });

  it('🚨 fetch throw (network down) → warn (fire-forget, NO throw)', async () => {
    safeOutboundFetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const { telemetryEmitter } = await loadFresh();
    const { bus, emit } = makeMockBus();
    telemetryEmitter.start(bus, 'tenant-x');
    await emit('action_http', 'success');
    telemetryEmitter.stop();
    await new Promise((r) => setImmediate(r));
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'ECONNREFUSED' }),
      expect.stringMatching(/flush failed/u),
    );
  });

  it('🚨 stop() flusha eventi residui (no lost data on graceful shutdown)', async () => {
    safeOutboundFetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { telemetryEmitter } = await loadFresh();
    const { bus, emit } = makeMockBus();
    telemetryEmitter.start(bus, 'tenant-x');
    await emit('action_a', 'success');
    await emit('action_b', 'success');
    telemetryEmitter.stop();
    await new Promise((r) => setImmediate(r));
    expect(safeOutboundFetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (safeOutboundFetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.events).toHaveLength(2);
  });

  it('🚨 buffer vuoto → flush noop (NO fetch waste)', async () => {
    safeOutboundFetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { telemetryEmitter } = await loadFresh();
    const { bus } = makeMockBus();
    telemetryEmitter.start(bus, 'tenant-x');
    telemetryEmitter.stop();
    await new Promise((r) => setImmediate(r));
    expect(safeOutboundFetchMock).not.toHaveBeenCalled();
  });

  it('🚨 100 eventi → auto-flush (MAX_BUFFER guard)', async () => {
    safeOutboundFetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { telemetryEmitter } = await loadFresh();
    const { bus, emit } = makeMockBus();
    telemetryEmitter.start(bus, 'tenant-x');
    for (let i = 0; i < 100; i++) {
      await emit('action_x', 'success');
    }
    // Auto-flush at 100 SENZA stop()
    await new Promise((r) => setImmediate(r));
    expect(safeOutboundFetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (safeOutboundFetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.events).toHaveLength(100);
    telemetryEmitter.stop();
  });

  it('🚨 99 eventi → NON flusha (sotto soglia)', async () => {
    safeOutboundFetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { telemetryEmitter } = await loadFresh();
    const { bus, emit } = makeMockBus();
    telemetryEmitter.start(bus, 'tenant-x');
    for (let i = 0; i < 99; i++) {
      await emit('action_x', 'success');
    }
    await new Promise((r) => setImmediate(r));
    // Solo flush manuale via stop() → conta 1 chiamata
    expect(safeOutboundFetchMock).not.toHaveBeenCalled();
    telemetryEmitter.stop();
    await new Promise((r) => setImmediate(r));
    expect(safeOutboundFetchMock).toHaveBeenCalledTimes(1);
  });

  it('🚨 abort timeout: signal scade dopo 10s (sanity)', async () => {
    safeOutboundFetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { telemetryEmitter } = await loadFresh();
    const { bus, emit } = makeMockBus();
    telemetryEmitter.start(bus, 'tenant-x');
    await emit('action_http', 'success');
    telemetryEmitter.stop();
    await new Promise((r) => setImmediate(r));
    const opts = safeOutboundFetchMock.mock.calls[0]![1] as RequestInit;
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });
});
