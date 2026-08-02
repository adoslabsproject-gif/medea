/**
 * SSO bridge — riceve JWE short-lived dal portal zeliAI e crea sessione locale.
 *
 * Flow:
 *   1. Portal emette JWE A256GCM con chiave derivata HKDF-SHA256 da
 *      MEDEA_SSO_SECRET (shared con questo container).
 *   2. Browser autosubmit POST → https://{slug}.app.automazionezeli.com/sso
 *      con `token` in body (mai in URL).
 *   3. Container decritta JWE (AEAD = signature implicita + auth tag +
 *      iat/exp + jti replay protection).
 *   4. Crea sessione locale FlowForge via @medea/engine-auth-local.
 *   5. Set cookie ff_session HttpOnly + redirect / (editor).
 *
 * Sicurezza:
 *   - JWE A256GCM: payload ENCRYPTED → chi non ha la chiave non legge sub/email/name.
 *   - Direct key agreement (`dir`): chiave simmetrica condivisa derivata HKDF —
 *     stesso secret -> stessa chiave deterministica tra portal e runtime, zero
 *     coordinamento di chiavi.
 *   - TTL 5min vita (clock skew tolerance 30s).
 *   - jti single-use via SQLite locale UNIQUE constraint (atomic, persistente
 *     attraverso restart container, scale-out friendly).
 *   - audience check vs MEDEA_TENANT_ID.
 *   - Issuer fisso "portal.flowforge".
 */

import type { Context } from 'hono';
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { jwtDecrypt } from 'jose';
import { hkdfSync } from 'node:crypto';
import { issueSessionToken } from '@medea/engine-auth-local';
import { maskEmail } from '@medea/engine-shared';
import { loadConfig } from '@/config.js';
import { logger } from '@/lib/logger.js';
import { getAuthKeys } from '@/lib/auth-keys.js';
import { getDatabase } from '@/storage/db.js';
import { ensureTenant, normalizeTenantStatusClaim } from '@/services/tenant-upsert.js';
import { sessionCookieName } from '@/lib/session-cookie.js';
import { nanoid } from 'nanoid';

// HKDF info label — DEVE matchare apps/portal/src/services/sso.service.ts
const HKDF_INFO = 'flowforge-sso-jwe-v1';

/** Deriva la chiave A256GCM (32 byte) da MEDEA_SSO_SECRET via HKDF-SHA256. */
function deriveJweKey(secret: string): Uint8Array {
  const ikm = Buffer.from(secret, 'utf8');
  const salt = Buffer.alloc(0);
  const info = Buffer.from(HKDF_INFO, 'utf8');
  const derived = hkdfSync('sha256', ikm, salt, info, 32);
  return new Uint8Array(derived);
}

const log = logger;

// jti replay store su SQLite locale — sopravvive a restart container,
// atomico (INSERT ... ON CONFLICT FAIL), supporta scale-out multi-istanza
// se in futuro il runtime viene scalato (purche` SQLite condiviso o sostituito
// con backend distribuito). In-memory Map era split-brain unsafe.
const JTI_TTL_MS = 6 * 60 * 1000;          // 5min token + 1min buffer

// F2 (2026-06-10): `sso_jti_used` consolidata in migrate.schema.ts → SCHEMA_SQL,
// applicata da runMigrations al boot. Niente DDL inline / lazy-init flag.

function isReplay(jti: string): boolean {
  const { sqlite } = getDatabase();
  const now = Date.now();
  sqlite.prepare('DELETE FROM sso_jti_used WHERE expires_at < ?').run(now);
  try {
    sqlite
      .prepare('INSERT INTO sso_jti_used (jti, expires_at) VALUES (?, ?)')
      .run(jti, now + JTI_TTL_MS);
    return false;
  } catch (err: unknown) {
    // SQLite UNIQUE constraint = replay attempt
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE') || msg.includes('constraint')) return true;
    throw err;
  }
}

interface SSOUserRow {
  id: string;
  tenant_id: string;
  email: string;
  display_name: string;
  role: string;
  enabled: number;
}

/** Union ruoli del runtime (SessionTokenPayload['role'] + ROLE_RANK in rbac.ts). */
export type RuntimeRole = 'owner' | 'editor' | 'operator' | 'viewer' | 'superadmin';

