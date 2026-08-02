/**
 * /api/v1/system/email-accounts — manage pre-configured SMTP/IMAP accounts.
 *
 *   GET    /                — list (any authenticated user; returns non-secret fields only)
 *   GET    /picker          — minimal payload for editor dropdowns
 *   GET    /default         — the default account for this tenant (or null)
 *   POST   /                — create (superadmin)
 *   PUT    /:id             — update (superadmin)
 *   DELETE /:id             — delete (superadmin)
 *   POST   /:id/test        — connect to SMTP and verify auth (superadmin) — no email sent
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { createTransport } from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { SystemEmailAccountsService, type SystemEmailAccount } from '@/services/system-email-accounts.service.js';
import { EmailDeliverabilityService, type DeliverabilityReport } from '@/services/email-deliverability.service.js';
import { requireRole } from '@/middleware/rbac.js';
import { logger } from '@/lib/logger.js';
import { getTenantId } from '@/lib/tenant.js';
import { getActorId } from '@/lib/actor.js';
import { AuditLogService } from '@/services/audit.service.js';
import { validateUrlForFetch, assertUrlSafe } from '@medea/engine-safe-fetch';
import { rateLimit } from '@/middleware/rate-limit.js';

const audit = new AuditLogService();

// I /test si connettono a SMTP/IMAP (handshake reale) → costosi e abusabili.
// Sliding-window per (tenant,user). N3 audit: senza, un click-loop o script
// satura connessioni e GC. Manuale → limiti generosi ma finiti.
const emailTestRateLimit = rateLimit({ windowMs: 60_000, perUser: 10, perTenant: 20, label: 'email-test' });

// SSRF/port-scan: l'host SMTP/IMAP è input utente e a runtime ci si CONNETTE
// (createTransport / ImapFlow). Senza guard un owner poteva puntarlo a host
// interni (172.20.0.1 gateway/Redis, localhost, RFC1918) e usare il /test come
// port-scanner della rete del server. Accettiamo solo host PUBBLICI.
function isPublicMailHost(host: string): boolean {
  return validateUrlForFetch(`https://${host}`).ok;
}
const HOST_SSRF_MSG = 'host interno/privato/localhost bloccato (protezione SSRF): usa un mail server pubblico';

const UpsertSchema = z.object({
  label: z.string().min(1).max(120),
  fromAddress: z.string().email(),
  isDefault: z.boolean().default(false),
  smtp: z.object({
    host: z.string().min(1).refine(isPublicMailHost, { message: HOST_SSRF_MSG }),
    port: z.number().int().positive(),
    security: z.enum(['tls', 'starttls', 'plain']),
    username: z.string().min(1),
    /** Empty string means "keep existing password" on UPDATE. Required on CREATE. */
    password: z.string(),
  }),
  imap: z.object({
    host: z.string().min(1).refine(isPublicMailHost, { message: HOST_SSRF_MSG }),
    port: z.number().int().positive(),
    username: z.string().min(1),
    password: z.string(),
  }).optional(),
});

