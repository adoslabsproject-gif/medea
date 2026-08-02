/**
 * Bug-bounty di collectTenantHealth: aggregazione robusta + fail-soft storage
 * + normalizzazione (niente negativi, uptime intero). Nessun dato inventato.
 */
import { describe, it, expect, vi } from 'vitest';
import { collectTenantHealth, type TenantHealthDeps } from './tenant-health.service.js';

function deps(over: Partial<TenantHealthDeps> = {}): TenantHealthDeps {
  return {
    tenantId: 't-1',
    plan: { code: 'pro', diskGb: 20, vectorMaxVectors: 100000, vectorMaxDiskMb: 512 },
    uptimeSeconds: 3661.7,
    countWorkflows: () => 4,
    countRuns: () => 123,
    storageUsedBytes: async () => 5_000_000,
    storageTotalBytes: 21_474_836_480,
    ...over,
  };
}

describe('collectTenantHealth', () => {
  it('aggrega i dati reali (plan/uptime/counts/storage)', async () => {
    const h = await collectTenantHealth(deps());
    expect(h.tenantId).toBe('t-1');
    expect(h.plan.code).toBe('pro');
    expect(h.uptimeSeconds).toBe(3661); // floor di 3661.7
    expect(h.counts).toEqual({ workflows: 4, runs: 123 });
    expect(h.storage).toEqual({ usedBytes: 5_000_000, totalBytes: 21_474_836_480 });
  });

  it('🚨 storage probe che lancia → fail-soft usedBytes=0 (pannello non si rompe)', async () => {
    const h = await collectTenantHealth(
      deps({
        storageUsedBytes: async () => {
          throw new Error('disk probe failed');
        },
      }),
    );
    expect(h.storage.usedBytes).toBe(0);
    // il resto resta valido
    expect(h.counts.runs).toBe(123);
  });

  it('normalizza i negativi a 0 (dati corrotti non producono valori assurdi)', async () => {
    const h = await collectTenantHealth(
      deps({
        uptimeSeconds: -5,
        countWorkflows: () => -1,
        countRuns: () => -10,
        storageUsedBytes: async () => -100,
        storageTotalBytes: -1,
      }),
    );
    expect(h.uptimeSeconds).toBe(0);
    expect(h.counts).toEqual({ workflows: 0, runs: 0 });
    expect(h.storage).toEqual({ usedBytes: 0, totalBytes: 0 });
  });

  it('tenantId null (env non settato) è propagato senza crash', async () => {
    const h = await collectTenantHealth(deps({ tenantId: null }));
    expect(h.tenantId).toBeNull();
  });

  it('le funzioni di conteggio sono invocate (lazy, non valori pre-calcolati)', async () => {
    const countWorkflows = vi.fn(() => 7);
    const countRuns = vi.fn(() => 9);
    await collectTenantHealth(deps({ countWorkflows, countRuns }));
    expect(countWorkflows).toHaveBeenCalledOnce();
    expect(countRuns).toHaveBeenCalledOnce();
  });
});