/**
 * Normalizza il ruolo del claim SSO (vocabolario PORTAL) nel vocabolario
 * RUNTIME — fix 2026-06-12 (scoperto chiudendo il gap #3 masterplan).
 *
 * Il portal emette `mapRoleToFlowForge()` → 'owner'|'admin'|'editor'|'viewer'|
 * 'super_admin' (access.route.ts), ma il runtime conosce SOLO
 * 'owner'|'editor'|'operator'|'viewer'|'superadmin'. Pre-fix i valori alieni
 * finivano RAW nel session token:
 *   • 'admin'       → ROLE_RANK['admin']=undefined → rbac.requireRole FAIL-OPEN
 *                     (undefined < rank è false): un workspace-admin passava i
 *                     gate owner-only PER CASO, e qualunque ruolo garbage pure.
 *   • 'super_admin' → mai uguale a 'superadmin' → platform admin DEGRADATO.
 *
 * Mapping by-design (matrice ruoli 2026-05-31: owner=TUTTO, admin=TUTTO
 * eccetto piattaforma globale — che nel runtime è superadmin-gated, quindi
 * dentro il container admin≡owner):
 *   admin → owner, super_admin → superadmin, ruoli runtime passano invariati,
 *   QUALSIASI altro valore → viewer (fail-closed, mai fail-open).
 */
export function normalizeSsoRole(claimRole: string): RuntimeRole {
  switch (claimRole) {
    case 'owner': return 'owner';
    case 'admin': return 'owner';
    case 'editor': return 'editor';
    case 'operator': return 'operator';
    case 'viewer': return 'viewer';
    case 'superadmin': return 'superadmin';
    case 'super_admin': return 'superadmin';
    default: return 'viewer';
  }
}

/**
 * Upsert user da JWT claim. Se l'utente non esiste localmente, lo crea con
 * password_hash sentinel "sso-only-{nanoid}" — login password disabilitato,
 * solo SSO funziona.
 */
function upsertSSOUser(claims: {
  sub: string;
  email: string;
  name: string;
  role: string;
  tenantId: string;
}): SSOUserRow {
  const { sqlite } = getDatabase();
  const existing = sqlite
    .prepare('SELECT id, tenant_id, email, display_name, role, enabled FROM users WHERE tenant_id = ? AND email = ?')
    .get(claims.tenantId, claims.email) as SSOUserRow | undefined;

  if (existing) {
    // Update last_login + role mapping in caso super_admin sia cambiato lato portal
    sqlite
      .prepare(
        'UPDATE users SET display_name = ?, role = ?, last_login_at = ?, updated_at = ? WHERE id = ?',
      )
      .run(claims.name, claims.role, new Date().toISOString(), new Date().toISOString(), existing.id);
    return { ...existing, display_name: claims.name, role: claims.role };
  }

  const id = nanoid();
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO users (id, tenant_id, email, display_name, password_hash, role, enabled, created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      id,
      claims.tenantId,
      claims.email,
      claims.name,
      `sso-only-${nanoid()}`,
      claims.role,
      now,
      now,
      now,
    );
  log.info?.({ userId: id, email: maskEmail(claims.email), tenantId: claims.tenantId }, '[SSO] new user provisioned via SSO');
  return {
    id,
    tenant_id: claims.tenantId,
    email: claims.email,
    display_name: claims.name,
    role: claims.role,
    enabled: 1,
  };
}

/**
 * Garantisce che la row tenants(id=tenantId) esista nel SQLite locale del
 * container. Senza questo step, `tenantStatusMiddleware` ritorna 404
 * (TenantNotFoundError) su ogni route protected — il container al boot ha
 * solo tenants(id='default') ma il JWE arriva con tenantId=UUID del workspace.
 *
 * Idempotent: INSERT OR IGNORE — se il tenant già esiste (created via prior
 * SSO o admin API), no-op silenzioso.
 *
 * Status default: 'active' (l'utente sta ENTRANDO nel suo workspace,
 * il portal ha già fatto tutti i check di provisioning/billing prima di
 * emettere il JWE). Plan default: 'enterprise' (no quota enforcement
 * locale — il portal è source-of-truth per quota).
 */


