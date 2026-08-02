/**
 * tenant-context — test format + edge cases.
 *
 * `buildTenantContext` richiede DB SQLite live → test in service.test
 * dedicato qui solo formatter (pure function) per coverage rapido.
 */
import { describe, it, expect, vi } from 'vitest';

// ── Mock delle dipendenze service di buildTenantContext (istanziate a import) ──
const h = vi.hoisted(() => ({ dbList: [] as unknown[] }));
vi.mock('@/services/db-studio.service.js', () => ({
  DbStudioService: class {
    list(): unknown[] {
      return h.dbList;
    }
  },
}));
vi.mock('@/services/system-email-accounts.service.js', () => ({
  SystemEmailAccountsService: class {
    picker(): unknown[] {
      return [];
    }
  },
}));
vi.mock('@/services/llm-providers.service.js', () => ({
  LlmProvidersService: class {
    list(): unknown[] {
      return [];
    }
  },
}));
vi.mock('@/services/tenant-ai-preferences.service.js', () => ({
  tenantAiPreferences: { resolveDefaultProvider: (): string | null => null },
}));
vi.mock('@/lib/logger.js');

import {
  buildTenantContext,
  formatTenantContextForPrompt,
  type TenantContextResources,
} from './tenant-context.js';

/** Helper: empty context with the new (2026-06-07) fields zeroed. */
function empty(overrides: Partial<TenantContextResources> = {}): TenantContextResources {
  return {
    databases: [],
    emailAccounts: [],
    defaultLlmProvider: null,
    llmProviders: [],
    ...overrides,
  };
}

