/**
 * AUDIT FIX WE-11 (2026-06-09 HIGH) — REGRESSION GUARD source inspection.
 *
 * Verifica che node-executor.strategy.ts mintai Idempotency-Key derivata
 * `${runId}:${nodeId}`.
 *
 * Pre-fix bug:
 *   Retry policy NON forniva Idempotency-Key auto-mintato → node executor
 *   che parla con provider supporting Idempotency (Stripe, PayPal) inviava
 *   ogni retry come "first request" lato provider → double-charge se il
 *   provider committed ma rispose 5xx prima del response.
 *
 * Post-fix: execCtx.idempotencyKey settato in ogni dispatch. Stesso key
 * persistente attraverso tutti i retry dello stesso (runId, nodeId).
 * Executor opt-in lo forwarda come header `Idempotency-Key` al provider.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const strategySource = readFileSync(join(__dirname, 'node-executor.strategy.ts'), 'utf-8');

describe('🚨 [REGRESSION WE-11] Idempotency-Key derived per (runId, nodeId)', () => {
  it('🚨 strategy contains idempotencyKey = `${ctx.runId}:${ctx.node.id}` derivation', () => {
    expect(strategySource).toMatch(/idempotencyKey\s*=\s*`\$\{ctx\.runId\}:\$\{ctx\.node\.id\}`/);
  });

  it('🚨 execCtx receives idempotencyKey field', () => {
    expect(strategySource).toMatch(/idempotencyKey\?\s*:\s*string[\s\S]*?\.idempotencyKey\s*=\s*idempotencyKey/);
  });

  it('🚨 key deterministico (NO Date.now / randomBytes) per stesso runId+nodeId', () => {
    // Cerca DENTRO la sezione idempotencyKey assignment per garantire NO
    // randomness — la stesso runId+nodeId deve produrre lo stesso key
    // attraverso tutti i retry.
    const match = /const idempotencyKey[\s\S]*?execCtx[\s\S]*?idempotencyKey\s*=\s*idempotencyKey;/.exec(strategySource);
    expect(match, 'idempotencyKey block non trovato').toBeTruthy();
    const block = match![0];
    expect(block).not.toMatch(/Math\.random|Date\.now|randomBytes/);
  });

  it('🚨 commento spiega il PERCHÉ (anti double-charge su retry)', () => {
    expect(strategySource).toMatch(/AUDIT FIX WE-11[\s\S]*?double-charge|Idempotency.*retry/);
  });
});