export function createSystemEmailAccountsRoutes(): Hono {
  const app = new Hono();
  const service = new SystemEmailAccountsService();

  app.get('/', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    return c.json({ accounts: service.list(getTenantId(c)) });
  });

  app.get('/picker', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    return c.json({ accounts: service.picker(getTenantId(c)) });
  });

  app.get('/default', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    return c.json({ account: service.getDefault(getTenantId(c)) });
  });

  app.post('/', requireRole('owner'), zValidator('json', UpsertSchema), async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const body = c.req.valid('json');
    if (!body.smtp.password) return c.json({ error: 'SMTP password obbligatoria alla creazione' }, 400);
    const tenantId = getTenantId(c);
    const upsertArgs: Parameters<typeof service.upsert>[0] = {
      tenantId,
      label: body.label,
      fromAddress: body.fromAddress,
      isDefault: body.isDefault,
      smtp: body.smtp,
    };
    if (body.imap) upsertArgs.imap = body.imap;
    const created = service.upsert(upsertArgs);
    const actorId = getActorId(c) ?? undefined;
    await audit.append({
      tenantId,
      action: 'email_account.create',
      resourceType: 'email_account',
      resourceId: created.id,
      ...(actorId !== undefined ? { actorId } : {}),
      metadata: { label: body.label, fromAddress: body.fromAddress, isDefault: body.isDefault },
    });
    return c.json({ account: created }, 201);
  });

  app.put('/:id', requireRole('owner'), zValidator('json', UpsertSchema), async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const id = c.req.param('id');
    const body = c.req.valid('json');
    const tenantId = getTenantId(c);
    const upsertArgs: Parameters<typeof service.upsert>[0] = {
      tenantId,
      label: body.label,
      fromAddress: body.fromAddress,
      isDefault: body.isDefault,
      smtp: body.smtp,
    };
    if (body.imap) upsertArgs.imap = body.imap;
    const updated = service.upsert(upsertArgs, id);
    const actorId = getActorId(c) ?? undefined;
    await audit.append({
      tenantId,
      action: 'email_account.update',
      resourceType: 'email_account',
      resourceId: id ?? '',
      ...(actorId !== undefined ? { actorId } : {}),
      metadata: { label: body.label, fromAddress: body.fromAddress, isDefault: body.isDefault },
    });
    return c.json({ account: updated });
  });

  app.delete('/:id', requireRole('owner'), async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const id = c.req.param('id');
    const tenantId = getTenantId(c);
    const ok = service.delete(id, tenantId);
    const actorId = getActorId(c) ?? undefined;
    await audit.append({
      tenantId,
      action: 'email_account.delete',
      resourceType: 'email_account',
      resourceId: id ?? '',
      ...(actorId !== undefined ? { actorId } : {}),
      metadata: { deleted: ok },
    });
    return c.json({ deleted: ok });
  });

  // SMTP connectivity test — authenticate but DON'T send an email.
  // Supports BOTH password auth (legacy) and OAuth2 (Gmail XOAUTH2).
  app.post('/:id/test', requireRole('owner'), emailTestRateLimit, async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const id = c.req.param('id');
    const tenantId = getTenantId(c);
    const acct = service.resolveForExecutor(tenantId, id);
    if (!acct) return c.json({ error: 'Account non trovato' }, 404);
    // Difesa-in-profondità SSRF: blocca un host interno eventualmente salvato
    // pre-guard (il gate primario è il refine dell'UpsertSchema).
    assertUrlSafe(`https://${acct.smtp.host}`);

    let smtpAuth: { type: 'OAuth2'; user: string; accessToken: string } | { user: string; pass: string } | undefined;
    try {
      smtpAuth = await resolveSmtpAuth(acct, tenantId, id, service);
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
    }

    const transporter = createTransport({
      host: acct.smtp.host,
      port: acct.smtp.port,
      secure: acct.smtp.security === 'tls',
      requireTLS: acct.smtp.security === 'starttls',
      auth: smtpAuth,
      connectionTimeout: 10_000,
    });
    try {
      await transporter.verify();
      return c.json({ ok: true, message: `Connessione SMTP a ${acct.smtp.host}:${acct.smtp.port.toString()} riuscita ✓ (${acct.authType === 'oauth2' ? 'OAuth2' : 'password'})` });
    } catch (err) {
      logger.warn({ err, id }, 'SMTP verify failed');
      return c.json({
        ok: false,
        error: err instanceof Error ? err.message : 'Connessione fallita',
      }, 502);
    } finally {
      transporter.close();
    }
  });

  // Full diagnostic — Outlook-style "test all" that verifies SMTP + IMAP +
  // optionally sends/receives a probe email. Returns a structured step-by-step
  // report so the UI can render a checklist with green/red per phase.
  app.post('/:id/test-full', requireRole('owner'), emailTestRateLimit, async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const id = c.req.param('id');
    const acct = service.resolveForExecutor(getTenantId(c), id);
    if (!acct) return c.json({ error: 'Account non trovato' }, 404);
    // Difesa-in-profondità SSRF su host SMTP+IMAP (gate primario = refine upsert).
    assertUrlSafe(`https://${acct.smtp.host}`);
    if (acct.imap?.host) assertUrlSafe(`https://${acct.imap.host}`);
    let body: { sendProbe?: boolean; probeRecipient?: string } = {};
    try { body = await c.req.json(); } catch { /* empty body ok */ }

    interface Step { phase: string; ok: boolean; latencyMs: number; detail?: string; error?: string }
    const steps: Step[] = [];
    let deliverability: DeliverabilityReport | null = null;

    // ── Phase 1: SMTP verify (connect + STARTTLS + AUTH, no email sent) ────
    // Supports both legacy password auth and OAuth2 (Gmail XOAUTH2).
    {
      const t0 = Date.now();
      const tenantId = getTenantId(c);
      let smtpAuth: { type: 'OAuth2'; user: string; accessToken: string } | { user: string; pass: string } | undefined;
      try {
        smtpAuth = await resolveSmtpAuth(acct, tenantId, id, service);
      } catch (err) {
        steps.push({ phase: 'smtp_verify', ok: false, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : String(err) });
        // Skip the rest of the SMTP block; transporter never created.
      }
      if (smtpAuth || steps[steps.length - 1]?.phase !== 'smtp_verify') {
        const transporter = createTransport({
          host: acct.smtp.host,
          port: acct.smtp.port,
          secure: acct.smtp.security === 'tls',
          requireTLS: acct.smtp.security === 'starttls',
          auth: smtpAuth,
          connectionTimeout: 10_000,
        });
        try {
          await transporter.verify();
          steps.push({ phase: 'smtp_verify', ok: true, latencyMs: Date.now() - t0, detail: `${acct.smtp.host}:${acct.smtp.port.toString()} (${acct.smtp.security}, ${acct.authType === 'oauth2' ? 'OAuth2' : 'password'})` });
        } catch (err) {
          steps.push({ phase: 'smtp_verify', ok: false, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : String(err) });
        } finally {
          transporter.close();
        }
      }
    }

    // ── Phase 2: IMAP connect + login (skip if account has no IMAP) ────────
    if (acct.imap?.host) {
      const t0 = Date.now();
      const tenantId = getTenantId(c);
      let imapAuth: { user: string; accessToken: string } | { user: string; pass: string } | null = null;
      try {
        imapAuth = await resolveImapAuth(acct, tenantId, id, service);
      } catch (err) {
        steps.push({ phase: 'imap_connect', ok: false, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : String(err) });
      }
      if (!imapAuth) {
        // Step already pushed by error branch above; jump out of IMAP block.
      } else {
      const client = new ImapFlow({
        host: acct.imap.host,
        port: acct.imap.port,
        secure: true,
        auth: imapAuth,
        logger: false,
      });
      try {
        await client.connect();
        steps.push({ phase: 'imap_connect', ok: true, latencyMs: Date.now() - t0, detail: `${acct.imap.host}:${acct.imap.port.toString()} TLS` });

        const t1 = Date.now();
        const lock = await client.getMailboxLock('INBOX');
        const status = await client.status('INBOX', { messages: true, unseen: true });
        lock.release();
        steps.push({
          phase: 'imap_inbox',
          ok: true,
          latencyMs: Date.now() - t1,
          detail: `INBOX accessibile · ${status.messages?.toString() ?? '?'} messaggi · ${status.unseen?.toString() ?? '?'} non letti`,
        });
        await client.logout();
      } catch (err) {
        steps.push({ phase: 'imap_connect', ok: false, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : String(err) });
        try { client.close(); } catch { /* ignore */ }
      }
      } // chiude else `if (imapAuth)`
    }

    // ── Phase 3: probe email (opt-in) — send to self, immediately retrieve ─
    // Only runs when the client passed `sendProbe: true` AND prior phases ok.
    if (body.sendProbe === true) {
      const smtpOk = steps.find((s) => s.phase === 'smtp_verify')?.ok;
      if (!smtpOk) {
        steps.push({ phase: 'probe_send', ok: false, latencyMs: 0, error: 'SMTP non funziona — probe annullata' });
      } else {
        // Recipient: caller-provided (best for deliverability), else fromAddress.
        // Note on "to-self": many providers silently drop email where from===to
        // because the pattern matches spam-loopback fingerprints. We log a
        // diagnostic hint when the recipient equals fromAddress so the operator
        // can suspect the delivery rather than the configuration.
        const recipient = body.probeRecipient?.trim() || acct.fromAddress;
        const isLoopback = recipient.toLowerCase() === acct.fromAddress.toLowerCase();

        const t0 = Date.now();
        const subject = `FlowForge test probe · ${new Date().toISOString()}`;
        const tenantId = getTenantId(c);
        let probeAuth: { type: 'OAuth2'; user: string; accessToken: string } | { user: string; pass: string } | undefined;
        try {
          probeAuth = await resolveSmtpAuth(acct, tenantId, id, service);
        } catch (err) {
          steps.push({ phase: 'probe_send', ok: false, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : String(err) });
          probeAuth = undefined;
        }
        const transporter = probeAuth ? createTransport({
          host: acct.smtp.host,
          port: acct.smtp.port,
          secure: acct.smtp.security === 'tls',
          requireTLS: acct.smtp.security === 'starttls',
          auth: probeAuth,
          connectionTimeout: 15_000,
        }) : null;
        if (!transporter) {
          // probe skipped — auth couldn't be built (step already pushed)
        } else {
        try {
          logger.info({ accountId: id, recipient, isLoopback }, 'Sending probe email');
          const info = await transporter.sendMail({
            from: acct.fromAddress,
            to: recipient,
            subject,
            text: 'Questo è un test automatico di FlowForge per verificare la configurazione SMTP.\nSe lo ricevi (controlla anche lo spam), il setup funziona ✓',
            headers: {
              'X-FlowForge-Probe': '1',
              'X-FlowForge-Account-Id': id,
            },
          });
          logger.info({ accountId: id, messageId: info.messageId, accepted: info.accepted, rejected: info.rejected }, 'Probe email accepted by SMTP server');
          const detail = isLoopback
            ? `Inviata a ${recipient} (loopback — controlla anche SPAM) · ${info.messageId ?? ''}`
            : `Inviata a ${recipient} · ${info.messageId ?? ''}`;
          steps.push({ phase: 'probe_send', ok: true, latencyMs: Date.now() - t0, detail });
        } catch (err) {
          logger.warn({ err, accountId: id, recipient }, 'Probe send failed');
          steps.push({ phase: 'probe_send', ok: false, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : String(err) });
        } finally {
          transporter.close();
        }
        } // chiude else `if (transporter)`
      }
    }

    // ── Phase 4: DNS deliverability (always runs, fast — ≤ 5s parallel) ────
    // Reports SPF / DKIM / DMARC for the sender domain so the operator
    // knows BEFORE sending to real customers whether Gmail/Outlook will
    // accept the email or route it to spam.
    {
      const t0 = Date.now();
      try {
        const checker = new EmailDeliverabilityService();
        deliverability = await checker.check(acct.fromAddress, acct.smtp.host);
        steps.push({
          phase: 'deliverability_dns',
          ok: deliverability.ok,
          latencyMs: Date.now() - t0,
          detail: deliverability.summary,
        });
      } catch (err) {
        steps.push({
          phase: 'deliverability_dns',
          ok: false,
          latencyMs: Date.now() - t0,
          error: err instanceof Error ? err.message : 'DNS check failed',
        });
      }
    }

    const allOk = steps.every((s) => s.ok);
    return c.json({ ok: allOk, steps, deliverability });
  });

  return app;
}