/**
 * Estrae il token dal request — POST-only (K5 hardening: token MAI in URL).
 *
 * Tre content-type supportati:
 *  - application/x-www-form-urlencoded (autosubmit form HTML, canonico)
 *  - multipart/form-data (alternativa form)
 *  - application/json (CLI clients)
 *
 * Il path GET è stato RIMOSSO (commento storico nel createSSORoutes).
 * Il route POST è l'unico mount, quindi questa function non viene mai
 * invocata con method !== 'POST' — defensive null guard kept minimal.
 */
async function extractSsoToken(c: Context): Promise<string | null> {
  const ct = (c.req.header('content-type') ?? '').toLowerCase();
  if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
    const body = await c.req.parseBody();
    const t = body.token;
    return typeof t === 'string' ? t : null;
  }
  if (ct.includes('application/json')) {
    const j = await c.req.json().catch(() => null) as { token?: unknown } | null;
    return j && typeof j.token === 'string' ? j.token : null;
  }
  return null;
}

async function verifyAndIssueSession(
  c: Context,
  token: string,
): Promise<Response> {
  const config = loadConfig();
  const secret = config.MEDEA_SSO_SECRET;
  const tenantId = config.MEDEA_TENANT_ID;
  if (!secret || !tenantId) {
    log.error?.('SSO not configured (MEDEA_SSO_SECRET or MEDEA_TENANT_ID missing)');
    return c.text('SSO not configured', 500);
  }

  let payload: Awaited<ReturnType<typeof jwtDecrypt>>['payload'];
  try {
    const key = deriveJweKey(secret);
    const decrypted = await jwtDecrypt(token, key, {
      issuer: 'portal.flowforge',
      audience: tenantId,
      clockTolerance: 30,
    });
    payload = decrypted.payload;
  } catch (err) {
    log.warn?.({ err: err instanceof Error ? err.message : err }, '[SSO] JWE decrypt failed');
    return c.text('Invalid SSO token', 401);
  }

  const jti = typeof payload.jti === 'string' ? payload.jti : null;
  if (!jti) return c.text('SSO token missing jti', 401);
  if (isReplay(jti)) {
    log.warn?.({ jti }, '[SSO][SECURITY] replay detected');
    return c.text('SSO token already used', 401);
  }

  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  const email = typeof payload.email === 'string' ? payload.email : '';
  const name = typeof payload.name === 'string' ? payload.name : email;
  // Normalizzazione vocabolario portal → runtime ('admin'→'owner',
  // 'super_admin'→'superadmin', sconosciuto→'viewer'). Vedi normalizeSsoRole.
  const role: RuntimeRole = normalizeSsoRole(typeof payload.role === 'string' ? payload.role : 'viewer');

  // H5 fix (2026-06-01) — Enforce strict tenant claim match.
  // Defense-in-depth: oltre alla `audience` validation di jose (linea 225),
  // verifica esplicita del custom field `payload.tenantId === env.MEDEA_TENANT_ID`.
  // Pre-fix: fallback `|| tenantId` consentiva accept se field missing →
  // safe ma asimmetrico col portal che lo emette sempre. Reject SE present
  // e mismatch, REJECT SE missing (no fallback).
  const tenantClaimRaw = typeof payload.tenantId === 'string' ? payload.tenantId : '';
  if (!tenantClaimRaw || tenantClaimRaw !== tenantId) {
    log.warn?.({
      expectedTenant: tenantId,
      receivedTenant: tenantClaimRaw || '<missing>',
      jti,
    }, '[SSO][SECURITY] tenant claim mismatch — rejected');
    return c.text('SSO token tenant mismatch', 401);
  }
  const tenantClaim = tenantClaimRaw;
  const tenantSlugClaim = typeof payload.tenantSlug === 'string' ? payload.tenantSlug : tenantClaim;
  const tenantNameClaim = typeof payload.tenantName === 'string' ? payload.tenantName : tenantSlugClaim;
  if (!sub || !email) return c.text('SSO token missing claims', 401);

  // ── ensureTenant: prima del user upsert, garantisce che tenants(tenantId)
  // esista con status='active'. Senza questo step, ogni route protected da
  // tenantStatusMiddleware ritorna 404 (TenantNotFoundError) — il container
  // ha al boot solo tenants(id='default') ma JWE arriva con tenantId=UUID
  // del workspace lato portal. Fix 2026-05-28 per bug "403 dashboard post
  // create workspace". Idempotent: INSERT OR IGNORE.
  // A2 free-trial: il portal (source-of-truth billing) porta lo stato nel claim.
  // 'trial' + trialEndsAt (createdAt+14gg) finché senza subscription; 'active'
  // quando paga. Claim assenti (token vecchio) → ensureTenant default 'active'.
  const trialEndsAtClaim = typeof payload.trialEndsAt === 'string' ? payload.trialEndsAt : null;
  const tenantStatusClaim = normalizeTenantStatusClaim(payload.tenantStatus);
  ensureTenant({
    tenantId: tenantClaim,
    displayName: tenantNameClaim,
    status: tenantStatusClaim,
    trialEndsAt: trialEndsAtClaim,
  });

  const user = upsertSSOUser({ sub, email, name, role, tenantId: tenantClaim });
  const keys = await getAuthKeys();
  const sessionToken = await issueSessionToken({
    userId: user.id,
    tenantId: user.tenant_id,
    role: user.role as 'owner' | 'editor' | 'operator' | 'viewer',
    email: user.email,
    privateKeyPem: keys.privateKeyPem,
  });

  // HIGH (2026-05-29): __Host- prefix in prod
  setCookie(c, sessionCookieName(), sessionToken, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: 7 * 86_400,
  });

  // PII redaction: NIENTE email in log — il container log è multi-tenant e
  // può essere shipped a logging aggregator esterno. userId è sufficiente
  // per audit trail (join con users.email in DB se serve email per debug).
  log.info?.({ userId: user.id, role, via: c.req.method }, '[SSO] session created');
  return c.redirect('/', 302);
}

