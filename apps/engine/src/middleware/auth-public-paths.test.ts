/**
 * Test REALE dell'allowlist path pubblici — la superficie senza-auth del runtime.
 * Un errore qui apre un endpoint sensibile: va testato in isolamento, non solo
 * E2E. Replica ESATTAMENTE la logica del middleware (prefix startsWith + pattern
 * test) e verifica match attesi, NON-match dei vicini (regex ancorata) e che
 * nessun pattern sia "aperto".
 */
import { describe, it, expect } from 'vitest';
import { PUBLIC_PREFIXES, PUBLIC_PATH_PATTERNS } from './auth-public-paths.js';

/** Stessa logica del middleware authMiddleware. */
function isPublicPath(path: string): boolean {
  if (PUBLIC_PREFIXES.some((p) => path.startsWith(p))) return true;
  return PUBLIC_PATH_PATTERNS.some((re) => re.test(path));
}

describe('allowlist — /auth/logout', () => {
  it('è pubblico (match esatto)', () => {
    expect(isPublicPath('/api/v1/auth/logout')).toBe(true);
  });
  it('NON apre i path vicini (regex ancorata ^…$)', () => {
    expect(isPublicPath('/api/v1/auth/logout/evil')).toBe(false);
    expect(isPublicPath('/api/v1/auth/logoutx')).toBe(false);
    expect(isPublicPath('/api/v1/auth/xlogout')).toBe(false);
    expect(isPublicPath('/api/v1/users/logout')).toBe(false);
    expect(isPublicPath('/api/v1/auth/logout?x=1')).toBe(false); // query NON nel path normalizzato
  });
});

describe('allowlist — OAuth/SAML callback dinamici (SECURITY #200 P0-1)', () => {
  it('callback con provider dinamico + SAML metadata → pubblici', () => {
    expect(isPublicPath('/api/v1/auth/oauth/google/callback')).toBe(true);
    expect(isPublicPath('/api/v1/auth/saml/okta/callback')).toBe(true);
    expect(isPublicPath('/api/v1/auth/saml/okta/metadata')).toBe(true);
  });
  it('admin /providers e /start NON pubblici (devono restare gated)', () => {
    expect(isPublicPath('/api/v1/auth/oauth/providers')).toBe(false);
    expect(isPublicPath('/api/v1/auth/saml/providers')).toBe(false);
    expect(isPublicPath('/api/v1/auth/oauth/google/start')).toBe(false);
  });
  it('path-injection nel segmento dinamico NON matcha (no %, no slash extra)', () => {
    expect(isPublicPath('/api/v1/auth/oauth/..%2f/callback')).toBe(false);
    expect(isPublicPath('/api/v1/auth/oauth/a/b/callback')).toBe(false);
    expect(isPublicPath('/api/v1/auth/oauth//callback')).toBe(false);
  });
});

describe('allowlist — prefissi pubblici', () => {
  it('le famiglie token-gated sono pubbliche', () => {
    expect(isPublicPath('/api/v1/share/abc')).toBe(true);
    expect(isPublicPath('/api/v1/portal/x')).toBe(true);
    expect(isPublicPath('/api/track/open/123')).toBe(true);
    expect(isPublicPath('/api/v1/oauth-connect/callback')).toBe(true);
  });
  it('endpoint sensibili NON sono pubblici', () => {
    expect(isPublicPath('/api/v1/users/123')).toBe(false);
    expect(isPublicPath('/api/v1/users/123/revoke-sessions')).toBe(false);
    expect(isPublicPath('/api/v1/workflows')).toBe(false);
    expect(isPublicPath('/api/v1/auth/me')).toBe(false);
    expect(isPublicPath('/api/v1/admin/users')).toBe(false);
  });
});

