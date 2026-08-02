import { describe, it, expect } from 'vitest';
import { runJsExecutor } from './run-js.js';

const baseContext = {
  tenantId: 'tenant-test',
  runId: 'run-1',
  nodeId: 'node-1',
  abortSignal: undefined,
} as unknown as Parameters<typeof runJsExecutor>[2];

describe('run-js executor', () => {
  it('esegue script semplice e ritorna risultato', async () => {
    const r = await runJsExecutor({ code: 'return 1 + 1;' }, null, baseContext);
    expect((r.output as { result: unknown }).result).toBe(2);
  });

  it('riceve input come variabile globale', async () => {
    const r = await runJsExecutor(
      { code: 'return input.items.reduce((s, x) => s + x.amount, 0);' },
      { items: [{ amount: 10 }, { amount: 20 }, { amount: 30 }] },
      baseContext,
    );
    expect((r.output as { result: unknown }).result).toBe(60);
  });

  it('riceve ctx con tenantId/runId/nodeId (no host APIs)', async () => {
    const r = await runJsExecutor(
      { code: 'return { tid: ctx.tenantId, rid: ctx.runId };' },
      null,
      baseContext,
    );
    expect((r.output as { result: { tid: string; rid: string } }).result).toEqual({
      tid: 'tenant-test',
      rid: 'run-1',
    });
  });

  it('rejecta code vuoto', async () => {
    await expect(runJsExecutor({ code: '' }, null, baseContext)).rejects.toThrow(
      /code.*obbligatorio/i,
    );
  });

  it('rejecta code > 50KB', async () => {
    await expect(runJsExecutor({ code: 'a'.repeat(50_001) }, null, baseContext)).rejects.toThrow(
      /troppo lungo/i,
    );
  });

  it('rejecta sintassi non valida', async () => {
    await expect(runJsExecutor({ code: 'return ((' }, null, baseContext)).rejects.toThrow(
      /sintassi/i,
    );
  });

  it('blocca timeout su infinite loop', async () => {
    await expect(
      runJsExecutor({ code: 'while(true){} return 1;', timeoutMs: 200 }, null, baseContext),
    ).rejects.toThrow(/timeout/i);
  }, 5000);

  it('blocca accesso a require/process/fetch (no host APIs)', async () => {
    await expect(
      runJsExecutor({ code: 'return typeof require;' }, null, baseContext),
    ).resolves.toMatchObject({ output: { result: 'undefined' } });

    await expect(
      runJsExecutor({ code: 'return typeof process;' }, null, baseContext),
    ).resolves.toMatchObject({ output: { result: 'undefined' } });

    await expect(
      runJsExecutor({ code: 'return typeof fetch;' }, null, baseContext),
    ).resolves.toMatchObject({ output: { result: 'undefined' } });
  });

  it('clamp memoryLimitMb a min 16', async () => {
    const r = await runJsExecutor({ code: 'return "ok";', memoryLimitMb: 1 }, null, baseContext);
    expect((r.output as { result: unknown }).result).toBe('ok');
  });

  it('clamp memoryLimitMb a max 512', async () => {
    const r = await runJsExecutor(
      { code: 'return "ok";', memoryLimitMb: 99999 },
      null,
      baseContext,
    );
    expect((r.output as { result: unknown }).result).toBe('ok');
  });

  it('produce JSON-serializable result (object/array)', async () => {
    const r = await runJsExecutor(
      { code: 'return { items: [1, 2, 3], total: 6 };' },
      null,
      baseContext,
    );
    expect((r.output as { result: unknown }).result).toEqual({
      items: [1, 2, 3],
      total: 6,
    });
  });

  // AUDIT FIX RUNJS-1: prova che l'esecuzione async NON blocca l'event-loop.
  // Uno script CPU-bound (~centinaia di ms) gira su thread separato (isolated-vm
  // async run); nel frattempo un setInterval sul main thread DEVE poter ticchettare.
  // Con il vecchio `runSync` il main thread sarebbe bloccato → ticks === 0.
  it("non blocca l'event-loop durante uno script CPU-bound (async run)", async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 15);
    try {
      const r = await runJsExecutor(
        // ~5e8 iterazioni: centinaia di ms su qualsiasi hardware, ben sotto il
        // timeout. Il risultato è usato (return) → no dead-code elimination.
        {
          code: 'let s = 0; for (let i = 0; i < 5e8; i++) { s += i; } return s;',
          timeoutMs: 30_000,
        },
        null,
        baseContext,
      );
      expect(typeof (r.output as { result: unknown }).result).toBe('number');
    } finally {
      clearInterval(timer);
    }
    // Se l'event-loop fosse stato bloccato dal runSync, nessun tick sarebbe
    // potuto avvenire durante l'esecuzione dello script.
    expect(ticks).toBeGreaterThan(0);
  }, 35_000);
});