/**
 * Costruisce l'oggetto `auth` per nodemailer dato un account email.
 * Per account `authType='oauth2'` (Gmail XOAUTH2): risolve refresh+access
 * token dal vault e refresh automatico se scaduto (stesso flow del nodo
 * action_send_email runtime). Per `authType='password'` (default): user+pass
 * classico decrittato dal vault.
 *
 * Throws con messaggio chiaro se l'account non e\` configurabile (es. oauth
 * senza tokens o password vuota), cosi\` il test endpoint mostra la causa.
 */
async function resolveSmtpAuth(
  acct: SystemEmailAccount,
  tenantId: string,
  accountId: string,
  service: SystemEmailAccountsService,
): Promise<{ type: 'OAuth2'; user: string; accessToken: string } | { user: string; pass: string }> {
  if (acct.authType === 'oauth2') {
    const tokens = service.resolveOAuthForExecutor(tenantId, accountId);
    if (!tokens) throw new Error('Account OAuth2 ma tokens mancanti — riconnetti Gmail in Settings');
    const accessToken = await ensureFreshAccessToken(tokens, tenantId, accountId, service);
    return { type: 'OAuth2', user: tokens.email, accessToken };
  }
  if (!acct.smtp.password) throw new Error('Password SMTP mancante — riconfigura l\'account');
  return { user: acct.smtp.username, pass: acct.smtp.password };
}

