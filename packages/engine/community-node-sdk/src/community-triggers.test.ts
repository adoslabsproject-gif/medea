import { describe, it, expect, vi } from 'vitest';
import { trigger, validateTriggerSpec, defineCommunityNode, compile, type TriggerSpec, type CommunityNodeDefinition } from './index.js';

const pollingTrigger: TriggerSpec = {
  id: 'new_order', label: 'Nuovo ordine', mode: 'polling', pollIntervalSec: 30,
  poll: async (_config, ctx, emit) => { emit({ orderId: 1 }); ctx.state.lastId = 1; },
};
const streamTrigger: TriggerSpec = {
  id: 'price_tick', label: 'Prezzo live', mode: 'stream',
  connect: async (_config, _ctx, emit) => { emit({ price: 42 }); return () => { /* teardown */ }; },
};

function node(triggers?: TriggerSpec[]): CommunityNodeDefinition {
  return {
    manifest: { id: 'acme', vendor: 'acme', version: '1.0.0', displayName: 'Acme', description: 'x', license: 'MIT' },
    def: { type: 'trigger', icon: 'box', color: '#000000' },
    actions: [{ id: 'noop', label: 'Noop', execute: async () => ({}) }],
    ...(triggers ? { triggers } : {}),
  };
}

describe('trigger() + validateTriggerSpec', () => {
  it('trigger() è identity (autocomplete)', () => {
    expect(trigger(pollingTrigger)).toBe(pollingTrigger);
  });

  it('polling valido / stream valido → nessun throw', () => {
    expect(() => { validateTriggerSpec(pollingTrigger); }).not.toThrow();
    expect(() => { validateTriggerSpec(streamTrigger); }).not.toThrow();
  });

  it('mode=polling senza poll() → throw', () => {
    expect(() => { validateTriggerSpec({ id: 'x', label: 'X', mode: 'polling' }); }).toThrow(/poll\(\)/u);
  });

  it('mode=stream senza connect() → throw', () => {
    expect(() => { validateTriggerSpec({ id: 'x', label: 'X', mode: 'stream' }); }).toThrow(/connect\(\)/u);
  });

  it('id non valido → throw', () => {
    expect(() => { validateTriggerSpec({ ...pollingTrigger, id: 'bad id!' }); }).toThrow(/non valido/u);
  });
});

describe('defineCommunityNode con triggers', () => {
  it('accetta un nodo con triggers validi', () => {
    const n = defineCommunityNode(node([pollingTrigger, streamTrigger]));
    expect(n.triggers?.length).toBe(2);
  });

  it('rifiuta un trigger incoerente (polling senza poll)', () => {
    expect(() => defineCommunityNode(node([{ id: 'x', label: 'X', mode: 'polling' }]))).toThrow(/poll\(\)/u);
  });

  it('il lifecycle poll() emette eventi e aggiorna lo state', async () => {
    const emit = vi.fn();
    const ctx = { tenantId: 't', workflowId: 'w', nodeId: 'n', state: {} as Record<string, unknown> };
    await pollingTrigger.poll!({}, ctx, emit);
    expect(emit).toHaveBeenCalledWith({ orderId: 1 });
    expect(ctx.state.lastId).toBe(1);
  });

  it('il lifecycle connect() emette e ritorna teardown', async () => {
    const emit = vi.fn();
    const teardown = await streamTrigger.connect!({}, { tenantId: 't', workflowId: 'w', nodeId: 'n', state: {} }, emit);
    expect(emit).toHaveBeenCalledWith({ price: 42 });
    expect(typeof teardown).toBe('function');
  });
});

