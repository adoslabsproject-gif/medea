/**
 * SDK unit tests — defineCommunityNode validation + compile() output shape.
 *
 * Round-trip: build a spec → compile → check that manifest/nodedef match
 * what the FlowForge runtime expects + executor.js dispatches correctly.
 */

import { describe, it, expect } from 'vitest';
import { defineCommunityNode, action, compile, type CommunityNodeDefinition } from './index.js';

const VALID: CommunityNodeDefinition = {
  manifest: {
    id: 'test_widget',
    vendor: 'test-vendor',
    version: '1.0.0',
    displayName: 'Test Widget',
    description: 'Suite di test',
    license: 'MIT',
  },
  def: {
    type: 'action',
    icon: 'cube',
    color: '#3b82f6',
    configFields: [{ key: 'apiKey', label: 'API Key', type: 'secret', required: true }],
  },
  actions: [
    action({
      id: 'do_a',
      label: 'Do A',
      configFields: [{ key: 'arg', label: 'Argument', type: 'text' }],
       
      async execute(config) {
        return { ok: true, arg: config.arg };
      },
    }),
    action({
      id: 'do_b',
      label: 'Do B',
      aiAction: true,
       
      async execute() {
        return { ok: true, action: 'b' };
      },
    }),
  ],
};

describe('defineCommunityNode', () => {
  it('accepts a valid spec', () => {
    expect(() => defineCommunityNode(VALID)).not.toThrow();
  });

  it('rejects bad version format', () => {
    expect(() => defineCommunityNode({
      ...VALID,
      manifest: { ...VALID.manifest, version: '1.0' },
    })).toThrow();
  });

  it('rejects bad color', () => {
    expect(() => defineCommunityNode({
      ...VALID,
      def: { ...VALID.def, color: 'blue' },
    })).toThrow();
  });

  it('rejects empty actions', () => {
    expect(() => defineCommunityNode({ ...VALID, actions: [] })).toThrow();
  });

  it('rejects invalid action id', () => {
    expect(() => defineCommunityNode({
      ...VALID,
      actions: [action({ id: 'has spaces', label: 'X', execute: async () => null })],
    })).toThrow();
  });
});

describe('compile()', () => {
  it('produces manifest + nodedef + executorSource', () => {
    const out = compile(VALID);
    expect(out.manifest.id).toBe('test_widget');
    expect(out.nodedef.id).toBe('test_widget');
    expect(out.nodedef.actions).toHaveLength(2);
    expect(out.nodedef.actions[0].id).toBe('do_a');
    expect(out.nodedef.actions[1].aiAction).toBe(true);
    expect(out.executorSource).toContain('module.exports');
    expect(out.executorSource).toContain('__action_do_a');
    expect(out.executorSource).toContain('__action_do_b');
    expect(out.executorSource).toContain('case "do_a"');
  });

  it('omits optional fields cleanly', () => {
    const out = compile({
      manifest: VALID.manifest,
      def: { type: 'action', icon: 'cube', color: '#3b82f6' },
      actions: [action({ id: 'a', label: 'A', execute: async () => null })],
    });
    expect(out.nodedef.configFields).toBeUndefined();
    expect(out.manifest.category).toBeUndefined();
  });

  it('executor source is runnable JS that dispatches by __action', () => {
    const out = compile(VALID);
    // Run the executor source through eval in a controlled scope.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('module', `${out.executorSource}; return module.exports;`);
    const mod = { exports: undefined as unknown };
    const execute = fn(mod) as (cfg: Record<string, unknown>, inp: unknown, ctx: { action?: string }) => Promise<unknown>;
    return Promise.all([
      execute({ __action: 'do_a', arg: 'hello' }, null, {}).then((r) => {
        expect(r).toEqual({ ok: true, arg: 'hello' });
      }),
      execute({ __action: 'do_b' }, null, {}).then((r) => {
        expect(r).toEqual({ ok: true, action: 'b' });
      }),
    ]);
  });

  it('throws on unknown action', async () => {
    const out = compile(VALID);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('module', `${out.executorSource}; return module.exports;`);
    const mod = { exports: undefined as unknown };
    const execute = fn(mod) as (cfg: Record<string, unknown>, inp: unknown, ctx: unknown) => Promise<unknown>;
    await expect(execute({ __action: 'nope' }, null, {})).rejects.toThrow(/action sconosciuta/u);
  });
});