/**
 * Variante IMAP: ImapFlow accetta `{user, accessToken}` per XOAUTH2 (non
 * `type: 'OAuth2'` come nodemailer). Stesso refresh-on-stale del SMTP path.
 */
async function resolveImapAuth(
  acct: SystemEmailAccount,
  tenantId: string,
  accountId: string,
  service: SystemEmailAccountsService,
): Promise<{ user: string; accessToken: string } | { user: string; pass: string }> {
  if (!acct.imap) throw new Error('IMAP non configurato per questo account');
  if (acct.authType === 'oauth2') {
    const tokens = service.resolveOAuthForExecutor(tenantId, accountId);
    if (!tokens) throw new Error('Account OAuth2 ma tokens mancanti — riconnetti Gmail in Settings');
    const accessToken = await ensureFreshAccessToken(tokens, tenantId, accountId, service);
    return { user: tokens.email, accessToken };
  }
  if (!acct.imap.password) throw new Error('Password IMAP mancante — riconfigura l\'account');
  return { user: acct.imap.username, pass: acct.imap.password };
}

/**
 * Ritorna un access token valido per l'account OAuth2. Se quello esistente
 * e\` scaduto (o sta per scadere entro EmailOAuthService.needsRefresh), lo
 * rinnova via portal e aggiorna il vault. Pattern identico a executor
 * nodemailer.ts:142-160 — qui DRY per test endpoint.
 */
async function ensureFreshAccessToken(
  tokens: { accessToken: string; refreshToken: string; expiresAt: Date; email: string },
  tenantId: string,
  accountId: string,
  service: SystemEmailAccountsService,
): Promise<string> {
  const { EmailOAuthService } = await import('@/services/email-oauth.service.js');
  if (EmailOAuthService.needsRefresh(tokens.expiresAt)) {
    const oauthSvc = new EmailOAuthService();
    try {
      const refreshed = await oauthSvc.refreshAccessToken(tokens.refreshToken);
      service.updateOAuthAccessToken({
        tenantId,
        accountId,
        accessToken: refreshed.accessToken,
        expiresAt: refreshed.expiresAt,
      });
      return refreshed.accessToken;
    } catch (err) {
      throw new Error(`OAuth refresh fallito per ${tokens.email}: ${err instanceof Error ? err.message : String(err)} — riconnetti l'account Gmail in Settings.`);
    }
  }
  return tokens.accessToken;
}
