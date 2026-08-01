/**
 * Bug-bounty del gate d'esecuzione. Policy billing-safe: blocca SOLO il tenant
 * accertato non-attivo (trial scaduto/suspended); ogni altro esito → fail-open
 * (mai bloccare run legittimi per un errore infrastrutturale del gate).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as TenantServiceModule from './tenant.service.js';

const assertActive = vi.hoisted(() => vi.fn());
const recordFailOpen = vi.hoisted(() => vi.fn());
vi.mock('./tenant.service.js', async (orig) => {
  // Riusa le VERE classi d'errore (instanceof deve combaciare nel gate),
  // mocka solo il singleton tenantService.assertActive.
  const actual = await orig<typeof TenantServiceModule>();
  return { ...actual, tenantService: { assertActive } };
});
vi.mock('@/lib/fail-open-metrics.js', () => ({ recordFailOpen }));

import { assertTenantCanExecute } from './execution-gate.js';
import { TenantNotActiveError, TenantNotFoundError } from './tenant.service.js';

beforeEach(() => { assertActive.mockReset(); recordFailOpen.mockClear(); });

describe('assertTenantCanExecute', () => {
  it('tenant attivo → passa (assertActive non lancia)', () => {
    assertActive.mockReturnValue(undefined);
    expect(() => { assertTenantCanExecute('t-1'); }).not.toThrow();
    expect(assertActive).toHaveBeenCalledWith('t-1');
  });

  it('🚨 trial scaduto / suspended → THROW (fail-closed: il run NON parte)', () => {
    assertActive.mockImplementation(() => { throw new TenantNotActiveError('t-1', 'trial', 'trial scaduto'); });
    expect(() => { assertTenantCanExecute('t-1'); }).toThrow(TenantNotActiveError);
  });

  it('tenant NON in tabella → passa (fail-open BENIGNO) e NON emette metrica', () => {
    assertActive.mockImplementation(() => { throw new TenantNotFoundError('t-x'); });
    expect(() => { assertTenantCanExecute('t-x'); }).not.toThrow();
    // NotFound è atteso (dev / container core): non deve fare rumore d'allarme.
    expect(recordFailOpen).not.toHaveBeenCalled();
  });

  it('🚨 errore infrastrutturale (DB giù, ecc.) → FAIL-OPEN, NON blocca i run', () => {
    // Es. getDatabase().sqlite undefined → TypeError. Bloccare TUTTI i run per
    // un bug del gate sarebbe peggio che lasciar passare → si passa.
    assertActive.mockImplementation(() => { throw new TypeError("Cannot read properties of undefined (reading 'prepare')"); });
    expect(() => { assertTenantCanExecute('t-1'); }).not.toThrow();
  });

  it('🚨 il fail-open ANOMALO (DB error) è STRUMENTATO: recordFailOpen("execution_gate")', () => {
    const dbErr = new TypeError("Cannot read properties of undefined (reading 'prepare')");
    assertActive.mockImplementation(() => { throw dbErr; });
    assertTenantCanExecute('t-9');
    expect(recordFailOpen).toHaveBeenCalledTimes(1);
    expect(recordFailOpen).toHaveBeenCalledWith('execution_gate', dbErr, { tenantId: 't-9' });
  });

  it('il percorso NORMALE (tenant attivo) NON emette metrica fail-open', () => {
    assertActive.mockReturnValue(undefined);
    assertTenantCanExecute('t-1');
    expect(recordFailOpen).not.toHaveBeenCalled();
  });
});
