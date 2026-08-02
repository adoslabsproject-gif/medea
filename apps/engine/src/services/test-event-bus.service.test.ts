/**
 * Test 2026-grade — TestEventBus (in-memory single-shot listener).
 *
 * SINGLE-SHOT: listener auto-unsubscribe after first publish.
 * SUPERSEDE: subscribe 2x stesso workflow → 1° reject('superseded').
 * TIMEOUT: setTimeout reject('timeout') + remove from map.
 * TENANT ISOLATION: key = tenant::wf (no cross-tenant).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  subscribeForTestEvent,
  hasTestListener,
  publishTestEvent,
  cancelTestListener,
} from './test-event-bus.service.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const samplePayload = {
  headers: { 'content-type': 'application/json' },
  body: { hello: 'world' },
  query: { q: '1' },
  method: 'POST',
};

describe('🚨 subscribe + publish — happy', () => {
  it('🚨 publish risolve subscribe con ts', async () => {
    const p = subscribeForTestEvent('t-1', 'wf-1');
    const ok = publishTestEvent('t-1', 'wf-1', samplePayload);
    expect(ok).toBe(true);
    const result = await p;
    expect(result.body).toEqual({ hello: 'world' });
    expect(result.headers).toEqual({ 'content-type': 'application/json' });
    expect(result.method).toBe('POST');
    expect(result.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it('🚨 publish senza listener → false', () => {
    expect(publishTestEvent('t-no', 'wf-no', samplePayload)).toBe(false);
  });

  it('🚨 single-shot: dopo publish, hasTestListener → false', async () => {
    const p = subscribeForTestEvent('t', 'wf');
    expect(hasTestListener('t', 'wf')).toBe(true);
    publishTestEvent('t', 'wf', samplePayload);
    await p;
    expect(hasTestListener('t', 'wf')).toBe(false);
  });
});

describe('🚨 supersede — subscribe 2x stesso workflow', () => {
  it('🚨 2° subscribe → 1° reject("superseded")', async () => {
    const first = subscribeForTestEvent('t', 'wf-x');
    const second = subscribeForTestEvent('t', 'wf-x'); // supersedes first
    await expect(first).rejects.toThrow(/superseded/u);
    publishTestEvent('t', 'wf-x', samplePayload);
    await expect(second).resolves.toBeDefined();
  });

  it('🚨 dopo supersede, solo 1 listener attivo (no leak)', () => {
    // Suppress unhandled rejection del primo (verrà rejected('superseded'))
    subscribeForTestEvent('t', 'wf-leak').catch(() => undefined);
    subscribeForTestEvent('t', 'wf-leak').catch(() => undefined);
    expect(hasTestListener('t', 'wf-leak')).toBe(true);
    cancelTestListener('t', 'wf-leak'); // cleanup
  });
});

describe('🚨 tenant isolation', () => {
  it('🚨 same workflowId, diversi tenant → listener separati', async () => {
    const a = subscribeForTestEvent('tenant-A', 'wf-1');
    const b = subscribeForTestEvent('tenant-B', 'wf-1');
    publishTestEvent('tenant-A', 'wf-1', { ...samplePayload, body: { from: 'A' } });
    const rA = await a;
    expect(rA.body).toEqual({ from: 'A' });
    expect(hasTestListener('tenant-B', 'wf-1')).toBe(true); // B ancora attivo
    publishTestEvent('tenant-B', 'wf-1', samplePayload);
    await expect(b).resolves.toBeDefined();
  });

  it('🚨 publish da tenant errato → false', async () => {
    void subscribeForTestEvent('A', 'wf');
    expect(publishTestEvent('B', 'wf', samplePayload)).toBe(false);
  });
});

describe('🚨 timeout', () => {
  it('🚨 nessun publish in window → reject("timeout")', async () => {
    const p = subscribeForTestEvent('t', 'wf-timeout', 1000);
    vi.advanceTimersByTime(1100);
    await expect(p).rejects.toThrow(/timeout/u);
    expect(hasTestListener('t', 'wf-timeout')).toBe(false);
  });

  it('🚨 default timeout 5 min', async () => {
    const p = subscribeForTestEvent('t', 'wf-default');
    vi.advanceTimersByTime(5 * 60_000 + 100);
    await expect(p).rejects.toThrow(/timeout/u);
  });

  it('🚨 publish PRIMA del timeout → resolve (no reject)', async () => {
    const p = subscribeForTestEvent('t', 'wf-fast', 5000);
    vi.advanceTimersByTime(2000);
    publishTestEvent('t', 'wf-fast', samplePayload);
    vi.advanceTimersByTime(10_000); // oltre 5s
    await expect(p).resolves.toBeDefined();
  });
});

describe('🚨 cancelTestListener', () => {
  it('🚨 cancel → reject("cancelled") + cleanup', async () => {
    const p = subscribeForTestEvent('t', 'wf-cancel');
    const ok = cancelTestListener('t', 'wf-cancel');
    expect(ok).toBe(true);
    await expect(p).rejects.toThrow(/cancelled/u);
    expect(hasTestListener('t', 'wf-cancel')).toBe(false);
  });

  it('🚨 cancel inesistente → false', () => {
    expect(cancelTestListener('t', 'no-such')).toBe(false);
  });
});
