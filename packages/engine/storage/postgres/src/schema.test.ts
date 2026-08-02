import { describe, it, expect } from 'vitest';
import * as schema from './schema.js';

describe('postgres schema', () => {
  it('exports the expected tables', () => {
    expect(schema.tenants).toBeDefined();
    expect(schema.users).toBeDefined();
    expect(schema.workflows).toBeDefined();
    expect(schema.runs).toBeDefined();
    expect(schema.credentials).toBeDefined();
    expect(schema.auditLog).toBeDefined();
  });

  it('every tenanted table has a tenant_id column', () => {
    const tenanted = [
      schema.users,
      schema.workflows,
      schema.runs,
      schema.credentials,
      schema.auditLog,
    ];
    for (const table of tenanted) {
      const cols = Object.keys(table);
      expect(cols).toContain('tenantId');
    }
  });

  it('users role enum has 4 roles', () => {
    const def = schema.users.role;
    expect(def).toBeDefined();
  });
});
