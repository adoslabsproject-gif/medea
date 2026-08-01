/**
 * Test 2026-grade — domain/rule-config.ts (RuleConfig factory).
 *
 * 🚨 makeDefaultRuleConfig: oggetto frozen DEEP (params frozen too).
 *    Bug = mutation accidentale config tenant compromette altre rules.
 *
 * 🚨 updatedAt = ISO 8601 valido (no Date instance, no timestamp).
 *
 * 🚨 enabled=true di default (regola attiva immediatamente per tenant).
 *
 * 🚨 notifyOnDetection=false di default (opt-in al notification flood).
 */
import { describe, it, expect } from 'vitest';
import { makeDefaultRuleConfig } from './rule-config.js';
import { SYSTEM_REF } from './data-source-ref.js';

const baseArgs = {
  ruleId: 'runs.zombie',
  tenantId: 't1',
  defaultSchedule: '0 * * * *',
  defaultDataSource: SYSTEM_REF,
  defaultMaxRowsPerRun: 100,
  defaultSeverity: 'critical' as const,
  defaultParams: { threshold: 30 },
};

describe('🚨 makeDefaultRuleConfig — happy', () => {
  it('🚨 ritorna oggetto con tutti i campi obbligatori', () => {
    const c = makeDefaultRuleConfig(baseArgs);
    expect(c.ruleId).toBe('runs.zombie');
    expect(c.tenantId).toBe('t1');
    expect(c.schedule).toBe('0 * * * *');
    expect(c.dataSourceRef).toBe(SYSTEM_REF);
    expect(c.maxRowsPerRun).toBe(100);
    expect(c.severity).toBe('critical');
    expect(c.params).toEqual({ threshold: 30 });
  });

  it('🚨 enabled=true di default (regola ATTIVA per tenant)', () => {
    const c = makeDefaultRuleConfig(baseArgs);
    expect(c.enabled).toBe(true);
  });

  it('🚨 notifyOnDetection=false di default (opt-in flood notif)', () => {
    const c = makeDefaultRuleConfig(baseArgs);
    expect(c.notifyOnDetection).toBe(false);
  });

  it('🚨 updatedAt = ISO 8601 string', () => {
    const c = makeDefaultRuleConfig(baseArgs);
    expect(c.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Parsable
    expect(new Date(c.updatedAt).toString()).not.toBe('Invalid Date');
  });

  it('🚨 updatedAt ≈ now (entro 2s)', () => {
    const before = Date.now();
    const c = makeDefaultRuleConfig(baseArgs);
    const ts = new Date(c.updatedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before - 100);
    expect(ts).toBeLessThan(before + 2000);
  });

  it('🚨 updatedBy NON settato (default factory)', () => {
    const c = makeDefaultRuleConfig(baseArgs);
    expect(c.updatedBy).toBeUndefined();
  });
});

describe('🚨 makeDefaultRuleConfig — immutability', () => {
  it('🚨 oggetto root frozen', () => {
    const c = makeDefaultRuleConfig(baseArgs);
    expect(Object.isFrozen(c)).toBe(true);
  });

  it('🚨 params frozen (deep, no shallow leak)', () => {
    const c = makeDefaultRuleConfig(baseArgs);
    expect(Object.isFrozen(c.params)).toBe(true);
  });

  it('🚨 SECURITY: mutation defaultParams source NON propaga', () => {
    const mutableSource = { threshold: 30 };
    const c = makeDefaultRuleConfig({ ...baseArgs, defaultParams: mutableSource });
    mutableSource.threshold = 999;
    expect((c.params as Record<string, unknown>).threshold).toBe(30);
  });

  it('🚨 SECURITY: mutation params output → throw strict (frozen)', () => {
    'use strict';
    const c = makeDefaultRuleConfig(baseArgs);
    expect(() => {
      (c as { ruleId: string }).ruleId = 'hacked';
    }).toThrow();
  });
});

describe('🚨 makeDefaultRuleConfig — variantI', () => {
  it('🚨 warning severity', () => {
    const c = makeDefaultRuleConfig({ ...baseArgs, defaultSeverity: 'warning' });
    expect(c.severity).toBe('warning');
  });

  it('🚨 params vuoti', () => {
    const c = makeDefaultRuleConfig({ ...baseArgs, defaultParams: {} });
    expect(c.params).toEqual({});
    expect(Object.isFrozen(c.params)).toBe(true);
  });

  it('🚨 params con valori complessi', () => {
    const complex = { num: 42, str: 'x', bool: true, nested: { a: 1 } };
    const c = makeDefaultRuleConfig({ ...baseArgs, defaultParams: complex });
    expect(c.params).toEqual(complex);
  });

  it('🚨 maxRowsPerRun=0 ammesso (factory non valida)', () => {
    const c = makeDefaultRuleConfig({ ...baseArgs, defaultMaxRowsPerRun: 0 });
    expect(c.maxRowsPerRun).toBe(0);
  });
});
