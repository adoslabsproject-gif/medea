/**
 * E2E sandbox worker_thread test — esegue runInSandbox in MODALITA\` WORKER
 * REALE (no inline fallback). Verifica che il worker spawnato gira il source
 * vendor isolatamente dal main event-loop.
 *
 * Test 2026-grade VERITIERI:
 *  - Spawn worker reale (richiede .worker.js bundle disponibile)
 *  - Vendor source con return value diverso da string/number/object
 *  - Trace populated correctly da worker (logs + network + durationMs)
 *  - Error path: vendor throw → main riceve error message dal worker
 *  - Timeout safety: 20s hard kill (test rapido con vendor che cicla)
 *
 * NB: questi test richiedono il bundle dist/. In CI senza build, ci sara\`
 * skip automatico se il worker file non esiste.
 *
 * @module executors/community-node-sandbox.worker.e2e.test
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { SandboxInput, SandboxTrace } from './community-node-sandbox.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Forziamo modalità WORKER reale (non inline)
beforeAll(() => {
  delete process.env.VITEST;
  delete process.env.NODE_ENV;
  process.env.FLOWFORGE_SANDBOX_DISABLE_WORKER = 'false';
});

const WORKER_BUNDLE = join(__dirname, 'community-node-sandbox.worker.js');
const WORKER_AVAILABLE = existsSync(WORKER_BUNDLE);

const baseInput: SandboxInput = {
  config: { foo: 'bar' },
  input: { n: 7 },
  context: {
    tenantId: 'test-tenant',
    runId: 'run-test-1',
    workflowId: 'wf-1',
    nodeId: 'n-1',
    action: 'noop',
  },
};

describe.skipIf(!WORKER_AVAILABLE)('🚨 sandbox worker_thread E2E', () => {
  it('vendor returns object → main thread riceve object identico', async () => {
    const { runInSandbox } = await import('./community-node-sandbox.js');
    const src = `module.exports = async function(config, input, context) {
      return { result: input.n * 2, tenantId: context.tenantId };
    };`;
    const result = await runInSandbox(src, baseInput) as { result: number; tenantId: string };
    expect(result.result).toBe(14);
    expect(result.tenantId).toBe('test-tenant');
  });

  it('vendor logs → trace.logs populated dal worker', async () => {
    const { runInSandbox } = await import('./community-node-sandbox.js');
    const src = `module.exports = async function(config, input, context) {
      console.log('first');
      console.warn('second');
      console.error('third');
      return input.n;
    };`;
    const trace: SandboxTrace = { logs: [], network: [], durationMs: 0 };
    const r = await runInSandbox(src, baseInput, trace);
    expect(r).toBe(7);
    expect(trace.logs.length).toBeGreaterThanOrEqual(3);
    expect(trace.logs.some((l) => l.includes('first'))).toBe(true);
    expect(trace.logs.some((l) => l.includes('[warn]') && l.includes('second'))).toBe(true);
    expect(trace.logs.some((l) => l.includes('[error]') && l.includes('third'))).toBe(true);
    expect(trace.durationMs).toBeGreaterThan(0);
  });

  it('🚨 vendor throw → main riceve error message dal worker (anti-regression: no silent fail)', async () => {
    const { runInSandbox } = await import('./community-node-sandbox.js');
    const src = `module.exports = async function(config, input) {
      throw new Error('vendor boom ' + input.n);
    };`;
    await expect(runInSandbox(src, baseInput)).rejects.toThrow(/vendor boom 7/);
  });

  it('vendor returns null → main riceve null (no [object Object] coercion bug)', async () => {
    const { runInSandbox } = await import('./community-node-sandbox.js');
    const src = `module.exports = async function() { return null; };`;
    const r = await runInSandbox(src, baseInput);
    expect(r).toBeNull();
  });

  it('🚨 vendor synthax error → return-error sano (non hang worker)', async () => {
    const { runInSandbox } = await import('./community-node-sandbox.js');
    const src = `module.exports = async function() { return invalidIdent; };`;
    await expect(runInSandbox(src, baseInput)).rejects.toThrow(/invalidIdent|is not defined/);
  });

  it('🚨 isolato dal main: while(true) NON blocca il test (timeout 15s isolated-vm)', async () => {
    const { runInSandbox } = await import('./community-node-sandbox.js');
    const src = `module.exports = async function() { while (true) {} };`;
    const t0 = Date.now();
    await expect(runInSandbox(src, baseInput)).rejects.toThrow();
    const elapsed = Date.now() - t0;
    // isolated-vm timeout 15s ≤ elapsed ≤ 20s safety hard kill
    expect(elapsed).toBeLessThan(22_000);
    expect(elapsed).toBeGreaterThan(10_000);
  }, 25_000);

  /**
   * 🚨 AUDIT FIX C1 (2026-06-09) — REGRESSION GUARD:
   *
   * Pre-fix: il WORKER usava `fetch(url, init)` raw senza SSRF guard. Un
   * community/marketplace node malevolo poteva colpire cloud metadata
   * (AWS IMDS 169.254.169.254 → IAM role credentials), Docker socket,
   * Postgres/Redis interni. Inline sandbox era safe, worker NO.
   *
   * Fix: hostFetch ora chiama safeOutboundFetch → validateUrlForFetch (link-local
   * 169.254/16 → BLOCKED_LINK_LOCAL). Se il test fallisce significa che qualcuno
   * ha ri-bypassato il guard nel worker → REGRESSIONE CRITICA.
   */
  it('🚨🚨 [REGRESSION C1] worker fetch(http://169.254.169.254/...) blocked SSRF', async () => {
    const { runInSandbox } = await import('./community-node-sandbox.js');
    const src = `module.exports = async function() {
      try {
        await fetch('http://169.254.169.254/latest/meta-data/iam/security-credentials/');
        return 'NO_BLOCK_BAD';
      } catch (e) {
        return 'caught: ' + (e && e.message ? e.message : String(e));
      }
    };`;
    const r = await runInSandbox(src, baseInput) as string;
    expect(r).not.toBe('NO_BLOCK_BAD');
    expect(r).toMatch(/SSRF|BLOCKED|LINK_LOCAL|loopback/i);
  }, 15_000);

  it('🚨 [REGRESSION C1] worker fetch(http://127.0.0.1:6379) blocked SSRF (Redis)', async () => {
    const { runInSandbox } = await import('./community-node-sandbox.js');
    const src = `module.exports = async function() {
      try {
        await fetch('http://127.0.0.1:6379/');
        return 'NO_BLOCK_BAD';
      } catch (e) {
        return 'caught: ' + (e && e.message ? e.message : String(e));
      }
    };`;
    const r = await runInSandbox(src, baseInput) as string;
    expect(r).not.toBe('NO_BLOCK_BAD');
    expect(r).toMatch(/SSRF|BLOCKED|LOOPBACK|loopback/i);
  }, 15_000);
});

describe.skipIf(WORKER_AVAILABLE)('sandbox worker_thread E2E (skipped — no dist)', () => {
  it('worker bundle non disponibile → skip esplicito', () => {
    expect(WORKER_AVAILABLE).toBe(false);
  });
});
