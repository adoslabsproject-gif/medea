/**
 * Test 2026-grade — domain/data-source-ref.ts (typed ref + parsing).
 *
 * 🚨 BRAND TYPE: DataSourceRef è string & { __brand }. parse → narrow.
 *
 * 🚨 SECURITY ID REGEX:
 *    TENANT_ID_RE: [a-z0-9][a-z0-9_-]{0,62}/i (max 63, no leading dash)
 *    DB_ID_RE: [A-Za-z0-9_-]{1,64} (no leading constraint, 1-64)
 *    Bug regex = injection via tenant:'../bad':dbId
 *
 * 🚨 PARSE: split solo PRIMO ':' dopo "tenant:" — dbId può contenere ':'.
 *    Wait: DB_ID_RE non ammette ':'. Verifico.
 *
 * 🚨 engineSupportsRawSql: switch esaustivo, futuro engine → typecheck fail.
 *
 * 🚨 defaultSeverityForScope: system→critical, tenant→warning.
 */
import { describe, it, expect } from 'vitest';
import {
  SYSTEM_REF,
  systemRef,
  tenantRef,
  parseDataSourceRef,
  isDataSourceRef,
  scopeOf,
  engineSupportsRawSql,
  defaultSeverityForScope,
  type DataSourceRef,
  type DatabaseEngineId,
} from './data-source-ref.js';

describe('🚨 systemRef + SYSTEM_REF', () => {
  it('🚨 systemRef() ritorna "system"', () => {
    expect(systemRef()).toBe('system');
    expect(SYSTEM_REF).toBe('system');
  });

  it('🚨 parseDataSourceRef("system") → scope system', () => {
    const r = parseDataSourceRef(SYSTEM_REF);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.scope).toBe('system');
  });
});

describe('🚨 tenantRef — happy + validation', () => {
  it('🚨 tenantId + dbId validi → DataSourceRef formattato', () => {
    const r = tenantRef('senza1dio', 'mydb');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('tenant:senza1dio:mydb');
  });

  it('🚨 tenantId con underscore + numeri → ok', () => {
    const r = tenantRef('tenant_123', 'db');
    expect(r.ok).toBe(true);
  });

  it('🚨 tenantId con dash interno → ok (no leading)', () => {
    const r = tenantRef('a-b-c', 'db');
    expect(r.ok).toBe(true);
  });

  it('🚨 SECURITY: tenantId con leading dash → reject', () => {
    const r = tenantRef('-bad', 'db');
    expect(r.ok).toBe(false);
  });

  it('🚨 SECURITY: tenantId con ".." (path traversal) → reject', () => {
    const r = tenantRef('..', 'db');
    expect(r.ok).toBe(false);
  });

  it('🚨 SECURITY: tenantId con "/" → reject', () => {
    const r = tenantRef('a/b', 'db');
    expect(r.ok).toBe(false);
  });

  it('🚨 SECURITY: tenantId con ":" → reject', () => {
    const r = tenantRef('a:b', 'db');
    expect(r.ok).toBe(false);
  });

  it('🚨 SECURITY: tenantId con SQL injection char → reject', () => {
    const r = tenantRef("'; DROP--", 'db');
    expect(r.ok).toBe(false);
  });

  it('🚨 SECURITY: tenantId con spazio → reject', () => {
    expect(tenantRef('a b', 'db').ok).toBe(false);
  });

  it('🚨 SECURITY: tenantId > 63 char → reject', () => {
    const longId = 'a' + 'b'.repeat(63); // 64 chars (max 63)
    expect(tenantRef(longId, 'db').ok).toBe(false);
  });

  it('🚨 tenantId esattamente 63 char → ok (boundary)', () => {
    const at63 = 'a' + 'b'.repeat(62); // 63 chars
    expect(tenantRef(at63, 'db').ok).toBe(true);
  });

  it('🚨 tenantId vuoto → reject', () => {
    expect(tenantRef('', 'db').ok).toBe(false);
  });

  it('🚨 dbId valido → ok', () => {
    expect(tenantRef('t', 'db_1').ok).toBe(true);
    expect(tenantRef('t', 'DB-123').ok).toBe(true);
  });

  it('🚨 SECURITY: dbId con "/" → reject', () => {
    expect(tenantRef('t', 'db/etc').ok).toBe(false);
  });

  it('🚨 SECURITY: dbId con "../" → reject', () => {
    expect(tenantRef('t', '../etc').ok).toBe(false);
  });

  it('🚨 SECURITY: dbId con ":" → reject', () => {
    expect(tenantRef('t', 'a:b').ok).toBe(false);
  });

  it('🚨 SECURITY: dbId vuoto → reject', () => {
    expect(tenantRef('t', '').ok).toBe(false);
  });

  it('🚨 SECURITY: dbId > 64 char → reject', () => {
    const longDb = 'a'.repeat(65);
    expect(tenantRef('t', longDb).ok).toBe(false);
  });

  it('🚨 dbId esattamente 64 char → ok (boundary)', () => {
    expect(tenantRef('t', 'a'.repeat(64)).ok).toBe(true);
  });
});

