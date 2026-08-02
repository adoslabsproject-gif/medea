import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie } from 'hono/cookie';
import { sessionCookieName } from '@/lib/session-cookie.js';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  hashPassword,
  verifyPassword,
  issueSessionToken,
  verifySessionToken,
} from '@medea/engine-auth-local';
import { parseSessionFromCookieHeader } from '@/lib/session-cookie.js';
import { revokeSession } from '@/services/security/session-revocation.js';
import { logger } from '@/lib/logger.js';
import { getAuthKeys } from '@/lib/auth-keys.js';
import { getDatabase } from '@/storage/db.js';
import { nanoid } from 'nanoid';
import { trackFailedLogin } from '@/services/security/login-tracker.js';
import { loadConfig } from '@/config.js';

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12),
  displayName: z.string().min(1).max(200),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  display_name: string;
  password_hash: string;
  role: 'owner' | 'editor' | 'operator' | 'viewer';
  enabled: number;
}

// F2 (2026-06-10): `users` è in SCHEMA_SQL (migrate.schema.ts), creata da
// runMigrations al boot. Niente CREATE TABLE inline a request-time.

export function createAuthRoutes(): Hono {
  const app = new Hono();

  /**
   * POST /auth/register — SECURITY HARDENING (2026-05-23):
   *
   * Disabilitato di default. La policy di FlowForge enterprise è:
   *   • Nuovi utenti creati SOLO da un admin via /api/v1/users (UI Users)
   *     o via SQL diretto sul server.
   *   • L'unica eccezione tollerata è il bootstrap iniziale: se NESSUN
   *     utente esiste per il tenant, il primo register è permesso (diventa
   *     owner). Questo è il caso "fresh install" — la finestra di rischio
   *     è zero perché chi installa controlla la VM.
   *   • Per ambienti SaaS multi-tenant con signup pubblico, settare
   *     `MEDEA_ALLOW_SIGNUP=1` (sblocca anche /auth/signup).
   *
   * Senza questa hardening, chiunque poteva fare POST con un nuovo
   * `x-tenant-id` e diventare owner di un tenant inesistente, oppure
   * spammare utenti viewer sotto tenant esistenti (DoS storage).
   */
  app.post('/auth/register', zValidator('json', RegisterSchema), async (c) => {
    const { email, password, displayName } = c.req.valid('json');
    const tenantId = c.req.header('x-tenant-id') ?? 'default';
    const { sqlite } = getDatabase();

    // #204 P0-5: Container-per-tenant mode — /register è DISABILITATO.
    // Quando il runtime gira come container tenant isolato (provisioned dal
    // portal), `MEDEA_TENANT_ID` è set → l'unico modo di creare utenti
    // è via SSO JWE dal portal (admin/users CRUD). Esporre /register qui
    // permetterebbe a chiunque conoscesse il subdomain del tenant di creare
    // un account viewer e bypassare il portal billing/team management.
    // Pre-fix: MEDEA_ALLOW_SIGNUP=1 poteva sbloccare anche in container
    // mode — adesso il container-mode VINCE su signup-allowed.
    const containerMode = (process.env.MEDEA_TENANT_ID ?? '').trim() !== '';
    if (containerMode) {
      logger.warn(
        { tenantId, email, ip: c.req.header('x-forwarded-for') ?? 'n/a' },
        'register: blocked (container-per-tenant mode — use SSO from portal)',
      );
      return c.json(
        {
          error:
            'Registrazione disabilitata in container mode. Usa SSO dal portal automazionezeli.com.',
          code: 'CONTAINER_MODE_NO_REGISTER',
        },
        403,
      );
    }

    // Gate signup pubblico — Federico-grade:
    //   • Bootstrap SOLO se NESSUN utente esiste in TUTTO il sistema
    //     (fresh install). Tenant_id arbitrari NON contano: senza questa
    //     condizione globale, un attaccante poteva inventare un nuovo
    //     `x-tenant-id` qualsiasi e fare bootstrap come owner (la condizione
    //     vecchia era `WHERE tenant_id = ?` → userCount sempre 0 per
    //     tenant inesistenti).
    //   • In tutti gli altri casi serve MEDEA_ALLOW_SIGNUP=1.
    //   • Inoltre il tenant_id richiesto deve PRE-ESISTERE (almeno un user
    //     deve già esserci per quel tenant) — un nuovo tenant si crea SOLO
    //     via /auth/signup, che ha la propria env-gate.
    const signupAllowed = process.env.MEDEA_ALLOW_SIGNUP === '1';
    const totalUsers = (sqlite.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
    const tenantUserCount = (
      sqlite.prepare('SELECT COUNT(*) as c FROM users WHERE tenant_id = ?').get(tenantId) as {
        c: number;
      }
    ).c;
    const isFreshInstall = totalUsers === 0;
    const tenantExists = tenantUserCount > 0;

    if (!signupAllowed && !isFreshInstall) {
      logger.warn(
        { tenantId, email, ip: c.req.header('x-forwarded-for') ?? 'n/a' },
        'register: blocked (signup disabled, not fresh install)',
      );
      return c.json(
        {
          error:
            "Registrazione disabilitata. Chiedi a un admin di crearti l'account dal pannello Users, oppure imposta MEDEA_ALLOW_SIGNUP=1 sul runtime per consentire il signup pubblico.",
          code: 'SIGNUP_DISABLED',
        },
        403,
      );
    }
    if (signupAllowed && !tenantExists) {
      // Anche con signup pubblico abilitato: rifiutiamo i tenant inventati.
      // Per creare un NUOVO tenant l'utente deve passare da /auth/signup.
      logger.warn(
        { tenantId, email },
        'register: blocked (tenant does not exist; use /auth/signup)',
      );
      return c.json(
        {
          error:
            'Tenant inesistente. Per creare un nuovo tenant usa /auth/signup. Per registrarsi su un tenant esistente devi conoscerne lo slug corretto.',
          code: 'TENANT_NOT_FOUND',
        },
        404,
      );
    }

    const existing = sqlite
      .prepare('SELECT id FROM users WHERE tenant_id = ? AND email = ?')
      .get(tenantId, email) as { id?: string } | undefined;
    if (existing?.id) return c.json({ error: 'Email already registered' }, 409);

    const hash = await hashPassword(password);
    const id = nanoid();
    const now = new Date().toISOString();
    const ownerCount = (
      sqlite
        .prepare("SELECT COUNT(*) as c FROM users WHERE tenant_id = ? AND role = 'owner'")
        .get(tenantId) as { c: number }
    ).c;
    const role: UserRow['role'] = ownerCount === 0 ? 'owner' : 'viewer';

    sqlite
      .prepare(
        'INSERT INTO users (id, tenant_id, email, display_name, password_hash, role, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
      )
      .run(id, tenantId, email, displayName, hash, role, now, now);

    logger.info(
      { userId: id, tenantId, role, freshInstall: isFreshInstall, signupAllowed },
      'User registered',
    );
    return c.json({ user: { id, email, displayName, role, tenantId } }, 201);
  });

  // AUDIT FIX AUTH-2 (2026-06-09 HIGH): /auth/login lockout + rate-limit.
  //
  // Pre-fix: nessun rate-limit, nessun account lockout. trackFailedLogin
  // solo reportava a Sentinel (suppression 30min, non-bloccante) → brute
  // force illimitato sulla password JWT del runtime tenant.
  //
  // Post-fix multi-layer defense:
  //   1. failed_login_count incrementato su ogni fail (per email)
  //   2. locked_until + lockout_level: escalation 15min → 1h → 24h
  //   3. On success → reset counter + lockout_level
  //   4. Constant-time delay 100ms su "user not found" (anti enumeration)
  //   5. trackFailedLogin (Sentinel) preservato per cross-tenant ban
  app.post('/auth/login', zValidator('json', LoginSchema), async (c) => {
    const { email, password } = c.req.valid('json');
    const tenantId = c.req.header('x-tenant-id') ?? 'default';
    const ipAddress = c.req.header('cf-connecting-ip');
    const { sqlite } = getDatabase();

    const user = sqlite
      .prepare('SELECT * FROM users WHERE tenant_id = ? AND email = ? AND enabled = 1')
      .get(tenantId, email) as UserRow | undefined;
    if (!user) {
      await new Promise<void>((r) => {
        setTimeout(r, 100);
      });
      trackFailedLogin({ email, tenantId, ipAddress });
      return c.json({ error: 'Invalid email or password' }, 401);
    }

    // CHECK LOCKOUT: se locked_until in futuro → 423 Locked
    const nowIso = new Date().toISOString();
    const userExt = user as UserRow & {
      locked_until?: string | null;
      failed_login_count?: number;
      lockout_level?: number;
    };
    if (userExt.locked_until && userExt.locked_until > nowIso) {
      logger.warn(
        { userId: user.id, email, lockedUntil: userExt.locked_until, tenantId, ipAddress },
        '[SECURITY AUTH-2] login attempt during lockout',
      );
      trackFailedLogin({ email, tenantId, ipAddress });
      return c.json(
        {
          error: 'Account temporarily locked due to too many failed attempts. Try later.',
          code: 'ACCOUNT_LOCKED',
          retryAfter: userExt.locked_until,
        },
        423,
      );
    }

    const ok = await verifyPassword(user.password_hash, password);
    if (!ok) {
      // Increment failed counter + maybe escalate lockout
      const newCount = (userExt.failed_login_count ?? 0) + 1;
      const FAIL_THRESHOLD = 5;
      let newLockoutLevel = userExt.lockout_level ?? 0;
      let newLockedUntil: string | null = null;

      if (newCount >= FAIL_THRESHOLD) {
        // Escalation: 1° lockout 15min, 2° 1h, 3°+ 24h
        newLockoutLevel = Math.min(3, newLockoutLevel + 1);
        const lockoutMs =
          newLockoutLevel === 1
            ? 15 * 60_000
            : newLockoutLevel === 2
              ? 60 * 60_000
              : 24 * 60 * 60_000;
        newLockedUntil = new Date(Date.now() + lockoutMs).toISOString();
      }

      sqlite
        .prepare(
          'UPDATE users SET failed_login_count = ?, locked_until = ?, lockout_level = ? WHERE id = ?',
        )
        .run(newCount, newLockedUntil, newLockoutLevel, user.id);

      logger.warn(
        {
          userId: user.id,
          email,
          failedCount: newCount,
          lockoutLevel: newLockoutLevel,
          lockedUntil: newLockedUntil,
          tenantId,
          ipAddress,
        },
        '[SECURITY AUTH-2] failed login',
      );
      trackFailedLogin({ email, tenantId, ipAddress });
      return c.json({ error: 'Invalid email or password' }, 401);
    }

    // SUCCESS: reset lockout state
    sqlite
      .prepare(
        'UPDATE users SET failed_login_count = 0, locked_until = NULL, lockout_level = 0, last_login_at = ? WHERE id = ?',
      )
      .run(nowIso, user.id);

    const keys = await getAuthKeys();
    const token = await issueSessionToken({
      userId: user.id,
      tenantId: user.tenant_id,
      email: user.email,
      role: user.role,
      privateKeyPem: keys.privateKeyPem,
    });

    return c.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
        tenantId: user.tenant_id,
      },
    });
  });

  app.get('/auth/me', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    // Enrich con displayName dal users table — l'AuthContext del JWT include
    // solo {userId, tenantId, email, role}; il nome dell'utente serve alla
    // WelcomeDashboard per mostrare "Benvenuto, <displayName>" e capire
    // subito di chi sia il workspace senza dover incrociare con il portal.
    // Lookup veloce su indice users_tenant_email_idx — single row, ~0.1ms.
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare('SELECT display_name FROM users WHERE id = ? AND tenant_id = ? LIMIT 1')
      .get(auth.userId, auth.tenantId) as { display_name: string } | undefined;
    return c.json({
      user: {
        ...auth,
        displayName: row?.display_name ?? null,
      },
    });
  });

  /**
   * /auth/bootstrap — usato dall'editor SPA al primo load post-SSO
   * (cookie ff_session HttpOnly presente, ma SPA non lo può leggere).
   * Ritorna SOLO { user } — il cookie HttpOnly viaggia automaticamente
   * su ogni successivo fetch con `credentials: 'include'`.
   *
   * SECURITY #203 P0-4: NON ritorniamo il `token`.
   * Pre-fix: ritornava `{ token, user }`. L'editor faceva
   * `localStorage.setItem('flowforge.session.token', token)` →
   * trasformava un cookie HttpOnly (sicuro contro XSS) in una stringa
   * accessibile a QUALSIASI script (compromessa via XSS, browser
   * extension, dev-tools snoop). Inoltre il token finiva nei log proxy
   * / error tracking / browser DevTools network tab in cleartext.
   * Pattern enterprise 2026 (Auth0/Cloudflare/Google): cookie HttpOnly
   * + SameSite=Strict + Secure; mai esporre il token a JS.
   */
  app.get('/auth/bootstrap', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    // Sanity check: cookie deve esistere. Dual-name lookup post `__Host-`
    // migration (BUG FIX 2026-05-29: pre-fix cercava SOLO `ff_session=`,
    // ma in prod il cookie e\` `__Host-ff_session=` → 401 loop infinito
    // SSO bootstrap → /sso → bootstrap → 401 → ...).
    const cookie = c.req.header('cookie') ?? '';
    const hasSessionCookie = cookie
      .split(';')
      .map((s) => s.trim())
      .some((s) => s.startsWith('__Host-ff_session=') || s.startsWith('ff_session='));
    if (!hasSessionCookie) return c.json({ error: 'No session cookie' }, 401);
    return c.json({ user: auth });
  });

  // Public no-auth status: tells the editor whether ANY user exists, so it
  // can route to first-run-setup vs login. Returns no PII.
  //
  // Container-per-tenant: il runtime CONOSCE il proprio tenant via env
  // MEDEA_TENANT_ID. Questa e\` la SOURCE OF TRUTH (sistema principale).
  //
  // L'header `x-tenant-id` resta supportato come FALLBACK per scenari
  // legacy single-runtime/multi-tenant (deprecato — pre container-per-tenant
  // architecture). MAI usato nel deploy attuale.
  // 'default' e\` un terzo fallback puramente difensivo (boot iniziale dev
  // senza env settato) — non dovrebbe mai matcharare in produzione.
  app.get('/auth/status', (c) => {
    const config = loadConfig();
    // HIGH (2026-05-29): se MEDEA_TENANT_ID e\` settato (deploy
    // container-per-tenant normale), e\` SEMPRE la source of truth — NIENTE
    // fallback header. Solo se l'env e\` esplicitamente non settato (dev
    // single-runtime), accettiamo `x-tenant-id` per test locali.
    const headerTenant = c.req.header('x-tenant-id');
    const envTenant = config.MEDEA_TENANT_ID;
    let tenantId: string;
    if (envTenant) {
      tenantId = envTenant;
      if (headerTenant && headerTenant !== envTenant) {
        logger.warn(
          { envTenant, headerTenant },
          '[SECURITY] x-tenant-id header non corrisponde a env MEDEA_TENANT_ID — IGNORATO',
        );
      }
    } else {
      // Dev mode: env non settato (single-runtime multi-tenant). Accetta header.
      tenantId = headerTenant ?? 'default';
    }
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare('SELECT COUNT(*) as c FROM users WHERE tenant_id = ?')
      .get(tenantId) as { c: number } | undefined;
    const userCount = row?.c ?? 0;
    const signupAllowed = process.env.MEDEA_ALLOW_SIGNUP === '1';
    return c.json({ userCount, needsSetup: userCount === 0, signupAllowed });
  });

  /**
   * Self-service tenant signup. Disabled by default — set
   * MEDEA_ALLOW_SIGNUP=1 to enable (typically for SaaS scenarios).
   *
   * Creates a NEW tenant + first-owner user atomically. The tenant slug
   * must be unique (we check via the existing users table — no tenant table
   * exists; tenants are implicit via user.tenantId).
   */
  app.post('/auth/signup', async (c) => {
    // #204 P0-5: container-per-tenant mode → /signup permanentemente disabilitato.
    // Il container tenant è single-tenant per definizione (MEDEA_TENANT_ID
    // env set dal portal al provision). Self-service multi-tenant signup non
    // ha senso qui — il provisioning di nuovi tenant avviene SOLO dal portal.
    if ((process.env.MEDEA_TENANT_ID ?? '').trim() !== '') {
      return c.json(
        {
          error: 'Signup non disponibile in container mode. Usa il portal automazionezeli.com.',
          code: 'CONTAINER_MODE_NO_SIGNUP',
        },
        403,
      );
    }
    if (process.env.MEDEA_ALLOW_SIGNUP !== '1') {
      return c.json(
        { error: 'Self-service signup non abilitato. Imposta MEDEA_ALLOW_SIGNUP=1 sul runtime.' },
        403,
      );
    }
    const raw = (await c.req.json()) as unknown;
    if (!raw || typeof raw !== 'object') return c.json({ error: 'Body required' }, 400);
    const body = raw as Record<string, unknown>;
    const tenantSlug =
      typeof body.tenantSlug === 'string' ? body.tenantSlug.trim().toLowerCase() : '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';

    if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u.test(tenantSlug)) {
      return c.json(
        { error: 'tenantSlug deve essere alfanumerico (a-z, 0-9, trattino), 3-64 char.' },
        400,
      );
    }
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email)) {
      return c.json({ error: 'Email non valida' }, 400);
    }
    if (password.length < 12) {
      return c.json({ error: 'Password troppo corta (min 12)' }, 400);
    }
    if (!displayName) {
      return c.json({ error: 'displayName richiesto' }, 400);
    }

    const { sqlite } = getDatabase();
    // Reject if tenant already has users (i.e. the slug is taken)
    const taken = sqlite
      .prepare('SELECT COUNT(*) as c FROM users WHERE tenant_id = ?')
      .get(tenantSlug) as { c: number } | undefined;
    if ((taken?.c ?? 0) > 0) {
      return c.json({ error: 'Tenant slug già in uso.' }, 409);
    }

    const hash = await hashPassword(password);
    const id = nanoid();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        'INSERT INTO users (id, tenant_id, email, display_name, password_hash, role, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
      )
      .run(id, tenantSlug, email, displayName, hash, 'owner', now, now);

    logger.info({ tenantId: tenantSlug, userId: id }, 'New tenant signup completed');

    // Auto-login: issue a session token for the new owner
    const keys = await getAuthKeys();
    const sessionToken = await issueSessionToken({
      userId: id,
      tenantId: tenantSlug,
      email,
      role: 'owner',
      privateKeyPem: keys.privateKeyPem,
    });

    return c.json(
      {
        tenantId: tenantSlug,
        user: { id, email, displayName, role: 'owner' },
        token: sessionToken,
      },
      201,
    );
  });

  /**
   * POST /auth/logout — chiude la sessione del WORKSPACE (container tenant).
   *
   * BUG FIX 2026-06-07 (sicurezza): il cookie ff_session è stateless (token
   * firmato, TTL 7gg, nessuna revoca DB) e vive sul dominio del tenant
   * (<slug>.app.automazionezeli.com). Il logout dell'editor faceva SOLO un
   * redirect al portal (dominio DIVERSO → non può toccare questo cookie):
   * risultato, dopo il "logout" il cookie restava valido 7 giorni e premendo
   * "indietro" la sessione veniva ripristinata e PIENAMENTE utilizzabile.
   *
   * Essendo stateless, l'unico modo di chiudere la sessione è cancellare il
   * cookie — e SOLO il runtime (same-origin) può farlo. Cancelliamo entrambi
   * i nomi (__Host- prod + legacy ff_session) e, via Clear-Site-Data, anche
   * cookie/storage residui della SPA. Cache-Control no-store impedisce al
   * back/forward cache di ripristinare la risposta.
   */
  const doLogout = async (c: Context): Promise<Response> => {
    // Revoca server-side (blocklist) PRIMA di cancellare il cookie: così il
    // token resta non-utilizzabile fino a scadenza anche se è stato copiato.
    try {
      const cookieTok = parseSessionFromCookieHeader(c.req.header('cookie'));
      const bearer = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
      const token = cookieTok ?? (bearer || undefined);
      if (token) {
        const { publicKeyPem } = await getAuthKeys();
        const payload = await verifySessionToken(token, publicKeyPem);
        if (payload) revokeSession(payload);
      }
    } catch (err) {
      // Best-effort: la cancellazione cookie sotto chiude comunque la sessione
      // su questo browser. La revoca è un hardening aggiuntivo.
      logger.warn({ err }, 'logout: revoca blocklist fallita (cookie comunque cancellato)');
    }
    const secure = loadConfig().NODE_ENV === 'production';
    deleteCookie(c, sessionCookieName(), { path: '/', secure });
    deleteCookie(c, 'ff_session', { path: '/', secure }); // legacy dual-name
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    c.header('Clear-Site-Data', '"cookies", "storage"');
    const wantsHtml = (c.req.header('accept') ?? '').includes('text/html');
    if (wantsHtml) return c.redirect('/', 302);
    return c.json({ ok: true });
  };
  app.post('/auth/logout', (c) => doLogout(c));
  app.get('/auth/logout', (c) => doLogout(c)); // compat link diretto

  return app;
}
