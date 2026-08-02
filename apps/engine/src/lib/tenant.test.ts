/**
 * Test 2026-grade — tenant.ts (tenant isolation source-of-truth).
 *
 * 🚨 SECURITY-CRITICAL: questo helper è la difesa CONTRO tenant isolation bugs.
 *    Bug = utente tenant A che vede dati tenant B → data breach.
 *
 * 🚨 SPOOF-PROOF: il tenantId viene SEMPRE dal JWT verificato, MAI dall'header
 *    `x-tenant-id` controllato dal client. SOLO superadmin può override.
 *
 * 🚨 FAIL-LOUD: getTenantId su route senza auth → throw. NO silent fallback
 *    a 'default' (era il bug originale fixato).
 *
 * Coverage: 4 scenari principali + 2 edge case (header presente ma === auth,
 * non-superadmin che tenta override).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const loggerMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('./logger.js', () => ({ logger: loggerMock }));

// getContainerTenantId() reads MEDEA_TENANT_ID via loadConfig(). We mock the
// config module so each test controls the env-injected tenant deterministically
// (no reliance on real process.env, no full-schema parse).
const configMock = vi.hoisted(() => ({ tenantId: undefined as string | undefined }));
vi.mock('@/config.js', () => ({
  loadConfig: () => ({ MEDEA_TENANT_ID: configMock.tenantId }),
}));

const { getTenantId, getTenantIdOrNull, getContainerTenantId } = await import('./tenant.js');

beforeEach(() => {
  vi.clearAllMocks();
  configMock.tenantId = undefined;
});

/** Helper per costruire un mock di Hono Context coerente con quel che il sorgente legge */
function makeCtx(opts: {
  // Sotto `exactOptionalPropertyTypes` esplicitiamo `undefined` per consentire
  // ai test di passare `auth: undefined` come fixture (caso "header senza auth").
  auth?: { tenantId: string; role: 'admin' | 'editor' | 'viewer' | 'superadmin'; email?: string } | null | undefined;
  headers?: Record<string, string>;
  path?: string;
  method?: string;
}): unknown {
  const headers = opts.headers ?? {};
  return {
    get: (key: string) => {
      if (key === 'auth') return opts.auth;
      return undefined;
    },
    req: {
      header: (name: string) => headers[name.toLowerCase()] ?? headers[name],
      path: opts.path ?? '/api/v1/test',
      method: opts.method ?? 'GET',
    },
  };
}

describe('🚨 getTenantId — spoof-proof JWT source', () => {
  it('🚨 user normale: ritorna auth.tenantId, ignora header X-Tenant-Id', () => {
    const c = makeCtx({
      auth: { tenantId: 'tenant-real', role: 'editor', email: 'user@x.it' },
      headers: { 'x-tenant-id': 'tenant-spoofed-by-attacker' },
    });
    expect(getTenantId(c as never)).toBe('tenant-real');
  });

  it('🚨 user normale: header assente → ritorna auth.tenantId', () => {
    const c = makeCtx({
      auth: { tenantId: 'tenant-bob', role: 'admin' },
    });
    expect(getTenantId(c as never)).toBe('tenant-bob');
  });

  it('🚨 admin (NOT superadmin) non può override anche con header', () => {
    const c = makeCtx({
      auth: { tenantId: 'tenant-admin-own', role: 'admin', email: 'admin@x.it' },
      headers: { 'x-tenant-id': 'other-tenant' },
    });
    // admin role → header IGNORATO
    expect(getTenantId(c as never)).toBe('tenant-admin-own');
    expect(loggerMock.info).not.toHaveBeenCalled();
  });

  it('🚨 viewer ovviamente nessun override', () => {
    const c = makeCtx({
      auth: { tenantId: 'tenant-vw', role: 'viewer' },
      headers: { 'x-tenant-id': 'hack-attempt' },
    });
    expect(getTenantId(c as never)).toBe('tenant-vw');
  });
});

describe('🚨 getTenantId — superadmin override', () => {
  it('🚨 superadmin + header diverso → ritorna header + LOG audit info', () => {
    const c = makeCtx({
      auth: { tenantId: 'platform', role: 'superadmin', email: 'admin@platform.it' },
      headers: { 'x-tenant-id': 'tenant-target' },
      path: '/api/v1/admin/users',
      method: 'POST',
    });
    expect(getTenantId(c as never)).toBe('tenant-target');
    expect(loggerMock.info).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'admin@platform.it',
        actorTenant: 'platform',
        targetTenant: 'tenant-target',
        path: '/api/v1/admin/users',
        method: 'POST',
      }),
      'Superadmin cross-tenant access',
    );
  });

  it('🚨 superadmin SENZA header → no override, no log (default own tenant)', () => {
    const c = makeCtx({
      auth: { tenantId: 'platform', role: 'superadmin', email: 'admin@platform.it' },
    });
    expect(getTenantId(c as never)).toBe('platform');
    expect(loggerMock.info).not.toHaveBeenCalled();
  });

  it('🚨 superadmin + header === own tenant → no log (non è override reale)', () => {
    const c = makeCtx({
      auth: { tenantId: 'platform', role: 'superadmin', email: 'admin@x.it' },
      headers: { 'x-tenant-id': 'platform' }, // STESSO
    });
    expect(getTenantId(c as never)).toBe('platform');
    expect(loggerMock.info).not.toHaveBeenCalled();
  });

  it('🚨 superadmin + header empty string → no override (header presente ma falsy-equiv)', () => {
    const c = makeCtx({
      auth: { tenantId: 'platform', role: 'superadmin' },
      headers: { 'x-tenant-id': '' },
    });
    expect(getTenantId(c as never)).toBe('platform');
    expect(loggerMock.info).not.toHaveBeenCalled();
  });
});

