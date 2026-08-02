/**
 * Test 2026-grade — domain/detected-row.ts (immutable builder).
 *
 * 🚨 FROZEN: out + raw entrambi frozen → mutation accidentale impossibile.
 *
 * 🚨 tenantId BRANCH: conditional spread (presente vs assente) preserva semantica
 *    "undefined" → key NON enumerable (no `tenantId: undefined`).
 *
 * 🚨 raw shallow copy: mutation source DOPO build non corrompe oggetto.
 */
import { describe, it, expect } from 'vitest';
import { buildDetectedRow } from './detected-row.js';

describe('🚨 buildDetectedRow — happy', () => {
  it('🚨 con tenantId → output completo', () => {
    const r = buildDetectedRow({
      id: 'row-1',
      reason: 'corrupted',
      severity: 'critical',
      raw: { col_a: 1, col_b: 'x' },
      tenantId: 't1',
    });
    expect(r.id).toBe('row-1');
    expect(r.reason).toBe('corrupted');
    expect(r.severity).toBe('critical');
    expect(r.raw).toEqual({ col_a: 1, col_b: 'x' });
    expect(r.tenantId).toBe('t1');
  });

  it('🚨 senza tenantId → key OMESSA (no `tenantId: undefined`)', () => {
    const r = buildDetectedRow({
      id: 'row-2',
      reason: 'orphan',
      severity: 'warning',
      raw: { x: 1 },
    });
    expect(r.tenantId).toBeUndefined();
    expect('tenantId' in r).toBe(false); // key NOT enumerable
  });
});

describe('🚨 buildDetectedRow — immutability', () => {
  it('🚨 output frozen', () => {
    const r = buildDetectedRow({
      id: '1',
      reason: 'r',
      severity: 'critical',
      raw: {},
    });
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('🚨 raw frozen (deep)', () => {
    const r = buildDetectedRow({
      id: '1',
      reason: 'r',
      severity: 'critical',
      raw: { a: 1 },
    });
    expect(Object.isFrozen(r.raw)).toBe(true);
  });

  it('🚨 SECURITY: mutation root DetectedRow → throw strict', () => {
    'use strict';
    const r = buildDetectedRow({
      id: '1',
      reason: 'r',
      severity: 'critical',
      raw: {},
    });
    expect(() => {
      (r as { id: string }).id = 'hacked';
    }).toThrow();
  });

  it('🚨 SECURITY: mutation raw → throw strict', () => {
    'use strict';
    const r = buildDetectedRow({
      id: '1',
      reason: 'r',
      severity: 'critical',
      raw: { x: 1 },
    });
    expect(() => {
      (r.raw as Record<string, unknown>).x = 999;
    }).toThrow();
  });

  it('🚨 SECURITY: mutation raw SOURCE dopo build → no leak', () => {
    const source = { sensitive: 'before' };
    const r = buildDetectedRow({
      id: '1',
      reason: 'r',
      severity: 'critical',
      raw: source,
    });
    source.sensitive = 'mutated';
    expect((r.raw as Record<string, unknown>).sensitive).toBe('before');
  });
});

describe('🚨 buildDetectedRow — variants', () => {
  it('🚨 severity warning', () => {
    const r = buildDetectedRow({
      id: '1',
      reason: 'r',
      severity: 'warning',
      raw: {},
    });
    expect(r.severity).toBe('warning');
  });

  it('🚨 reason in italiano (UI/audit)', () => {
    const r = buildDetectedRow({
      id: '1',
      reason: 'Riga orfana: parent_id non esiste',
      severity: 'critical',
      raw: {},
    });
    expect(r.reason).toContain('orfana');
  });

  it('🚨 id PK numerico stringificato', () => {
    const r = buildDetectedRow({
      id: '12345',
      reason: 'r',
      severity: 'critical',
      raw: {},
    });
    expect(typeof r.id).toBe('string');
  });

  it('🚨 id UUID accepted', () => {
    const r = buildDetectedRow({
      id: 'ab1234ef-1234-1234-1234-abcdef123456',
      reason: 'r',
      severity: 'critical',
      raw: {},
    });
    expect(r.id).toContain('-');
  });

  it('🚨 raw con tutte le colonne (snapshot completo per restore)', () => {
    const fullRow = {
      id: 1,
      name: 'foo',
      created_at: '2026-01-01',
      meta: { nested: true },
    };
    const r = buildDetectedRow({
      id: '1',
      reason: 'r',
      severity: 'critical',
      raw: fullRow,
    });
    expect(Object.keys(r.raw)).toHaveLength(4);
  });

  it('🚨 raw vuoto ammesso (regola può non avere raw context)', () => {
    const r = buildDetectedRow({
      id: '1',
      reason: 'r',
      severity: 'critical',
      raw: {},
    });
    expect(r.raw).toEqual({});
  });
});
