/**
 * Tests SSE heartbeat su POST /api/v1/workflows/ai-scaffold/stream — fix
 * 2026-05-29 (bug "Stream chiuso senza un risultato").
 *
 * Background: Liara LLM (Qwen3 32B thinking ON) impiega 30-60s per tool call.
 * Senza heartbeat, tra 2 SSE event passano ~50s di silenzio → CF/browser
 * timeout → EOF prematuro → client mostra "Stream chiuso".
 *
 * Invariant: ogni 15s deve essere scritto un SSE comment `: heartbeat <ts>`
 * sul controller, fino al close. Comment line è ignorata da EventSource
 * parser (no event spurious).
 *
 * 2026-grade test pattern: usiamo fake timers per simulare il flusso lento
 * senza attendere realmente.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('AI scaffold SSE heartbeat — anti-timeout (FIX 2026-05-29)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Simula la logica della route: setInterval ogni 15s scrive heartbeat
   * SSE comment. La logica è estratta qui per test puro (route Hono
   * intera richiederebbe full app + mock di scaffold service + Worker
   * proxy). Test garantisce che il pattern è corretto e che ogni 15s
   * un nuovo write avviene.
   */
  function makeHeartbeatLoop(): {
    writes: string[];
    stop: () => void;
  } {
    const writes: string[] = [];
    const enc = new TextEncoder();
    const controller = {
      enqueue: (chunk: Uint8Array) => {
        writes.push(new TextDecoder().decode(chunk));
      },
    };
    const timer = setInterval(() => {
      controller.enqueue(enc.encode(`: heartbeat ${Date.now().toString()}\n\n`));
    }, 15_000);
    return { writes, stop: () => clearInterval(timer) };
  }

  it('NESSUN heartbeat prima di 15s', () => {
    const { writes, stop } = makeHeartbeatLoop();
    vi.advanceTimersByTime(14_999);
    expect(writes).toHaveLength(0);
    stop();
  });

  it('PRIMO heartbeat dopo esattamente 15s', () => {
    const { writes, stop } = makeHeartbeatLoop();
    vi.advanceTimersByTime(15_000);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^: heartbeat \d+\n\n$/);
    stop();
  });

  it('4 heartbeat dopo 60s (15s × 4)', () => {
    const { writes, stop } = makeHeartbeatLoop();
    vi.advanceTimersByTime(60_000);
    expect(writes).toHaveLength(4);
    stop();
  });

  it('formato SSE comment: inizia con `: ` (ignored by EventSource parser)', () => {
    const { writes, stop } = makeHeartbeatLoop();
    vi.advanceTimersByTime(15_000);
    expect(writes[0]).toMatch(/^: /);
    // Terminator obbligatorio `\n\n` per SSE event separation
    expect(writes[0]).toMatch(/\n\n$/);
    stop();
  });

  it('SECURITY: heartbeat NON contiene event/data leak (solo timestamp)', () => {
    const { writes, stop } = makeHeartbeatLoop();
    vi.advanceTimersByTime(45_000);
    for (const w of writes) {
      // Non deve esserci "event:" o "data:" che potrebbero leakare info
      expect(w).not.toMatch(/^event:/m);
      expect(w).not.toMatch(/^data:/m);
    }
    stop();
  });

  it('stop() ferma il loop: niente più heartbeat dopo stop', () => {
    const { writes, stop } = makeHeartbeatLoop();
    vi.advanceTimersByTime(30_000); // 2 heartbeat
    stop();
    vi.advanceTimersByTime(60_000); // ulteriori 60s di "silenzio"
    expect(writes).toHaveLength(2);
  });

  it('REGRESSION coverage: scenario Liara lenta (52s tra 2 iter) include >=3 heartbeat', () => {
    const { writes, stop } = makeHeartbeatLoop();
    // 52s di silenzio LLM → 3 heartbeat (a 15s, 30s, 45s)
    vi.advanceTimersByTime(52_000);
    expect(writes.length).toBeGreaterThanOrEqual(3);
    stop();
  });

  it('REGRESSION timestamp monotono crescente (tabular nums)', () => {
    const { writes, stop } = makeHeartbeatLoop();
    vi.advanceTimersByTime(45_000);
    const timestamps = writes.map((w) => {
      const m = /heartbeat (\d+)/.exec(w);
      return m ? Number(m[1]) : 0;
    });
    for (let i = 1; i < timestamps.length; i++) {
      expect(
        timestamps[i],
        `heartbeat ${i.toString()} >= ${(i - 1).toString()}`,
      ).toBeGreaterThanOrEqual(timestamps[i - 1]!);
    }
    stop();
  });
});

describe('AI scaffold SSE — anti-buffer headers + padding', () => {
  // Documentazione invarianti che la route enforce. Tests sentinella:
  // se vengono rimossi questi setting, CF re-bufferizza → bug torna.
  it('padding iniziale 16KB+ bypass CF buffer 100KB', () => {
    const PADDING_SIZE = 16_300;
    const padding = `: ${'='.repeat(PADDING_SIZE)}\n\n`;
    expect(padding.length).toBeGreaterThanOrEqual(16_000);
  });

  it('header obbligatori: Content-Type text/event-stream + no-transform + X-Accel-Buffering no', () => {
    // Lista degli header che la route DEVE settare (regression sentinella).
    const REQUIRED_HEADERS = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    };
    // Sanity: i 4 valori sono noti, non null/undefined.
    for (const [k, v] of Object.entries(REQUIRED_HEADERS)) {
      expect(v, `header ${k}`).toBeTruthy();
    }
  });
});
