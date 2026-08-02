/**
 * Test 2026-grade — janitor/domain/rule.ts (type guards + ID validation).
 *
 * 🚨 ID ENFORCEMENT: code rules `<scope>.<table>.<problem>` lowercase
 *    snake. DSL rules `dsl_<nanoid 6-32>`. Bug = rule clash o lookup
 *    fail.
 *
 * 🚨 KIND DISCRIMINATOR: isCodeRule/isDslRule per type narrowing safe.
 */
import { describe, it, expect } from 'vitest';
import {
  isCodeRule,
  isDslRule,
  isValidRuleId,
  CODE_RULE_ID_RE,
  DSL_RULE_ID_RE,
  type Rule,
  type CodeRule,
  type DslRule,
} from './rule.js';

const codeRule: CodeRule = {
  kind: 'code',
  id: 'erp.invoices.orphan_lines',
  title: 'x',
  description: 'd',
  defaultDataSource: { kind: 'sqlite', name: 'main' } as never,
  targetTable: 't',
  targetPkColumn: 'id',
  tags: [],
  paramsSchema: [],
  defaultSeverity: 'low' as never,
  defaultSchedule: '0 * * * *',
  defaultMaxRowsPerRun: 1000,
  detect: async () => [],
};

const dslRule: DslRule = {
  kind: 'dsl',
  id: 'dsl_abc123',
  tenantId: 'tenant-1',
  title: 'd',
  description: 'd',
  dataSourceRef: { kind: 'sqlite', name: 'main' } as never,
  targetTable: 't',
  targetPkColumn: 'id',
  detectSql: 'SELECT * FROM t',
  placeholders: {},
  tags: [],
  defaultSeverity: 'low' as never,
  defaultSchedule: '0 * * * *',
  defaultMaxRowsPerRun: 1000,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

describe('🚨 isCodeRule / isDslRule type guards', () => {
  it('🚨 code rule → isCodeRule=true', () => {
    expect(isCodeRule(codeRule)).toBe(true);
    expect(isDslRule(codeRule)).toBe(false);
  });

  it('🚨 dsl rule → isDslRule=true', () => {
    expect(isDslRule(dslRule)).toBe(true);
    expect(isCodeRule(dslRule)).toBe(false);
  });

  it('🚨 type narrowing dopo guard', () => {
    const r: Rule = codeRule;
    if (isCodeRule(r)) {
      // TS narrowing → accesso a paramsSchema (solo CodeRule)
      expect(r.paramsSchema).toBeDefined();
    }
    const r2: Rule = dslRule;
    if (isDslRule(r2)) {
      expect(r2.tenantId).toBeDefined();
    }
  });
});

describe('🚨 CODE_RULE_ID_RE', () => {
  it('🚨 valid format <scope>.<table>.<problem> lowercase', () => {
    expect(CODE_RULE_ID_RE.test('erp.invoices.orphan_lines')).toBe(true);
    expect(CODE_RULE_ID_RE.test('audit.logs.gap_detection')).toBe(true);
    expect(CODE_RULE_ID_RE.test('a.b.c')).toBe(true);
  });

  it('🚨 reject UPPERCASE', () => {
    expect(CODE_RULE_ID_RE.test('ERP.invoices.x')).toBe(false);
    expect(CODE_RULE_ID_RE.test('erp.Invoices.x')).toBe(false);
  });

  it('🚨 reject dashes (use underscore)', () => {
    expect(CODE_RULE_ID_RE.test('erp.invoices.orphan-lines')).toBe(false);
  });

  it('🚨 reject missing dots / wrong segments', () => {
    expect(CODE_RULE_ID_RE.test('erp_invoices_x')).toBe(false);
    expect(CODE_RULE_ID_RE.test('erp.invoices')).toBe(false); // solo 2 segmenti
    expect(CODE_RULE_ID_RE.test('erp.invoices.orphan.extra')).toBe(false); // 4 segmenti
  });

  it('🚨 reject starting digit', () => {
    expect(CODE_RULE_ID_RE.test('1erp.invoices.x')).toBe(false);
  });

  it('🚨 dsl_ prefix non valida CODE_RULE_ID_RE', () => {
    expect(CODE_RULE_ID_RE.test('dsl_abc123')).toBe(false);
  });
});

describe('🚨 DSL_RULE_ID_RE', () => {
  it('🚨 valid format dsl_<6-32 chars>', () => {
    expect(DSL_RULE_ID_RE.test('dsl_abc123')).toBe(true);
    expect(DSL_RULE_ID_RE.test('dsl_ABC123def-UVW')).toBe(true);
    expect(DSL_RULE_ID_RE.test('dsl_aaaaaa')).toBe(true); // 6 char min
    expect(DSL_RULE_ID_RE.test('dsl_' + 'a'.repeat(32))).toBe(true); // 32 max
  });

  it('🚨 reject < 6 chars dopo dsl_', () => {
    expect(DSL_RULE_ID_RE.test('dsl_abc')).toBe(false);
    expect(DSL_RULE_ID_RE.test('dsl_a')).toBe(false);
  });

  it('🚨 reject > 32 chars dopo dsl_', () => {
    expect(DSL_RULE_ID_RE.test('dsl_' + 'a'.repeat(33))).toBe(false);
  });

  it('🚨 reject missing dsl_ prefix', () => {
    expect(DSL_RULE_ID_RE.test('abc123')).toBe(false);
    expect(DSL_RULE_ID_RE.test('code.x.y')).toBe(false);
  });

  it('🚨 reject invalid chars (dots, spaces)', () => {
    expect(DSL_RULE_ID_RE.test('dsl_abc.123')).toBe(false);
    expect(DSL_RULE_ID_RE.test('dsl_abc 123')).toBe(false);
  });
});

describe('🚨 isValidRuleId combined check', () => {
  it('🚨 code rule id valid', () => {
    expect(isValidRuleId('erp.invoices.orphan_lines')).toBe(true);
  });

  it('🚨 dsl rule id valid', () => {
    expect(isValidRuleId('dsl_abc12345')).toBe(true);
  });

  it('🚨 invalid both → false', () => {
    expect(isValidRuleId('random-id')).toBe(false);
    expect(isValidRuleId('UPPER.case.x')).toBe(false);
    expect(isValidRuleId('dsl_x')).toBe(false); // too short
    expect(isValidRuleId('')).toBe(false);
  });
});
