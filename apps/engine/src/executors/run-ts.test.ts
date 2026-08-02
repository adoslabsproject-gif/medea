import { describe, it, expect } from 'vitest';
import { runTsExecutor } from './run-ts.js';

const baseContext = {
  tenantId: 'tenant-test',
  runId: 'run-1',
  nodeId: 'node-1',
  abortSignal: undefined,
} as unknown as Parameters<typeof runTsExecutor>[2];

describe('run-ts executor', () => {
  it('esegue TypeScript semplice e ritorna risultato', async () => {
    const r = await runTsExecutor(
      { code: 'const x: number = 1 + 1; return x;' },
      null,
      baseContext,
    );
    expect((r.output as { result: unknown }).result).toBe(2);
  });

  it('🚨 strippa i tipi: interface/type/annotations NON arrivano a runtime', async () => {
    const code =
      'interface Item { amount: number }\n' +
      'type Sum = number;\n' +
      'const items: Item[] = input.items as Item[];\n' +
      'const total: Sum = items.reduce((s: number, x: Item) => s + x.amount, 0);\n' +
      'return total;';
    const r = await runTsExecutor(
      { code },
      { items: [{ amount: 10 }, { amount: 20 }, { amount: 30 }] },
      baseContext,
    );
    expect((r.output as { result: unknown }).result).toBe(60);
  });

  it('supporta enum + optional chaining + nullish (target ES2020)', async () => {
    const code =
      'enum Kind { A = "a", B = "b" }\n' +
      'const k: Kind = Kind.B;\n' +
      'const v = input?.nested?.value ?? "fallback";\n' +
      'return { k, v };';
    const r = await runTsExecutor({ code }, {}, baseContext);
    expect((r.output as { result: unknown }).result).toEqual({ k: 'b', v: 'fallback' });
  });

  it('riceve ctx con tenantId/runId/nodeId (no host APIs)', async () => {
    const r = await runTsExecutor(
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
    await expect(runTsExecutor({ code: '   ' }, null, baseContext)).rejects.toThrow(
      /campo "code" obbligatorio/,
    );
  });

  it('rejecta code > 50KB', async () => {
    await expect(runTsExecutor({ code: 'a'.repeat(50_001) }, null, baseContext)).rejects.toThrow(
      /troppo lungo/,
    );
  });

  it('🚨 rejecta TypeScript sintatticamente rotto con messaggio TS chiaro', async () => {
    await expect(runTsExecutor({ code: 'const x: number = ;' }, null, baseContext)).rejects.toThrow(
      /action_run_ts: errore sintassi TypeScript/,
    );
  });

  it('🚨 blocca host API (require/process/fetch assenti) — stessa sandbox di run_js', async () => {
    await expect(
      runTsExecutor({ code: 'return (globalThis as any).process.pid;' }, null, baseContext),
    ).rejects.toThrow(/action_run_ts: runtime error/);
    await expect(
      runTsExecutor({ code: 'const r = require("fs"); return r;' }, null, baseContext),
    ).rejects.toThrow(/action_run_ts: runtime error/);
  });

  it('🚨 blocca timeout su infinite loop (messaggio del nodo TS)', async () => {
    await expect(
      runTsExecutor({ code: 'while (true) {} return 1;', timeoutMs: 200 }, null, baseContext),
    ).rejects.toThrow(/action_run_ts: timeout/);
  });

  it('clamp memoryLimitMb a min 16 e max 512', async () => {
    const lo = await runTsExecutor({ code: 'return "ok";', memoryLimitMb: 1 }, null, baseContext);
    expect((lo.output as { result: unknown }).result).toBe('ok');
    const hi = await runTsExecutor(
      { code: 'return "ok";', memoryLimitMb: 99999 },
      null,
      baseContext,
    );
    expect((hi.output as { result: unknown }).result).toBe('ok');
  });

  it('produce output JSON-serializable (object/array tipizzati)', async () => {
    const code =
      'const out: { list: number[]; meta: { n: number } } = { list: [1, 2, 3], meta: { n: 3 } };\n' +
      'return out;';
    const r = await runTsExecutor({ code }, null, baseContext);
    expect((r.output as { result: unknown }).result).toEqual({ list: [1, 2, 3], meta: { n: 3 } });
  });
});
