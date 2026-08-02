/**
 * GUARD anti-doppione retry (review nodi) — il retry è UN SOLO livello.
 *
 * Invariante: l'engine (runWithRetry) NON ri-ritenta un nodo self-managed (es. action_http
 * che ritenta internamente) → niente 3×3 annidato. L'utente può forzare via retryStrategy.
 *
 * Misura REALE: conta quante volte l'executor viene invocato dall'engine per ogni
 * combinazione (selfManagedRetry × retryStrategy). Un errore RETRYABLE (NetworkError)
 * massimizza i tentativi → se l'engine ri-ritenta quando non dovrebbe, il conteggio sale.
 * Mutation: rimuovere il gate engineRetriesNode → il caso self-managed/auto passa da
 * 1 a (1+retryCount) chiamate → ROSSO.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/logger.js');
vi.mock('@/executors/registry.js', () => ({ resolveServerExecutor: vi.fn() }));

import { __forTestRunWithRetry } from './node-executor.strategy.js';
import type { DispatchContext, NodeExecutionContext } from './types.js';
import { NetworkError } from '@medea/engine-nodes-stdlib';

function makeCtx(opts: { selfManagedRetry?: boolean; retryStrategy?: string; retryCount?: number }): DispatchContext {
  return {
    node: {
      id: 'n1',
      defId: 'test-node',
      config: {
        retryCount: opts.retryCount ?? 3,
        retryDelayMs: 0,
        ...(opts.retryStrategy !== undefined ? { retryStrategy: opts.retryStrategy } : {}),
      },
    },
    interpolatedConfig: {},
    carriedInput: {},
    module: { def: { label: 'Test', ...(opts.selfManagedRetry !== undefined ? { selfManagedRetry: opts.selfManagedRetry } : {}) } },
  } as unknown as DispatchContext;
}
const execCtx = {} as NodeExecutionContext;

/** Conta le invocazioni dell'engine su un errore RETRYABLE (network). */
async function countEngineAttempts(ctx: DispatchContext): Promise<number> {
  let calls = 0;
  const exec = vi.fn(async () => {
    calls += 1;
    throw new NetworkError('ECONNRESET');
  });
  await expect(__forTestRunWithRetry(ctx, exec, execCtx)).rejects.toBeDefined();
  return calls;
}

describe('🚨 [GUARD anti-doppione] runWithRetry — un solo owner del retry', () => {
  it('🚨 nodo SELF-MANAGED + retryStrategy=auto → engine NON ritenta (1 sola chiamata, il nodo ritenta da sé)', async () => {
    expect(await countEngineAttempts(makeCtx({ selfManagedRetry: true, retryStrategy: 'auto', retryCount: 3 }))).toBe(1);
  });

  it('🚨 nodo SELF-MANAGED senza retryStrategy (default auto) → engine NON ritenta (1 chiamata)', async () => {
    expect(await countEngineAttempts(makeCtx({ selfManagedRetry: true, retryCount: 3 }))).toBe(1);
  });

  it('nodo NON self-managed (default) → engine ritenta normalmente (1 + retryCount = 4)', async () => {
    expect(await countEngineAttempts(makeCtx({ retryCount: 3 }))).toBe(4);
  });

  it('🚨 override retryStrategy=workflow su nodo self-managed → engine ritenta (4) — l\'utente sposta il retry al motore', async () => {
    expect(await countEngineAttempts(makeCtx({ selfManagedRetry: true, retryStrategy: 'workflow', retryCount: 3 }))).toBe(4);
  });

  it('🚨 retryStrategy=none → engine NON ritenta (1) anche su nodo NON self-managed', async () => {
    expect(await countEngineAttempts(makeCtx({ selfManagedRetry: false, retryStrategy: 'none', retryCount: 3 }))).toBe(1);
  });

  it('🚨 retryStrategy=node su nodo NON self-managed → engine NON ritenta (1) — il retry è "del nodo" (che però non lo fa → zero retry, niente engine)', async () => {
    expect(await countEngineAttempts(makeCtx({ selfManagedRetry: false, retryStrategy: 'node', retryCount: 3 }))).toBe(1);
  });
});