export function createSSORoutes(): Hono {
  const app = new Hono();

  /**
   * POST /sso (body: token=...) — entry point CANONICO dal portal (K5).
   *
   * Il portal renderizza HTML autosubmit form → token mai in URL.
   * Su success: cookie ff_session + redirect /.
   * Su failure: 401 con messaggio chiaro.
   */
  app.post('/sso', async (c) => {
    const token = await extractSsoToken(c);
    if (!token) return c.text('SSO token missing', 400);
    return verifyAndIssueSession(c, token);
  });

  /**
   * GET /sso — fallback friendly per utenti che fanno refresh o navigano
   * direttamente all'URL (browser history, link condivisi). NON accetta
   * token in query (sarebbe leak in access_log) — invece mostra pagina
   * con CTA che ri-lancia il flow ufficiale dal portal `/sso/launch`.
   *
   * Fix 2026-05-31 (user-segnalato sub-user cucurachi84): refresh dopo
   * cold-start container mostrava 404 secco → ora pagina friendly +
   * link "Riprova" che ri-genera JWE dal portal.
   */
  app.get('/sso', (c) => {
    return Promise.resolve(c.html(`<!doctype html>
<html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sessione scaduta · Zeli FlowForge</title>
<style>
  html,body{margin:0;padding:0;height:100%;background:#0b0b0d;color:#f4f4f5;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,sans-serif}
  .w{display:flex;flex-direction:column;align-items:center;justify-content:center;
    height:100vh;gap:1rem;padding:1rem;text-align:center;max-width:480px;margin:0 auto}
  h1{font-size:1.4rem;margin:0;font-weight:600}
  p{color:#a1a1aa;font-size:14px;line-height:1.5;margin:0}
  a.btn{display:inline-block;padding:12px 24px;background:linear-gradient(135deg,#0ea5e9 0%,#6366f1 100%);
    color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;
    box-shadow:0 4px 12px rgba(14,165,233,0.3);transition:transform 150ms ease}
  a.btn:hover{transform:translateY(-1px)}
  .small{color:#71717a;font-size:12px;margin-top:1rem}
</style></head>
<body>
<div class="w">
  <h1>Sessione SSO scaduta</h1>
  <p>Per accedere al workflow, ricomincia dal portale. Il link che hai visitato
     non funziona da solo: il flusso SSO richiede un token monouso emesso dal portale.</p>
  <a class="btn" href="https://flowforge.automazionezeli.com/sso/launch">Apri FlowForge</a>
  <p class="small">Se il problema persiste, contatta <a href="mailto:info@zeli.it" style="color:#0ea5e9">info@zeli.it</a></p>
</div>
</body></html>`, 200));
  });

  return app;
}