describe('formatTenantContextForPrompt', () => {
  it('contesto vuoto → stringa vuota (no injection)', () => {
    expect(formatTenantContextForPrompt(empty())).toBe('');
  });

  it('solo databases → include section DB + regole', () => {
    const ctx = empty({
      databases: [
        {
          id: 'QhktHRtIKHL5aniYhgRvz',
          name: 'Main',
          description: 'production logs',
          tables: ['users', 'orders'],
          columns: {},
          writable: true,
        },
        {
          id: 'XYZ123ABC456DEF789GH',
          name: 'Analytics',
          description: null,
          tables: [],
          columns: {},
          writable: true,
        },
      ],
    });
    const s = formatTenantContextForPrompt(ctx);
    expect(s).toContain('RISORSE REALI DEL TENANT');
    expect(s).toContain('QhktHRtIKHL5aniYhgRvz');
    expect(s).toContain('production logs');
    expect(s).toContain('Analytics');
    expect(s).toContain('NON inventare');
    expect(s).not.toContain('Email accounts disponibili'); // no email section
  });

  it('solo email accounts → include section email + regole', () => {
    const ctx = empty({
      emailAccounts: [
        { id: 'uuid-1', label: 'Info Zeli', fromAddress: 'info@zeli.it', isDefault: true },
        { id: 'uuid-2', label: 'Support', fromAddress: 'support@zeli.it', isDefault: false },
      ],
    });
    const s = formatTenantContextForPrompt(ctx);
    expect(s).toContain('Email accounts disponibili');
    expect(s).toContain('info@zeli.it');
    expect(s).toContain('[DEFAULT]');
    expect(s).toContain('support@zeli.it');
    expect(s).not.toContain('DB LOCALI');
    expect(s).not.toContain('DB ESTERNI');
  });

  it('entrambi presenti → include entrambe section', () => {
    const ctx = empty({
      databases: [
        { id: 'db-1', name: 'X', description: null, tables: [], columns: {}, writable: true },
      ],
      emailAccounts: [{ id: 'em-1', label: 'L', fromAddress: 'a@b.io', isDefault: true }],
    });
    const s = formatTenantContextForPrompt(ctx);
    expect(s).toContain('DB LOCALI SCRIVIBILI');
    expect(s).toContain('Email accounts disponibili');
    expect(s).toContain('REGOLE FERREE');
  });

  it('regole ferree menzionano secrets + NON inventare', () => {
    const ctx = empty({
      databases: [
        { id: 'db', name: 'D', description: null, tables: [], columns: {}, writable: true },
      ],
    });
    const s = formatTenantContextForPrompt(ctx);
    expect(s).toContain('{{secrets.');
    expect(s).toContain('MAI placeholder');
  });

  it('default LLM provider impostato → bloccato verbatim nel prompt', () => {
    const ctx = empty({
      defaultLlmProvider: 'liara',
      llmProviders: [{ provider: 'liara', hasKey: true }],
    });
    const s = formatTenantContextForPrompt(ctx);
    expect(s).toContain('LLM provider DI DEFAULT');
    expect(s).toContain('liara');
    // Hard rule: model vuoto, no apiKey hard-coded, no guess gpt-4o
    expect(s).toContain('`config.model` lascialo VUOTO');
    expect(s).toContain('NIENTE `apiKey` hard-coded');
    expect(s).toContain('NIENTE guess di "gpt-4o"');
  });

  it('default LLM provider null + nessun provider → istruzioni ABORT', () => {
    const ctx = empty({ defaultLlmProvider: null, llmProviders: [] });
    // No DB/email either, ma c'è una sezione provider con ABORT message.
    // Per coprire l'edge case dove ci sono DB ma non LLM:
    const ctxWithDb = empty({
      databases: [
        { id: 'd', name: 'D', description: null, tables: [], columns: {}, writable: true },
      ],
      defaultLlmProvider: null,
      llmProviders: [],
    });
    const s = formatTenantContextForPrompt(ctxWithDb);
    expect(s).toContain('NESSUNO configurato');
    expect(s).toContain('ABORT');
    // Empty ctx (no databases, no email, no provider) still produces empty string.
    expect(formatTenantContextForPrompt(ctx)).toBe('');
  });

  // ── #3 GROUNDING SCHEMA REALE: writable (locale) vs read-only (esterno) ──
  // Bug senza1dio 2026-06-16: unico DB = NHA Postgres remoto read-only → il
  // grounding lo listava come scrivibile → il modello pescava `admin_url_secrets`.
  it('🚨 DB locale writable + DB remoto read-only → sezioni SEPARATE, regole corrette', () => {
    const ctx = empty({
      databases: [
        {
          id: 'local-1',
          name: 'WorkflowData',
          description: null,
          tables: ['rss_sources'],
          columns: {},
          writable: true,
        },
        {
          id: 'nha-remote',
          name: 'NHA',
          description: 'crm esterno',
          tables: ['admin_url_secrets', 'clienti'],
          columns: {},
          writable: false,
        },
      ],
    });
    const s = formatTenantContextForPrompt(ctx);
    // sezioni separate
    expect(s).toContain('DB LOCALI SCRIVIBILI');
    expect(s).toContain('DB ESTERNI — SOLO LETTURA');
    // il remoto è marcato READ-ONLY e le sue tabelle sono "solo per db_query in lettura"
    const readonlyIdx = s.indexOf('DB ESTERNI');
    expect(s.indexOf('nha-remote')).toBeGreaterThan(readonlyIdx); // NHA sta sotto la sezione read-only
    expect(s).toContain('[READ-ONLY]');
    // la regola hard nomina esplicitamente il caso reale
    expect(s).toContain('admin_url_secrets');
    expect(s).toContain('MAI in un DB [READ-ONLY]');
  });

  it('🚨 SOLO DB remoto read-only (caso senza1dio) → NIENTE DB scrivibili + istruzione a creare locale', () => {
    const ctx = empty({
      databases: [
        {
          id: 'nha',
          name: 'NHA',
          description: null,
          tables: ['admin_url_secrets'],
          columns: {},
          writable: false,
        },
      ],
    });
    const s = formatTenantContextForPrompt(ctx);
    expect(s).toContain('DB LOCALI SCRIVIBILI:** NESSUNO');
    expect(s).toContain('il sistema creerà automaticamente un DB locale');
    expect(s).toContain('DB ESTERNI — SOLO LETTURA');
    // la tabella admin di NHA NON deve essere presentata come scrivibile
    expect(s).toContain('[READ-ONLY]');
  });

  it('provider esterno + più provider configurati → lista completa nel prompt', () => {
    const ctx = empty({
      defaultLlmProvider: 'anthropic',
      llmProviders: [
        { provider: 'anthropic', hasKey: true },
        { provider: 'openai', hasKey: true },
        { provider: 'liara', hasKey: true },
      ],
    });
    const s = formatTenantContextForPrompt(ctx);
    expect(s).toContain('DEFAULT: `anthropic`');
    expect(s).toContain('"anthropic"');
    expect(s).toContain('"openai"');
    expect(s).toContain('"liara"');
  });
});

