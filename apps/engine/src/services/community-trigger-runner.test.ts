/**
 * Test per community-trigger-runner.
 *
 * Coverage:
 *   • normalizePollResult: robustezza contro output sandbox malformati + cap eventi
 *   • clampPollIntervalSec: bounds [10, 3600]
 *   • runCommunityTriggerPoll: integrazione REALE nel sandbox isolated-vm
 *     (inline) — esegue un executor che rispetta il contratto del bridge e
 *     verifica events + state round-trip (cursor che avanza tra i poll).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger.js');

import {
  normalizePollResult,
  clampPollIntervalSec,
  runCommunityTriggerPoll,
  MAX_EVENTS_PER_POLL,
  type PollContext,
} from './community-trigger-runner.js';
import type { InstalledNode } from './community-nodes.service.js';

beforeEach(() => {
  // Forza il path inline del sandbox (no worker_threads) per test deterministici.
  process.env.MEDEA_SANDBOX_DISABLE_WORKER = 'true';
});

describe('normalizePollResult — robustezza', () => {
  it('output ben formato { events, state } → passa intatto', () => {
    const r = normalizePollResult({ events: [{ id: 1 }], state: { lastId: 1 } });
    expect(r).toEqual({ events: [{ id: 1 }], state: { lastId: 1 }, truncated: false });
  });

  it('null / numero / stringa / array → defaults sicuri (no crash)', () => {
    for (const bad of [null, 42, 'x', [1, 2, 3], undefined]) {
      expect(normalizePollResult(bad)).toEqual({ events: [], state: {}, truncated: false });
    }
  });

  it('events non-array → [] ; state array o null → {}', () => {
    expect(normalizePollResult({ events: 'nope', state: [1] })).toEqual({ events: [], state: {}, truncated: false });
    expect(normalizePollResult({ events: [{ a: 1 }], state: null })).toEqual({ events: [{ a: 1 }], state: {}, truncated: false });
  });

  it('🚨 anti-flood: oltre MAX_EVENTS_PER_POLL → troncato a cap + truncated=true', () => {
    const huge = Array.from({ length: MAX_EVENTS_PER_POLL + 50 }, (_v, i) => ({ i }));
    const r = normalizePollResult({ events: huge, state: {} });
    expect(r.events).toHaveLength(MAX_EVENTS_PER_POLL);
    expect(r.truncated).toBe(true);
  });

  it('esattamente cap → non troncato', () => {
    const exact = Array.from({ length: MAX_EVENTS_PER_POLL }, (_v, i) => ({ i }));
    expect(normalizePollResult({ events: exact, state: {} }).truncated).toBe(false);
  });
});

describe('clampPollIntervalSec', () => {
  it('clampa sotto 10 → 10, sopra 3600 → 3600', () => {
    expect(clampPollIntervalSec(2)).toBe(10);
    expect(clampPollIntervalSec(99999)).toBe(3600);
  });
  it('valore valido passa; non-numerico → fallback', () => {
    expect(clampPollIntervalSec(30)).toBe(30);
    expect(clampPollIntervalSec('abc', 60)).toBe(60);
    expect(clampPollIntervalSec(undefined, 45)).toBe(45);
  });
});

describe('runCommunityTriggerPoll — integrazione sandbox (inline)', () => {
  // Executor che rispetta il contratto del bridge generato dall'SDK: quando
  // config.__ff_trigger_poll è settato, emette eventi in base allo state (cursor
  // lastId) e lo avanza, ritornando { events, state }.
  const BRIDGE_EXECUTOR = `
    module.exports = async function execute(config, input, context) {
      if (config && config.__ff_trigger_poll) {
        var events = [];
        var state = (input && input.state && typeof input.state === 'object' && input.state !== null) ? input.state : {};
        var last = typeof state.lastId === 'number' ? state.lastId : 0;
        events.push({ id: last + 1, tenant: context.tenantId });
        events.push({ id: last + 2, tenant: context.tenantId });
        state.lastId = last + 2;
        return { events: events, state: state };
      }
      return null;
    };
  `;

  function fakeInstalled(executorSource: string): InstalledNode {
    return {
      manifest: {
        id: 'acme_poll', vendor: 'acme', version: '1.0.0',
        displayName: 'Acme Poll', description: 'x', license: 'MIT',
      } as InstalledNode['manifest'],
      def: { id: 'acme_poll', type: 'trigger', label: 'Acme Poll', icon: 'cube', color: '#3b82f6', description: 'x' } as InstalledNode['def'],
      executorSource,
      installedAt: new Date().toISOString(),
      verified: true,
      storagePath: '/tmp/acme_poll',
    };
  }

  const ctx: PollContext = { tenantId: 'tenant-1', workflowId: 'wf-1', nodeId: 'node-1' };

  it('🚨 round-trip: emette eventi col cursor e avanza lo state tra due poll', async () => {
    const installed = fakeInstalled(BRIDGE_EXECUTOR);

    const r1 = await runCommunityTriggerPoll(installed, 'rows', {}, {}, ctx);
    expect(r1.events).toEqual([
      { id: 1, tenant: 'tenant-1' },
      { id: 2, tenant: 'tenant-1' },
    ]);
    expect(r1.state).toEqual({ lastId: 2 });
    expect(r1.truncated).toBe(false);

    // Secondo poll col state ripassato → cursor avanza, NESSUN replay degli stessi id
    const r2 = await runCommunityTriggerPoll(installed, 'rows', {}, r1.state, ctx);
    expect(r2.events).toEqual([
      { id: 3, tenant: 'tenant-1' },
      { id: 4, tenant: 'tenant-1' },
    ]);
    expect(r2.state).toEqual({ lastId: 4 });
  });

  it('un poll che ritorna forma inattesa → normalizzato a vuoto (no crash)', async () => {
    const installed = fakeInstalled(`module.exports = async function () { return 12345; };`);
    const r = await runCommunityTriggerPoll(installed, 'rows', {}, {}, ctx);
    expect(r).toEqual({ events: [], state: {}, truncated: false });
  });

  it('un poll che throwa → propaga (il caller logga per-poll, non silenziato)', async () => {
    const installed = fakeInstalled(`module.exports = async function () { throw new Error('config invalida: API key mancante'); };`);
    await expect(runCommunityTriggerPoll(installed, 'rows', {}, {}, ctx)).rejects.toThrow(/API key mancante/u);
  });
});
