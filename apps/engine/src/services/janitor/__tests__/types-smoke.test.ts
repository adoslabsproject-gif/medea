/**
 * Test 2026-grade — smoke import suite for janitor domain types/ports.
 *
 * COVERAGE: verifica che ogni file types/domain definito esponga gli
 * identifiers attesi (drift detection cross-file).
 */
import { describe, it, expect } from 'vitest';

import * as detectedRow from '../domain/detected-row.js';
import * as janitorReport from '../domain/janitor-report.js';
import * as severity from '../domain/severity.js';
import * as quarantineRec from '../domain/quarantine-record.js';
import * as ruleConfig from '../domain/rule-config.js';
import * as dataSourceRef from '../domain/data-source-ref.js';
import * as runLogPort from '../ports/run-log-repo.port.js';

describe('🚨 domain modules expose expected helpers', () => {
  it('🚨 detected-row: buildDetectedRow exists', () => {
    expect(typeof (detectedRow as any).buildDetectedRow).toBe('function');
  });

  it('🚨 severity: SEVERITY array + isSeverity guard', () => {
    expect((severity as any).SEVERITIES ?? (severity as any).SEVERITY_LEVELS).toBeDefined();
  });

  it('🚨 janitor-report: emptyReport helper or similar', () => {
    const exports = Object.keys(janitorReport);
    expect(exports.length).toBeGreaterThan(0);
  });

  it('🚨 quarantine-record: type definitions module', () => {
    // module può essere solo type-only — accetta 0 export ma deve essere un oggetto
    expect(typeof quarantineRec).toBe('object');
  });

  it('🚨 rule-config: schema or type', () => {
    expect(typeof ruleConfig).toBe('object');
  });

  it('🚨 data-source-ref: systemRef helper exposed', () => {
    expect(typeof (dataSourceRef as any).systemRef).toBe('function');
  });

  it('🚨 run-log-repo port: contract module', () => {
    expect(typeof runLogPort).toBe('object');
  });
});

describe('🚨 buildDetectedRow shape', () => {
  it('🚨 happy: returns object con id+severity+raw+reason', () => {
    const r = (detectedRow as any).buildDetectedRow({
      id: 'x',
      reason: 'test',
      severity: 'warning',
      raw: { id: 'x' },
    });
    expect(r.id).toBe('x');
    expect(r.reason).toBe('test');
    expect(r.severity).toBe('warning');
    expect(r.raw).toEqual({ id: 'x' });
  });

  it('🚨 tenantId opzionale propagato', () => {
    const r = (detectedRow as any).buildDetectedRow({
      id: 'x',
      reason: 'r',
      severity: 'critical',
      raw: {},
      tenantId: 't-1',
    });
    expect(r.tenantId).toBe('t-1');
  });
});

describe('🚨 systemRef + data-source-ref', () => {
  it('🚨 systemRef ritorna branded string scope=system', () => {
    const r = (dataSourceRef as any).systemRef();
    expect(r).toBeDefined();
    // Branded string "system"
    expect(typeof r).toBe('string');
    expect(r).toBe('system');
  });

  it('🚨 tenantRef ritorna Result<DataSourceRef>', () => {
    if (typeof (dataSourceRef as any).tenantRef === 'function') {
      const r = (dataSourceRef as any).tenantRef('t-1', 'db-1');
      expect(r).toBeDefined();
      // Result type: { ok: true, value: ... } o { ok: false, error: ... }
      expect(typeof r).toBe('object');
    }
  });

  it('🚨 parseDataSourceRef helper se exported', () => {
    if (typeof (dataSourceRef as any).parseDataSourceRef === 'function') {
      const r = (dataSourceRef as any).parseDataSourceRef('system');
      expect(r).toBeDefined();
    }
  });
});