describe('🚨 parseDataSourceRef — round-trip + edge', () => {
  it('🚨 round-trip tenant ref', () => {
    const built = tenantRef('mytenant', 'mydb');
    expect(built.ok).toBe(true);
    if (built.ok) {
      const parsed = parseDataSourceRef(built.value);
      expect(parsed.ok).toBe(true);
      if (parsed.ok && parsed.value.scope === 'tenant') {
        expect(parsed.value.tenantId).toBe('mytenant');
        expect(parsed.value.dbId).toBe('mydb');
      }
    }
  });

  it('🚨 ref sconosciuto (non system, no prefix) → reject', () => {
    const r = parseDataSourceRef('random_value');
    expect(r.ok).toBe(false);
  });

  it('🚨 tenant: senza secondo segmento → reject malformato', () => {
    const r = parseDataSourceRef('tenant:onlyone');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('malformato');
  });

  it('🚨 SECURITY: tenant: con tenantId invalido → reject', () => {
    const r = parseDataSourceRef('tenant:../etc:dbid');
    expect(r.ok).toBe(false);
  });

  it('🚨 SECURITY: tenant: con dbId invalido → reject', () => {
    const r = parseDataSourceRef('tenant:goodid:bad/dbid');
    expect(r.ok).toBe(false);
  });

  it('🚨 stringa vuota → reject', () => {
    expect(parseDataSourceRef('').ok).toBe(false);
  });
});

describe('🚨 isDataSourceRef — type guard', () => {
  it('🚨 string "system" → true', () => {
    expect(isDataSourceRef('system')).toBe(true);
  });

  it('🚨 string tenant valido → true', () => {
    expect(isDataSourceRef('tenant:abc:db1')).toBe(true);
  });

  it('🚨 string invalida → false', () => {
    expect(isDataSourceRef('garbage')).toBe(false);
    expect(isDataSourceRef('tenant:bad/id:db')).toBe(false);
  });

  it('🚨 SECURITY: non-string → false (no throw)', () => {
    expect(isDataSourceRef(null)).toBe(false);
    expect(isDataSourceRef(undefined)).toBe(false);
    expect(isDataSourceRef(42)).toBe(false);
    expect(isDataSourceRef({ scope: 'system' })).toBe(false);
    expect(isDataSourceRef([])).toBe(false);
  });
});

describe('🚨 scopeOf — graceful', () => {
  it('🚨 system ref → system', () => {
    expect(scopeOf(SYSTEM_REF)).toBe('system');
  });

  it('🚨 tenant ref valido → tenant', () => {
    const r = tenantRef('t', 'db');
    if (r.ok) expect(scopeOf(r.value)).toBe('tenant');
  });

  it('🚨 ref invalido → fallback tenant (no throw)', () => {
    // Type cheat: bypass brand
    expect(scopeOf('garbage' as DataSourceRef)).toBe('tenant');
  });
});

describe('🚨 engineSupportsRawSql — exhaustive switch', () => {
  it('🚨 SQL engines → true', () => {
    expect(engineSupportsRawSql('sqlite')).toBe(true);
    expect(engineSupportsRawSql('postgres')).toBe(true);
    expect(engineSupportsRawSql('mysql')).toBe(true);
    expect(engineSupportsRawSql('mssql')).toBe(true);
    expect(engineSupportsRawSql('duckdb')).toBe(true);
    expect(engineSupportsRawSql('pgvector')).toBe(true); // pg+ext
  });

  it('🚨 NO-SQL engines → false', () => {
    expect(engineSupportsRawSql('mongodb')).toBe(false);
    expect(engineSupportsRawSql('redis')).toBe(false);
    expect(engineSupportsRawSql('vector-embedded')).toBe(false);
    expect(engineSupportsRawSql('qdrant')).toBe(false);
  });

  it('🚨 typecheck-only: tutti i 10 engine coperti (no fall-through)', () => {
    const engines: DatabaseEngineId[] = [
      'sqlite',
      'postgres',
      'mysql',
      'mssql',
      'duckdb',
      'mongodb',
      'redis',
      'vector-embedded',
      'qdrant',
      'pgvector',
    ];
    // No throw on any
    for (const e of engines) {
      expect(typeof engineSupportsRawSql(e)).toBe('boolean');
    }
  });
});

describe('🚨 defaultSeverityForScope — suggest UI', () => {
  it('🚨 system → critical (blocco runtime)', () => {
    expect(defaultSeverityForScope('system')).toBe('critical');
  });

  it('🚨 tenant → warning (problema tenant business)', () => {
    expect(defaultSeverityForScope('tenant')).toBe('warning');
  });
});