describe('buildTenantContext — estrazione colonne (per DB_COLUMN_NOT_IN_SCHEMA)', () => {
  it('estrae nomi-colonna da tables[].columns[].name', () => {
    h.dbList = [
      {
        id: 'QhktHRtIKHL5aniYhgRvz',
        name: 'User DB',
        description: 'tenant data',
        tables: [
          {
            name: 'price_monitoring',
            columns: [
              { name: 'id', type: 'text' },
              { name: 'url', type: 'text' },
              { name: 'price', type: 'decimal' },
              { name: 'median_price', type: 'decimal' },
              { name: 'timestamp', type: 'text' },
            ],
          },
          {
            name: 'customers',
            columns: [
              { name: 'id', type: 'uuid' },
              { name: 'email', type: 'text' },
            ],
          },
        ],
      },
    ];
    const ctx = buildTenantContext('default');
    expect(ctx.databases).toHaveLength(1);
    const db = ctx.databases[0]!;
    expect(db.tables).toEqual(['price_monitoring', 'customers']);
    // La mappa colonne deve riflettere esattamente lo schema reale.
    expect(db.columns.price_monitoring).toEqual([
      'id',
      'url',
      'price',
      'median_price',
      'timestamp',
    ]);
    expect(db.columns.customers).toEqual(['id', 'email']);
    // Le colonne fittizie del bug NON ci sono (regression guard).
    expect(db.columns.price_monitoring).not.toContain('code');
    expect(db.columns.price_monitoring).not.toContain('created_at');
  });

  it('tabella SENZA colonne → presente in tables ma ASSENTE da columns (gate skippa)', () => {
    h.dbList = [
      {
        id: 'd1',
        name: 'X',
        description: null,
        tables: [
          { name: 'with_cols', columns: [{ name: 'a', type: 'text' }] },
          { name: 'empty_table', columns: [] },
          { name: 'no_cols_field' }, // columns undefined
        ],
      },
    ];
    const ctx = buildTenantContext('default');
    const db = ctx.databases[0]!;
    expect(db.tables).toEqual(['with_cols', 'empty_table', 'no_cols_field']);
    expect(db.columns.with_cols).toEqual(['a']);
    expect('empty_table' in db.columns).toBe(false);
    expect('no_cols_field' in db.columns).toBe(false);
  });

  it('scarta nomi-colonna vuoti/whitespace e tabelle senza nome', () => {
    h.dbList = [
      {
        id: 'd1',
        name: 'X',
        description: null,
        tables: [
          { name: '  ', columns: [{ name: 'x', type: 'text' }] }, // tabella senza nome → scartata
          {
            name: 'good',
            columns: [
              { name: 'ok', type: 'text' },
              { name: '  ', type: 'text' },
              { name: '', type: 'text' },
            ],
          },
        ],
      },
    ];
    const ctx = buildTenantContext('default');
    const db = ctx.databases[0]!;
    expect(db.tables).toEqual(['good']);
    expect(db.columns.good).toEqual(['ok']); // colonne vuote scartate
  });

  it('lista DB vuota → databases [] (graceful)', () => {
    h.dbList = [];
    expect(buildTenantContext('default').databases).toEqual([]);
  });

  it('🚨 writable derivato da connection.embedded (locale=true, remoto/assente=false)', () => {
    h.dbList = [
      { id: 'loc', name: 'L', description: null, tables: [], connection: { embedded: true } },
      { id: 'rem', name: 'R', description: null, tables: [], connection: { embedded: false } },
      { id: 'noconn', name: 'N', description: null, tables: [] }, // connection assente → non scrivibile a colpo sicuro
    ];
    const dbs = buildTenantContext('default').databases;
    expect(dbs.find((d) => d.id === 'loc')!.writable).toBe(true);
    expect(dbs.find((d) => d.id === 'rem')!.writable).toBe(false);
    expect(dbs.find((d) => d.id === 'noconn')!.writable).toBe(false);
  });

  it('shape risultato compatibile con QualityGateInput.databases (id+tables+columns)', () => {
    h.dbList = [
      {
        id: 'd',
        name: 'N',
        description: null,
        tables: [{ name: 't', columns: [{ name: 'c', type: 'text' }] }],
      },
    ];
    const db = buildTenantContext('default').databases[0]!;
    // I 3 campi che il gate consuma devono esserci e avere il tipo giusto.
    expect(typeof db.id).toBe('string');
    expect(Array.isArray(db.tables)).toBe(true);
    expect(typeof db.columns).toBe('object');
    expect(db.columns.t).toEqual(['c']);
  });
});