// AUDIT FIX SDK-3 (2026-06-09): self-diagnosi della perdita di closure.
// `execute.toString()` perde il lexical environment → una execute() che
// referenzia un import/const di modulo produrrebbe un ReferenceError opaco.
// Questi test PROVANO che l'errore è invece attribuito + azionabile, che le
// closure legittime (helpers) funzionano, e che gli altri errori passano
// invariati (no over-wrapping). Niente green-smoke: ogni test esegue davvero
// l'executor generato.
describe('compile() — SDK-3 closure-loss self-diagnosis', () => {
  type Executor = (cfg: Record<string, unknown>, inp: unknown, ctx: { action?: string }) => Promise<unknown>;
  function load(source: string): Executor {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('module', `${source}; return module.exports;`);
    const mod = { exports: undefined as unknown };
    return fn(mod) as Executor;
  }

  function nodeWithExecute(body: () => unknown, helpers?: string): CommunityNodeDefinition {
    return {
      manifest: { id: 'sdk3', vendor: 'v', version: '1.0.0', displayName: 'SDK3 Node', description: 'x', license: 'MIT' },
      def: { type: 'action', icon: 'cube', color: '#3b82f6' },
      ...(helpers ? { helpers } : {}),
      actions: [action({ id: 'go', label: 'Go', execute: body as never })],
    };
  }

  it('🚨 closure persa (free var) → errore ATTRIBUITO che nomina l\'identificatore + rimanda a `helpers`', async () => {
    // `EXTERNAL_CLIENT` è una const di modulo (qui simulata da un free var):
    // .toString() la perde → a runtime sarebbe "EXTERNAL_CLIENT is not defined".
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = compile(nodeWithExecute(() => (EXTERNAL_CLIENT as any).call()));
    const execute = load(out.executorSource);
    await expect(execute({ __action: 'go' }, null, {})).rejects.toThrow(/EXTERNAL_CLIENT/u);
    // Deve menzionare la soluzione (`helpers`) e il tag SDK-3, NON essere un crash opaco.
    await expect(execute({ __action: 'go' }, null, {})).rejects.toThrow(/helpers/u);
    await expect(execute({ __action: 'go' }, null, {})).rejects.toThrow(/SDK-3/u);
  });

  it('closure legittima via `helpers` → FUNZIONA (escape hatch ufficiale)', async () => {
    const out = compile(
      nodeWithExecute(
        // referenzia SHARED_BASE, definita in helpers (inlinata a livello modulo)
         
        () => ({ url: SHARED_BASE + '/v1' }),
        "const SHARED_BASE = 'https://api.acme.test';",
      ),
    );
    const execute = load(out.executorSource);
    await expect(execute({ __action: 'go' }, null, {})).resolves.toEqual({ url: 'https://api.acme.test/v1' });
  });

  it('un errore NON-ReferenceError passa invariato (no over-wrapping)', async () => {
    const out = compile(nodeWithExecute(() => { throw new Error('boom-dominio'); }));
    const execute = load(out.executorSource);
    // Il messaggio deve restare 'boom-dominio', NON essere riscritto come closure-loss.
    await expect(execute({ __action: 'go' }, null, {})).rejects.toThrow(/boom-dominio/u);
    await expect(execute({ __action: 'go' }, null, {})).rejects.not.toThrow(/SDK-3/u);
  });

  it('regressione: il valore di ritorno è preservato dall\'`await` introdotto nel dispatch', async () => {
    const out = compile(nodeWithExecute(() => ({ ok: true, n: 42 })));
    const execute = load(out.executorSource);
    await expect(execute({ __action: 'go' }, null, {})).resolves.toEqual({ ok: true, n: 42 });
  });

  // BUG normalizeFnSource (pre-esistente, scoperto 2026-06-09): una execute
  // scritta come arrow `async (cfg) => {…}` veniva riscritta in `function (cfg)
  // => {…}` (invalido). I test esistenti compilavano ma non ESEGUIVANO mai un
  // arrow-async → green-smoke. Questo lo esegue davvero.
  it('🚨 execute come arrow async `async (cfg) => …` → executor VALIDO ed eseguibile', async () => {
    const out = compile(
       
      nodeWithExecute((async (cfg: Record<string, unknown>) => ({ echoed: cfg.x })) as never),
    );
    const execute = load(out.executorSource);
    await expect(execute({ __action: 'go', x: 7 }, null, {})).resolves.toEqual({ echoed: 7 });
  });
});

// Riferimenti simbolici usati SOLO nelle closure di test sopra (mai eseguiti
// in questo scope: la loro perdita è esattamente ciò che il test verifica).
declare const EXTERNAL_CLIENT: unknown;
declare const SHARED_BASE: string;