describe('allowlist — invarianti di sicurezza (anti buco-nel-tetto)', () => {
  it('nessun pattern matcha un path admin generico (no pattern "aperto")', () => {
    for (const re of PUBLIC_PATH_PATTERNS) {
      expect(re.test('/api/v1/admin/users'), `pattern troppo largo: ${re.source}`).toBe(false);
      expect(re.test('/api/v1/users/123'), `pattern troppo largo: ${re.source}`).toBe(false);
    }
  });
  it("ogni pattern è ANCORATO (^ all'inizio, $ alla fine)", () => {
    for (const re of PUBLIC_PATH_PATTERNS) {
      expect(re.source.startsWith('^'), `non ancorato a inizio: ${re.source}`).toBe(true);
      expect(re.source.endsWith('$'), `non ancorato a fine: ${re.source}`).toBe(true);
    }
  });
  it('ogni prefisso pubblico è sotto /api (no prefissi vuoti/larghi)', () => {
    for (const p of PUBLIC_PREFIXES) {
      expect(p.startsWith('/api'), `prefisso sospetto: ${p}`).toBe(true);
      expect(p.length).toBeGreaterThan(6);
    }
  });
});

describe('allowlist — CONTRACT anti-drift (questi e SOLO questi sono pubblici)', () => {
  /**
   * Snapshot ESPLICITO della superficie senza-auth, con la ragione per cui ogni
   * path è pubblico. Aggiungere un endpoint pubblico rende questo test rosso
   * finché non lo si DICHIARA qui con motivo — così nessuna superficie esposta
   * entra in silenzio. Rimuoverne uno impone di aggiornare lo snapshot (review).
   *
   * Ogni voce = [valore, motivo]. Il motivo è documentazione viva, non decoro:
   * spiega COME l'endpoint è protetto pur essendo senza JWT (token nel body,
   * state HMAC firmato, ecc.).
   */
  const EXPECTED_PREFIXES: readonly (readonly [string, string])[] = [
    ['/api/v1/share/', 'share dashboard read-only, gated dal token nel path/body'],
    ['/api/v1/portal/', 'Client Portal, gated dal token nel body'],
    ['/api/v1/oauth-connect/callback', 'callback OAuth, autenticato dallo state firmato'],
    [
      '/api/v1/integrations/oauth/google/callback',
      'callback browser post-Google; state HMAC + TTL 10min + jti single-use',
    ],
    [
      '/api/v1/email-accounts/oauth/google/import',
      'import Gmail portal-centric; JWE audience-bound al workspace',
    ],
    [
      '/api/track/',
      "pixel/redirect email dai client dei destinatari; token HMAC nell'URL È l'auth",
    ],
  ];
  const EXPECTED_PATTERNS: readonly (readonly [string, string])[] = [
    [
      '^\\/api\\/v1\\/auth\\/oauth\\/[a-zA-Z0-9_-]+\\/callback$',
      'callback OAuth provider dinamico; state firmato autentica',
    ],
    [
      '^\\/api\\/v1\\/auth\\/saml\\/[a-zA-Z0-9_-]+\\/callback$',
      'callback SAML provider dinamico; SAMLResponse firmata autentica',
    ],
    [
      '^\\/api\\/v1\\/auth\\/saml\\/[a-zA-Z0-9_-]+\\/metadata$',
      'metadata SAML pubblico per costruzione (SP metadata)',
    ],
    [
      '^\\/api\\/v1\\/auth\\/logout$',
      'logout deve funzionare anche con token scaduto/assente; CSRF coperto da originCsrf',
    ],
  ];

  it("l'insieme dei PREFISSI pubblici è ESATTAMENTE quello dichiarato", () => {
    expect([...PUBLIC_PREFIXES].sort()).toEqual(EXPECTED_PREFIXES.map(([p]) => p).sort());
  });

  it("l'insieme dei PATTERN pubblici è ESATTAMENTE quello dichiarato", () => {
    expect(PUBLIC_PATH_PATTERNS.map((re) => re.source).sort()).toEqual(
      EXPECTED_PATTERNS.map(([p]) => p).sort(),
    );
  });

  it('ogni voce dichiarata ha una motivazione non vuota (documentazione viva)', () => {
    for (const [path, reason] of [...EXPECTED_PREFIXES, ...EXPECTED_PATTERNS]) {
      expect(reason.length, `manca il motivo per ${path}`).toBeGreaterThan(15);
    }
  });
});