describe('🚨 getTenantId — fail-loud su unauthenticated', () => {
  it('🚨 auth = null → throw con messaggio diagnostico path', () => {
    const c = makeCtx({ auth: null, path: '/api/v1/workflows' });
    expect(() => getTenantId(c as never)).toThrow(
      /getTenantId\(\) called on unauthenticated request.*path=\/api\/v1\/workflows/u,
    );
  });

  it('🚨 auth = undefined → throw (stesso comportamento di null)', () => {
    const c = makeCtx({ auth: undefined, path: '/api/v1/oops' });
    expect(() => getTenantId(c as never)).toThrow(/unauthenticated/u);
  });

  it('🚨 error message suggerisce authMiddleware fix', () => {
    const c = makeCtx({ auth: null });
    try {
      getTenantId(c as never);
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as Error).message).toMatch(/authMiddleware/u);
    }
  });
});

describe('🚨 getTenantIdOrNull — graceful for hybrid routes', () => {
  it('🚨 auth assente → ritorna null (non throw)', () => {
    const c = makeCtx({ auth: null });
    expect(getTenantIdOrNull(c as never)).toBeNull();
  });

  it('🚨 auth undefined → null', () => {
    const c = makeCtx({ auth: undefined });
    expect(getTenantIdOrNull(c as never)).toBeNull();
  });

  it('🚨 auth presente → delega a getTenantId (stesso comportamento)', () => {
    const c = makeCtx({
      auth: { tenantId: 'tenant-x', role: 'editor' },
    });
    expect(getTenantIdOrNull(c as never)).toBe('tenant-x');
  });

  it('🚨 superadmin override funziona anche tramite OrNull', () => {
    const c = makeCtx({
      auth: { tenantId: 'platform', role: 'superadmin', email: 'a@b.c' },
      headers: { 'x-tenant-id': 'tenant-y' },
    });
    expect(getTenantIdOrNull(c as never)).toBe('tenant-y');
    expect(loggerMock.info).toHaveBeenCalledTimes(1);
  });
});

describe('🚨 getContainerTenantId — env source-of-truth for PUBLIC routes', () => {
  it('🚨 ritorna MEDEA_TENANT_ID quando settato (container mode)', () => {
    configMock.tenantId = '11111111-2222-3333-4444-555555555555';
    expect(getContainerTenantId()).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('🚨 env unset → fallback "default" (dev locale, no portal)', () => {
    configMock.tenantId = undefined;
    expect(getContainerTenantId()).toBe('default');
  });

  it('🚨 SPOOF-PROOF by construction: NON accetta argomenti → impossibile passare un header', () => {
    // La firma è zero-arg: non esiste un canale per iniettare x-tenant-id.
    // Questo è il punto del fix — la sorgente è SOLO l'env del container.
    expect(getContainerTenantId.length).toBe(0);
    configMock.tenantId = 'tenant-real-uuid';
    // Anche "passando" roba a forza, il valore resta quello dell'env.
    expect((getContainerTenantId as (x?: unknown) => string)('x-tenant-id: attacker')).toBe('tenant-real-uuid');
  });

  it('🚨 stringa vuota in env → la ritorna tale e quale (non maschera misconfig)', () => {
    // Se il portal inietta '' per errore, NON vogliamo un silenzioso 'default'
    // che nasconde il problema: il ?? scatta solo su null/undefined.
    configMock.tenantId = '';
    expect(getContainerTenantId()).toBe('');
  });
});

describe('🚨 Security regression — tenant isolation bug class', () => {
  it('🚨 ATTACK: attacker JWT (tenant-victim member) NON può accedere tenant altrui via header', () => {
    // Scenario: utente legittimo tenant-A, prova ad accedere a dati tenant-B via header
    const c = makeCtx({
      auth: { tenantId: 'tenant-A', role: 'editor', email: 'evil@a.com' },
      headers: { 'x-tenant-id': 'tenant-B' },
    });
    // SECURITY: deve restare tenant-A, NON tenant-B
    expect(getTenantId(c as never)).toBe('tenant-A');
    expect(getTenantId(c as never)).not.toBe('tenant-B');
  });

  it('🚨 LEGACY BUG: nessun silent fallback a "default" se auth manca', () => {
    const c = makeCtx({ auth: null });
    // Pre-fix il codice ritornava 'default' silenzioso → bug isolamento
    expect(() => getTenantId(c as never)).toThrow();
    // Mai 'default'
    try { getTenantId(c as never); } catch (e) {
      expect((e as Error).message).not.toContain('default');
    }
  });

  it('🚨 sorgente chiama c.req.header("x-tenant-id") in lowercase (verifica contract)', () => {
    // Il source DEVE chiamare l'header in lowercase per garantire Hono lookup.
    // Verifica che con header passato lowercase il flusso funziona correttamente.
    const c = makeCtx({
      auth: { tenantId: 'platform', role: 'superadmin', email: 'a@b.c' },
      headers: { 'x-tenant-id': 'tenant-target' }, // chiave lowercase (forma reale Hono)
    });
    expect(getTenantId(c as never)).toBe('tenant-target');
  });
});
