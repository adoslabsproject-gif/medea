/**
 * AUDIT FIX WE-2 (2026-06-09 CRITICAL) — REGRESSION GUARD:
 *
 * Invariante:
 *   "runWithRetry NON deve retryare NodeError con retryable=false."
 *
 * Pre-fix bug:
 *   Il loop catchava qualsiasi error → `attempt++` indipendentemente da
 *   `err.retryable`. ValidationError/AuthError/ConfigError/AbortedError/
 *   QuotaExceededError/IdempotencyConflictError/CircuitOpenError venivano
 *   ritentati fino a `retryCount` volte. Conseguenze reali in prod:
 *     - AuthError × 10 → provider esterno banna l'account tenant (es. Stripe
 *       5 401 in 1min triggera review fraud).
 *     - QuotaError × 10 → moltiplica utilizzo durante cooldown già esaurito.
 *     - AbortedError × 10 → user clicca STOP, engine continua per 30s.
 *
 * Post-fix: per-error-class branch verifica che lo specific NodeError
 * subclass termini IMMEDIATAMENTE (attempt non incrementa, exec chiamato
 * esattamente 1 volta).
 *
 * NB: usa l'export `__forTestRunWithRetry`. Mock minimo del logger.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/logger.js');
vi.mock('@/executors/registry.js', () => ({ resolveServerExecutor: vi.fn() }));

import { __forTestRunWithRetry } from './node-executor.strategy.js';
import type { DispatchContext, NodeExecutionContext } from './types.js';
import {
  ValidationError,
  AuthError,
  ConfigError,
  AbortedError,
  CircuitOpenError,
  IdempotencyConflictError,
  HttpError,
  NetworkError,
  TimeoutError,
  NodeError,
} from '@medea/engine-nodes-stdlib';

function makeCtx(retryCount = 5): DispatchContext {
  return {
    node: {
      id: 'n1',
      defId: 'test-node',
      config: { retryCount, retryDelayMs: 0 },
    },
    interpolatedConfig: {},
    carriedInput: { x: 1 },
    module: { def: { label: 'Test' } },
  } as unknown as DispatchContext;
}
const emptyExecCtx = {} as NodeExecutionContext;

describe('🚨 [REGRESSION WE-2] runWithRetry rispetta retryable=false', () => {
  it('🚨 ValidationError (retryable=false) → exec chiamato 1 volta SOLA, throw immediato', async () => {
    let calls = 0;
    const exec = vi.fn(async () => {
      calls += 1;
      throw new ValidationError('campo X mancante');
    });
    await expect(__forTestRunWithRetry(makeCtx(5), exec, emptyExecCtx)).rejects.toThrow(/campo X/);
    expect(calls).toBe(1);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('🚨 AuthError (retryable=false) → 1 sola chiamata (evita ban provider)', async () => {
    let calls = 0;
    const exec = vi.fn(async () => {
      calls += 1;
      throw new AuthError({ reason: 'token scaduto' });
    });
    await expect(__forTestRunWithRetry(makeCtx(10), exec, emptyExecCtx)).rejects.toThrow(
      /token scaduto/,
    );
    expect(calls).toBe(1);
  });

  it('🚨 ConfigError (retryable=false) → 1 sola chiamata', async () => {
    let calls = 0;
    const exec = vi.fn(async () => {
      calls += 1;
      throw new ConfigError('config invalida');
    });
    await expect(__forTestRunWithRetry(makeCtx(3), exec, emptyExecCtx)).rejects.toThrow(
      /config invalida/,
    );
    expect(calls).toBe(1);
  });

  it('🚨 AbortedError → 1 sola chiamata (user STOP rispettato)', async () => {
    let calls = 0;
    const exec = vi.fn(async () => {
      calls += 1;
      throw new AbortedError('user cancelled');
    });
    await expect(__forTestRunWithRetry(makeCtx(5), exec, emptyExecCtx)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('🚨 CircuitOpenError → 1 sola chiamata (breaker rispettato)', async () => {
    let calls = 0;
    const exec = vi.fn(async () => {
      calls += 1;
      throw new CircuitOpenError({
        breakerName: 'host:api.example.com',
        nextProbeAt: Date.now() + 60_000,
      });
    });
    await expect(__forTestRunWithRetry(makeCtx(5), exec, emptyExecCtx)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('🚨 IdempotencyConflictError → 1 sola chiamata (no race amplification)', async () => {
    let calls = 0;
    const exec = vi.fn(async () => {
      calls += 1;
      throw new IdempotencyConflictError({ key: 'key in-flight', previousAt: Date.now() });
    });
    await expect(__forTestRunWithRetry(makeCtx(5), exec, emptyExecCtx)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('🚨 HttpError 4xx (retryable=false) → 1 sola chiamata (no retry su business error)', async () => {
    let calls = 0;
    const exec = vi.fn(async () => {
      calls += 1;
      throw new HttpError({ status: 400, statusText: 'Bad Request', url: 'http://x' });
    });
    await expect(__forTestRunWithRetry(makeCtx(5), exec, emptyExecCtx)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  // CONTROLLO POSITIVO: errori retryable DEVONO essere ritentati.
  it('🚨 HttpError 503 (retryable=true) → retentato fino a retryCount+1 volte', async () => {
    let calls = 0;
    const exec = vi.fn(async () => {
      calls += 1;
      throw new HttpError({ status: 503, statusText: 'Service Unavailable', url: 'http://x' });
    });
    await expect(__forTestRunWithRetry(makeCtx(3), exec, emptyExecCtx)).rejects.toThrow();
    // retryCount=3 → tentativi totali = 1 iniziale + 3 retry = 4
    expect(calls).toBe(4);
  });

  it('🚨 NetworkError (retryable=true) → retentato', async () => {
    let calls = 0;
    const exec = vi.fn(async () => {
      calls += 1;
      throw new NetworkError('ECONNREFUSED');
    });
    await expect(__forTestRunWithRetry(makeCtx(2), exec, emptyExecCtx)).rejects.toThrow();
    expect(calls).toBe(3); // 1 + 2 retry
  });

  it('🚨 TimeoutError (retryable=true) → retentato', async () => {
    let calls = 0;
    const exec = vi.fn(async () => {
      calls += 1;
      throw new TimeoutError({ timeoutMs: 5000, url: 'http://x' });
    });
    await expect(__forTestRunWithRetry(makeCtx(2), exec, emptyExecCtx)).rejects.toThrow();
    expect(calls).toBe(3);
  });

  // PLAIN Error (no NodeError) → non-retryable per design (deterministic bug)
  it('🚨 plain TypeError (executor bug) → 1 sola chiamata (no retry su bug deterministico)', async () => {
    let calls = 0;
    const exec = vi.fn(async () => {
      calls += 1;
      throw new TypeError("Cannot read property 'x' of undefined");
    });
    await expect(__forTestRunWithRetry(makeCtx(5), exec, emptyExecCtx)).rejects.toThrow(
      /Cannot read/,
    );
    expect(calls).toBe(1);
  });

  // CONTROLLO: NodeError custom con retryable=true esplicito (forward compat).
  it('🚨 NodeError custom retryable=true → retentato', async () => {
    let calls = 0;
    const exec = vi.fn(async () => {
      calls += 1;
      throw new NodeError({ code: 'NETWORK_ERROR', message: 'custom transient', retryable: true });
    });
    await expect(__forTestRunWithRetry(makeCtx(2), exec, emptyExecCtx)).rejects.toThrow();
    expect(calls).toBe(3);
  });

  // SANITY: success al primo tentativo → 1 chiamata, no retry
  it('🚨 success → 1 chiamata, no retry', async () => {
    const exec = vi.fn(async () => ({ output: 'ok', durationMs: 0 }));
    const result = await __forTestRunWithRetry(makeCtx(5), exec, emptyExecCtx);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(result.retries).toBe(0);
    expect(result.output).toBe('ok');
  });

  it('🚨 success al 2° tentativo (1° fail transient) → retries=1', async () => {
    let attempts = 0;
    const exec = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new NetworkError('transient');
      return { output: 'ok-after-retry', durationMs: 0 };
    });
    const result = await __forTestRunWithRetry(makeCtx(3), exec, emptyExecCtx);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(result.retries).toBe(1);
    expect(result.output).toBe('ok-after-retry');
  });
});