// FEAT community-trigger runtime (2026-06-09): i trigger POLLING sono ora
// compilati ed eseguiti; gli STREAM restano rifiutati esplicitamente. Questi
// test esercitano compile() DAVVERO (non solo la superficie API) ed ESEGUONO
// il poll bridge generato — niente green-smoke.
describe('compile() — trigger polling supportato, stream rifiutato', () => {
  it('compile() con un trigger POLLING → nodedef.triggers + bridge nell\'executor', () => {
    const out = compile(node([pollingTrigger]));
    expect(out.nodedef.triggers).toHaveLength(1);
    expect(out.nodedef.triggers?.[0]).toMatchObject({ id: 'new_order', mode: 'polling', pollIntervalSec: 30 });
    // L'executor contiene la funzione poll serializzata + il bridge di dispatch.
    expect(out.executorSource).toContain('__ff_trigger_new_order');
    expect(out.executorSource).toContain('__ff_trigger_poll');
  });

  it('🚨 compile() con un trigger STREAM → throw esplicito che indirizza a trigger_websocket', () => {
    try {
      compile(node([streamTrigger]));
      expect.fail('compile() avrebbe dovuto rifiutare lo stream');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/stream/iu);
      expect(msg).toMatch(/trigger_websocket/u);
      expect(msg).toContain('price_tick'); // nomina il trigger colpevole
    }
  });

  it('mix polling+stream → throw (basta UN solo stream a bloccare il build)', () => {
    expect(() => compile(node([pollingTrigger, streamTrigger]))).toThrow(/stream/iu);
  });

  it('compile() SENZA trigger → ok, e nessun campo triggers/bridge fantasma', () => {
    const out = compile(node());
    expect(out.nodedef.triggers).toBeUndefined();
    expect(out.executorSource).not.toContain('__ff_trigger_poll');
  });

  it('🚨 il poll bridge generato ESEGUE davvero: emit→events, ctx.state→state', async () => {
    // Trigger polling che emette in base allo stato (cursor lastId) e lo avanza.
    const cursorTrigger: TriggerSpec = {
      id: 'rows', label: 'Nuove righe', mode: 'polling', pollIntervalSec: 15,
      poll: async (_config, ctx, emit) => {
        const last = typeof ctx.state.lastId === 'number' ? ctx.state.lastId : 0;
        emit({ id: last + 1 });
        emit({ id: last + 2 });
        ctx.state.lastId = last + 2;
      },
    };
    const out = compile(node([cursorTrigger]));
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('module', `${out.executorSource}; return module.exports;`);
    const mod = { exports: undefined as unknown };
    const execute = fn(mod) as (cfg: Record<string, unknown>, inp: unknown, ctx: Record<string, unknown>) => Promise<unknown>;

    // Primo poll: state vuoto → eventi 1,2, nuovo state lastId=2
    const r1 = await execute(
      { __ff_trigger_poll: 'rows' },
      { state: {} },
      { tenantId: 't', workflowId: 'w', nodeId: 'n' },
    ) as { events: { id: number }[]; state: { lastId: number } };
    expect(r1.events).toEqual([{ id: 1 }, { id: 2 }]);
    expect(r1.state.lastId).toBe(2);

    // Secondo poll: state ripassato → eventi 3,4 (cursor avanzato, no replay)
    const r2 = await execute(
      { __ff_trigger_poll: 'rows' },
      { state: r1.state },
      { tenantId: 't', workflowId: 'w', nodeId: 'n' },
    ) as { events: { id: number }[]; state: { lastId: number } };
    expect(r2.events).toEqual([{ id: 3 }, { id: 4 }]);
    expect(r2.state.lastId).toBe(4);
  });

  it('poll bridge: trigger id sconosciuto → throw esplicito', async () => {
    const out = compile(node([pollingTrigger]));
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('module', `${out.executorSource}; return module.exports;`);
    const mod = { exports: undefined as unknown };
    const execute = fn(mod) as (cfg: Record<string, unknown>, inp: unknown, ctx: Record<string, unknown>) => Promise<unknown>;
    await expect(
      execute({ __ff_trigger_poll: 'does_not_exist' }, { state: {} }, { tenantId: 't', workflowId: 'w', nodeId: 'n' }),
    ).rejects.toThrow(/trigger sconosciuto/u);
  });
});
