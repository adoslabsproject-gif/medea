/**
 * Test 2026-grade — TenantAiPreferencesService.
 *
 * Coverage REALE su :memory: SQLite (no smoke):
 *  - get/set roundtrip allowLiara + defaultLlmProvider
 *  - defaults when row missing (allowLiara=true, defaultLlmProvider=null)
 *  - resolveDefaultProvider priority chain:
 *     (1) explicit preference honored only if still usable
 *     (2) first external configured provider as fallback
 *     (3) liara as last resort when allowed
 *     (4) null when nothing is available
 *  - Liara two-tier disable (env + per-tenant) reflected in resolution
 *  - tenant isolation (preferenze tenantA non leakano a tenantB)
 *  - empty/whitespace default_llm_provider normalizzato a null
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const m = vi.hoisted(() => ({
  db: null as Database.Database | null,
  liaraEnabled: true,
}));

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: m.db! }),
}));

vi.mock('@/config.js', () => ({
  isLiaraEnabled: () => m.liaraEnabled,
}));

import { TenantAiPreferencesService } from './tenant-ai-preferences.service.js';

beforeEach(() => {
  m.db = new Database(':memory:');
  m.db.exec(`
    CREATE TABLE tenant_ai_preferences (
      tenant_id TEXT PRIMARY KEY,
      allow_liara INTEGER NOT NULL DEFAULT 1,
      default_llm_provider TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  m.liaraEnabled = true;
});

describe('get — defaults', () => {
  it('row missing → allowLiara=true, defaultLlmProvider=null', () => {
    const svc = new TenantAiPreferencesService();
    expect(svc.get('t1')).toEqual({ allowLiara: true, defaultLlmProvider: null });
  });

  it('row present → riflette i valori persistiti', () => {
    m.db!.prepare('INSERT INTO tenant_ai_preferences (tenant_id, allow_liara, default_llm_provider, updated_at) VALUES (?, ?, ?, ?)')
      .run('t1', 0, 'anthropic', '2026-06-07T00:00:00.000Z');
    const svc = new TenantAiPreferencesService();
    expect(svc.get('t1')).toEqual({ allowLiara: false, defaultLlmProvider: 'anthropic' });
  });

  it('default_llm_provider whitespace → normalizzato a null (sanity)', () => {
    m.db!.prepare('INSERT INTO tenant_ai_preferences (tenant_id, allow_liara, default_llm_provider, updated_at) VALUES (?, ?, ?, ?)')
      .run('t1', 1, '   ', '2026-06-07T00:00:00.000Z');
    const svc = new TenantAiPreferencesService();
    expect(svc.get('t1').defaultLlmProvider).toBeNull();
  });
});

describe('set — upsert + partial updates', () => {
  it('upsert inserisce nuova riga + valori persistiti', () => {
    const svc = new TenantAiPreferencesService();
    svc.set('t1', { allowLiara: false, defaultLlmProvider: 'openai' });
    expect(svc.get('t1')).toEqual({ allowLiara: false, defaultLlmProvider: 'openai' });
  });

  it('set parziale preserva il resto (solo defaultLlmProvider)', () => {
    const svc = new TenantAiPreferencesService();
    svc.set('t1', { allowLiara: false, defaultLlmProvider: 'openai' });
    svc.set('t1', { defaultLlmProvider: 'liara' });
    expect(svc.get('t1')).toEqual({ allowLiara: false, defaultLlmProvider: 'liara' });
  });

  it('set parziale preserva il resto (solo allowLiara)', () => {
    const svc = new TenantAiPreferencesService();
    svc.set('t1', { allowLiara: false, defaultLlmProvider: 'openai' });
    svc.set('t1', { allowLiara: true });
    expect(svc.get('t1')).toEqual({ allowLiara: true, defaultLlmProvider: 'openai' });
  });

  it('set defaultLlmProvider=null azzera esplicitamente', () => {
    const svc = new TenantAiPreferencesService();
    svc.set('t1', { defaultLlmProvider: 'openai' });
    svc.set('t1', { defaultLlmProvider: null });
    expect(svc.get('t1').defaultLlmProvider).toBeNull();
  });
});

describe('resolveDefaultProvider — priority chain', () => {
  it('1. preferenza esplicita usabile → vince', () => {
    const svc = new TenantAiPreferencesService();
    svc.set('t1', { defaultLlmProvider: 'anthropic' });
    expect(
      svc.resolveDefaultProvider('t1', [
        { provider: 'anthropic', hasKey: true },
        { provider: 'openai', hasKey: true },
      ]),
    ).toBe('anthropic');
  });

  it('1.b preferenza esplicita NON usabile (no key) → fallback al next external', () => {
    const svc = new TenantAiPreferencesService();
    svc.set('t1', { defaultLlmProvider: 'anthropic' });
    expect(
      svc.resolveDefaultProvider('t1', [
        { provider: 'anthropic', hasKey: false },
        { provider: 'openai', hasKey: true },
      ]),
    ).toBe('openai');
  });

  it('2. nessuna preferenza, external configurato → primo external', () => {
    const svc = new TenantAiPreferencesService();
    expect(
      svc.resolveDefaultProvider('t1', [
        { provider: 'openai', hasKey: true },
        { provider: 'anthropic', hasKey: true },
      ]),
    ).toBe('openai');
  });

  it('3. nessun external + Liara abilitato → liara', () => {
    const svc = new TenantAiPreferencesService();
    expect(svc.resolveDefaultProvider('t1', [])).toBe('liara');
  });

  it('4. nessun external + Liara globalmente disabilitato → null', () => {
    m.liaraEnabled = false;
    const svc = new TenantAiPreferencesService();
    expect(svc.resolveDefaultProvider('t1', [])).toBeNull();
  });

  it('4.b nessun external + Liara per-tenant disabilitato → null', () => {
    const svc = new TenantAiPreferencesService();
    svc.set('t1', { allowLiara: false });
    expect(svc.resolveDefaultProvider('t1', [])).toBeNull();
  });

  it('🚨 [bug 2026-06-17] default=liara MA liara disattivato per-tenant → NON resta liara (fallback external)', () => {
    const svc = new TenantAiPreferencesService();
    svc.set('t1', { allowLiara: false, defaultLlmProvider: 'liara' });
    // liara è nei configuredProviders con hasKey=true (free-tier) ma è DISATTIVATO:
    // NON deve essere onorato come default → ricade sull'external con key.
    expect(
      svc.resolveDefaultProvider('t1', [
        { provider: 'liara', hasKey: true },
        { provider: 'anthropic', hasKey: true },
      ]),
    ).toBe('anthropic');
  });

  it('🚨 default=liara, liara disattivato, NESSUN external → null (mai liara spento come default)', () => {
    const svc = new TenantAiPreferencesService();
    svc.set('t1', { allowLiara: false, defaultLlmProvider: 'liara' });
    expect(svc.resolveDefaultProvider('t1', [{ provider: 'liara', hasKey: true }])).toBeNull();
  });

  it('preferenza esplicita = liara + Liara enabled → liara anche se ci sono external', () => {
    const svc = new TenantAiPreferencesService();
    svc.set('t1', { defaultLlmProvider: 'liara' });
    expect(
      svc.resolveDefaultProvider('t1', [
        { provider: 'openai', hasKey: true },
        { provider: 'anthropic', hasKey: true },
      ]),
    ).toBe('liara');
  });

  it('preferenza esplicita = liara + Liara disabilitato → fallback external (la preferenza non è più usable)', () => {
    m.liaraEnabled = false;
    const svc = new TenantAiPreferencesService();
    svc.set('t1', { defaultLlmProvider: 'liara' });
    expect(
      svc.resolveDefaultProvider('t1', [
        { provider: 'openai', hasKey: true },
      ]),
    ).toBe('openai');
  });
});

describe('isLiaraAllowedForTenant — two-tier AND', () => {
  it('global ON + tenant ON → true', () => {
    const svc = new TenantAiPreferencesService();
    expect(svc.isLiaraAllowedForTenant('t1')).toBe(true);
  });

  it('global OFF (env) → false anche se tenant ON', () => {
    m.liaraEnabled = false;
    const svc = new TenantAiPreferencesService();
    expect(svc.isLiaraAllowedForTenant('t1')).toBe(false);
  });

  it('global ON + tenant OFF → false', () => {
    const svc = new TenantAiPreferencesService();
    svc.set('t1', { allowLiara: false });
    expect(svc.isLiaraAllowedForTenant('t1')).toBe(false);
  });
});

describe('tenant isolation', () => {
  it('preferenze tenantA non leakano a tenantB', () => {
    const svc = new TenantAiPreferencesService();
    svc.set('tenantA', { defaultLlmProvider: 'anthropic', allowLiara: false });
    expect(svc.get('tenantA')).toEqual({ defaultLlmProvider: 'anthropic', allowLiara: false });
    expect(svc.get('tenantB')).toEqual({ defaultLlmProvider: null, allowLiara: true });
  });
});
