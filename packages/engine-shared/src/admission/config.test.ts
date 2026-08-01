/**
 * Caratterizzazione del loader di config admission (single-source).
 * Bug-bounty: default, override validi, parsing robusto (NaN/negativi/zero/vuoto
 * → default, NON valori velenosi), flag enabled (solo 'false' disattiva).
 *
 * @module admission/config.test
 */
import { describe, it, expect } from 'vitest';
import { loadAdmissionConfig } from './config';

describe('loadAdmissionConfig — default', () => {
  it('env vuoto → default documentati', () => {
    const c = loadAdmissionConfig({});
    expect(c.enabled).toBe(true);
    expect(c.maxConcurrent).toEqual({ vllm: 4, external: 24 });
    expect(c.leaseMs).toBe(90_000);
    expect(c.heartbeatMs).toBe(20_000);
    expect(c.pollMs).toBe(750);
    expect(c.maxQueueDepth).toBe(50);
    expect(c.maxPerTenantQueue).toBe(5);
    expect(c.maxWaitMs).toBe(120_000);
  });
});

describe('loadAdmissionConfig — flag enabled', () => {
  it('SOLO "false" disattiva; qualsiasi altro valore (o assente) → attivo', () => {
    expect(loadAdmissionConfig({ LIARA_ADMISSION_QUEUE: 'false' }).enabled).toBe(false);
    expect(loadAdmissionConfig({ LIARA_ADMISSION_QUEUE: 'true' }).enabled).toBe(true);
    expect(loadAdmissionConfig({ LIARA_ADMISSION_QUEUE: '0' }).enabled).toBe(true); // non è "false"
    expect(loadAdmissionConfig({ LIARA_ADMISSION_QUEUE: '' }).enabled).toBe(true);
  });
});

describe('loadAdmissionConfig — override validi', () => {
  it('valori interi positivi sovrascrivono i default', () => {
    const c = loadAdmissionConfig({
      LIARA_ADMISSION_MAX_VLLM: '8', LIARA_ADMISSION_MAX_EXTERNAL: '40',
      LIARA_ADMISSION_LEASE_MS: '60000', LIARA_ADMISSION_POLL_MS: '500',
      LIARA_ADMISSION_MAX_QUEUE: '100', LIARA_ADMISSION_MAX_PER_TENANT: '3',
      LIARA_ADMISSION_MAX_WAIT_MS: '30000', LIARA_ADMISSION_HEARTBEAT_MS: '15000',
    });
    expect(c.maxConcurrent).toEqual({ vllm: 8, external: 40 });
    expect(c.leaseMs).toBe(60_000);
    expect(c.pollMs).toBe(500);
    expect(c.maxQueueDepth).toBe(100);
    expect(c.maxPerTenantQueue).toBe(3);
    expect(c.maxWaitMs).toBe(30_000);
    expect(c.heartbeatMs).toBe(15_000);
  });
});

describe('loadAdmissionConfig — parsing robusto (no valori velenosi)', () => {
  it('NaN / non-numerico → default (NON NaN)', () => {
    expect(loadAdmissionConfig({ LIARA_ADMISSION_MAX_VLLM: 'abc' }).maxConcurrent.vllm).toBe(4);
  });
  it('zero → default (uno slot a 0 bloccherebbe tutto)', () => {
    expect(loadAdmissionConfig({ LIARA_ADMISSION_MAX_VLLM: '0' }).maxConcurrent.vllm).toBe(4);
  });
  it('negativo → default', () => {
    expect(loadAdmissionConfig({ LIARA_ADMISSION_LEASE_MS: '-5' }).leaseMs).toBe(90_000);
  });
  it('stringa vuota → default', () => {
    expect(loadAdmissionConfig({ LIARA_ADMISSION_POLL_MS: '' }).pollMs).toBe(750);
  });
  it('intero con spazi/decimale → parseInt tronca ma resta positivo valido', () => {
    expect(loadAdmissionConfig({ LIARA_ADMISSION_MAX_QUEUE: '12.9' }).maxQueueDepth).toBe(12);
  });
});
