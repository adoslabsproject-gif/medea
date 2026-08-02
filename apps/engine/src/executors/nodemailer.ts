import { createTransport, type SendMailOptions } from 'nodemailer';
import { safeAttachmentPath } from '@/lib/mail-attachment-path.js';
import { assertConnectHostAllowed } from '@/lib/connect-host-guard.js';
import {
  sanitizeEmailHeader,
  sanitizeEmailList,
  sanitizeEmailWithDisplayName,
} from '@/lib/email-sanitize.js';
import { CircuitBreaker, CircuitBreakerRegistry } from '@medea/engine-shared';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { resolveBinaryValue, type BinaryData } from '@medea/engine-core-schema';
import { SystemEmailAccountsService } from '@/services/system-email-accounts.service.js';
import {
  EmailDeliverabilityService,
  type DeliverabilityReport,
} from '@/services/email-deliverability.service.js';
import { logger } from '@/lib/logger.js';

const systemEmailAccounts = new SystemEmailAccountsService();
const deliverabilityChecker = new EmailDeliverabilityService();

/**
 * In-memory cache TTL 1h per il deliverability check sul `fromAddress`.
 * Pattern: il DNS non cambia ad ogni send, ma il check costa ~1-2s.
 * Cache key = fromAddress, evita di rieseguire 30 dig identici/giorno.
 * LRU bounded a 200 entry (200 fromAddress diversi = già moltissimo).
 */
const DELIVERABILITY_CACHE_TTL_MS = 60 * 60_000;
const DELIVERABILITY_CACHE_MAX = 200;
const deliverabilityCache = new Map<string, { ts: number; report: DeliverabilityReport }>();

async function getDeliverabilityCached(
  fromAddress: string,
  smtpHost: string | undefined,
): Promise<DeliverabilityReport> {
  const now = Date.now();
  const cached = deliverabilityCache.get(fromAddress);
  if (cached && now - cached.ts < DELIVERABILITY_CACHE_TTL_MS) return cached.report;
  const report = await deliverabilityChecker.check(fromAddress, smtpHost);
  if (deliverabilityCache.size >= DELIVERABILITY_CACHE_MAX) {
    const oldest = deliverabilityCache.keys().next().value;
    if (oldest) deliverabilityCache.delete(oldest);
  }
  deliverabilityCache.set(fromAddress, { ts: now, report });
  return report;
}

interface Attachment {
  name?: string;
  filename?: string;
  path?: string;
  base64?: string;
  /** GAP 2: handle BinaryData (ref/inline) → risolto via resolveBinaryValue ai byte.
   *  È la forma PRIMARIA quando un upstream (file-read, pdf, http, imap) produce
   *  un allegato: l'email lo riceve come handle, non come base64 nel JSON. */
  binary?: BinaryData;
  url?: string;
  contentType?: string;
  cid?: string;
}

/** BinaryRefReader iniettato dal context dell'executor (legge i blob dal disco). */
type RefReader = (ref: string) => Promise<Buffer>;

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

async function parseAttachments(
  raw: unknown,
  readBinary?: RefReader,
  inline = false,
): Promise<SendMailOptions['attachments']> {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  let parsed: Attachment[];
  try {
    parsed = JSON.parse(raw) as Attachment[];
  } catch {
    throw new Error('action_send_email: attachments JSON is not valid');
  }
  return Promise.all(
    parsed.map(async (a) => {
      const att: NonNullable<SendMailOptions['attachments']>[number] = {
        filename: a.filename ?? a.name ?? 'attachment',
      };
      if (a.contentType) att.contentType = a.contentType;
      // GAP 2 — PRECEDENZA ESATTA (come nel codice qui sotto):
      //   binary (handle, PRIMARIO) > path (file su disco) > base64 (inline legacy) > url
      // L'handle BinaryData vince: resolveBinaryValue risolve i byte (trasparente:
      // ref su disco o inline). In pratica un allegato usa UNA sola fonte.
      const binBytes = await resolveBinaryValue(a, readBinary);
      if (binBytes) att.content = binBytes;
      // `path`/`url` → SOLO URL http(s) validati SSRF (mai un path su filesystem: LFI →
      // allegare /app/.env esfiltrerebbe i segreti del container). Vedi safeAttachmentPath.
      else if (a.path) att.path = safeAttachmentPath(a.path);
      else if (a.base64) att.content = Buffer.from(a.base64, 'base64');
      else if (a.url) att.path = safeAttachmentPath(a.url);
      if (inline) {
        // Content-ID for inline images. Default to the filename when not set
        // so <img src="cid:logo.png"> works without extra config.
        att.cid = a.cid ?? a.filename ?? a.name ?? 'inline';
        att.contentDisposition = 'inline';
      }
      return att;
    }),
  );
}

/** Nome header valido = token RFC 5322 semplificato (lettere/cifre/trattino). */
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;

function parseHeadersJson(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      // Il NOME header è input dell'autore: deve essere un token valido (no `:`, no
      // CRLF → niente header-injection/forgiatura via il nome). Header non conforme
      // → scartato (non silenziato: nomi validi passano, gli storti non entrano).
      if (!HEADER_NAME_RE.test(k)) continue;
      // Il VALORE è sanitizzato contro CRLF (difesa-in-profondità oltre a nodemailer).
      out[k] = sanitizeEmailHeader(String(v));
    }
    return out;
  } catch {
    return undefined;
  }
}

export const sendEmailExecutor: NodeExecutor = async (config, _input, context) => {
  const start = Date.now();

  const systemAccountId = asString(config.systemAccountId);
  let host = asString(config.host);
  let port = Number(config.port ?? 587);
  let security = asString(config.security ?? 'starttls');
  let username = asString(config.username);
  let password = asString(config.password);
  let from = asString(config.from);

  // XOAUTH2 token bookkeeping. When the account is OAuth2 (Gmail), we
  // populate `accessToken` here and pass it to nodemailer below via
  // `auth: { type: 'OAuth2', user, accessToken }`. `password` stays empty.
  let oauth2AccessToken = '';
  let oauth2User = '';
  if (systemAccountId) {
    const account = systemEmailAccounts.resolveForExecutor(context.tenantId, systemAccountId);
    if (!account) {
      throw new Error(`System email account ${systemAccountId} non trovato per il tenant`);
    }
    host = account.smtp.host;
    port = account.smtp.port;
    security = account.smtp.security;
    username = account.smtp.username;
    password = account.smtp.password ?? '';
    if (!from) from = account.fromAddress;

    if (account.authType === 'oauth2') {
      // Fetch + auto-refresh BEFORE building the transport. Without a fresh
      // token nodemailer XOAUTH2 dies with 'invalid_grant' inside the auth
      // handshake — VERY hard to debug from a log line. We make the failure
      // explicit: send-time refresh failure → throw with the email upfront.
      const tokens = systemEmailAccounts.resolveOAuthForExecutor(context.tenantId, systemAccountId);
      if (!tokens) {
        throw new Error(
          `account ${systemAccountId} marked authType=oauth2 but tokens missing — re-link via Settings`,
        );
      }
      const { EmailOAuthService } = await import('@/services/email-oauth.service.js');
      const oauthSvc = new EmailOAuthService();
      if (EmailOAuthService.needsRefresh(tokens.expiresAt)) {
        try {
          const refreshed = await oauthSvc.refreshAccessToken(tokens.refreshToken);
          systemEmailAccounts.updateOAuthAccessToken({
            tenantId: context.tenantId,
            accountId: systemAccountId,
            accessToken: refreshed.accessToken,
            expiresAt: refreshed.expiresAt,
          });
          oauth2AccessToken = refreshed.accessToken;
        } catch (err) {
          throw new Error(
            `OAuth refresh failed for ${tokens.email}: ${err instanceof Error ? err.message : String(err)} — re-link the Gmail account in Settings.`,
          );
        }
      } else {
        oauth2AccessToken = tokens.accessToken;
      }
      oauth2User = tokens.email;
    }
  }

  const to = asString(config.to);
  const subject = asString(config.subject);
  const body = asString(config.body);
  const bodyType = asString(config.bodyType ?? 'html');
  const cc = asString(config.cc);
  const bcc = asString(config.bcc);
  const replyTo = asString(config.replyTo);
  const inReplyTo = asString(config.inReplyTo);
  const references = asString(config.references);
  const priority = asString(config.priority ?? 'normal');

  if (!host || !from || !to || !subject) {
    throw new Error(
      'action_send_email: host/from/to/subject all required (configura System Email Account in Settings o compila i campi inline)',
    );
  }

  // Defensive guard: if the upstream node failed to produce data, the
  // interpolated subject/body still contain literal `{{expression}}` tokens
  // (interpolation maps undefined → empty string for SUB-fields, but the
  // outer template may still leak braces if the user mis-typed). Detect &
  // refuse to send. Prevents the bogus "Ordine — — compilare" emails we saw
  // in the WF1 dry-run cascade.
  if (/\{\{[^}]+\}\}/.test(subject)) {
    throw new Error(
      `action_send_email: subject contains unresolved {{...}} template — upstream data missing? Subject was: "${subject.slice(0, 200)}"`,
    );
  }
  if (/\{\{[^}]+\}\}/.test(body)) {
    throw new Error(
      `action_send_email: body contains unresolved {{...}} template — upstream data missing?`,
    );
  }

  // ───────────────────────────────────────────────────────────────────
  // Pre-flight deliverability check (SPF/DKIM/DMARC sul dominio sender)
  // ───────────────────────────────────────────────────────────────────
  // Pattern: cold outreach + DKIM mancante = 60% email in spam → reputation
  // dominio bruciata in 1 settimana. Meglio fallire fast E2E che mandare 30
  // email/day che non arrivano.
  //
  // Modalità:
  //   • deliverabilityCheck = "off"   → skip (default per back-compat)
  //   • deliverabilityCheck = "warn"  → log warning ma manda comunque
  //   • deliverabilityCheck = "strict" → throw se SPF/DKIM/DMARC mancanti
  //                                    (consigliato per workflow lead-gen)
  //
  // Cache 1h sulla coppia (fromAddress, smtpHost) → costo aggiunto trascurabile.
  // L'output del nodo include sempre `deliverabilityReport` (anche in "off")
  // così il RunInspector mostra lo stato all'utente.
  const deliverabilityMode = (asString(config.deliverabilityCheck) || 'off').toLowerCase();
  let deliverabilityReport: DeliverabilityReport | null = null;
  if (deliverabilityMode !== 'off' && from) {
    try {
      deliverabilityReport = await getDeliverabilityCached(from, host);
      if (!deliverabilityReport.ok && deliverabilityMode === 'strict') {
        const missing: string[] = [];
        if (!deliverabilityReport.spf.ok) missing.push('SPF');
        if (!deliverabilityReport.dkim.ok) missing.push('DKIM');
        if (!deliverabilityReport.dmarc.ok) missing.push('DMARC');
        throw new Error(
          `action_send_email: deliverabilityCheck=strict ma ${missing.join('+')} mancanti sul dominio "${deliverabilityReport.domain}". ` +
            `${deliverabilityReport.summary} ` +
            `Per disabilitare il check: cambia "deliverabilityCheck" a "off" o "warn" nel nodo.`,
        );
      }
      if (!deliverabilityReport.ok) {
        logger.warn(
          {
            tenantId: context.tenantId,
            workflowId: context.workflowId,
            nodeId: context.nodeId,
            fromAddress: from,
            deliverability: deliverabilityReport.summary,
          },
          'Email deliverability sub-optimal — invio comunque (mode=warn)',
        );
      }
    } catch (e) {
      if (deliverabilityMode === 'strict') throw e;
      logger.warn(
        { err: e, fromAddress: from },
        'Deliverability check failed (non-strict mode, continuing)',
      );
    }
  }

  // DKIM (optional inline signing).
  const dkimDomain = asString(config.dkimDomain);
  const dkimSelector = asString(config.dkimSelector);
  const dkimPrivateKey = asString(config.dkimPrivateKey);
  const dkim =
    dkimDomain && dkimSelector && dkimPrivateKey
      ? { domainName: dkimDomain, keySelector: dkimSelector, privateKey: dkimPrivateKey }
      : undefined;

  // Auth in 3 modalità (priorità decrescente):
  //  1. systemAccount OAuth — oauth2AccessToken già risolto sopra (oauth-connect).
  //  2. OAuth2 INLINE (authMode=oauth2) — nodemailer scambia il refresh token per un
  //     access token a ogni invio: niente storage di token lato nostro, scope minimale
  //     gmail.send, revocabile. Solo quando NON c'è un systemAccount.
  //  3. SMTP user/password classico.
  const authMode = asString(config.authMode || 'password');
  const inlineOauth = !systemAccountId && authMode === 'oauth2';
  if (inlineOauth) {
    const missing: string[] = [];
    if (!asString(config.oauthUser) && !username) missing.push('oauthUser');
    if (!asString(config.oauthClientId)) missing.push('oauthClientId');
    if (!asString(config.oauthClientSecret)) missing.push('oauthClientSecret');
    if (!asString(config.oauthRefreshToken)) missing.push('oauthRefreshToken');
    if (missing.length > 0) {
      throw new Error(
        `action_send_email: authMode=oauth2 ma mancano i campi OAuth: ${missing.join(', ')}`,
      );
    }
  }

  // SSRF: l'host SMTP può venire inline da config (path senza systemAccountId) →
  // blocca host interni/privati (allowlist operatore esclusa). Vale anche per il
  // path systemAccount (difesa-in-profondità oltre al guard all'upsert).
  assertConnectHostAllowed(host, 'SMTP');
  const transport = createTransport({
    host,
    port,
    secure: security === 'tls',
    requireTLS: security === 'starttls',
    auth: oauth2AccessToken
      ? { type: 'OAuth2', user: oauth2User, accessToken: oauth2AccessToken }
      : inlineOauth
        ? {
            type: 'OAuth2',
            user: asString(config.oauthUser) || username,
            clientId: asString(config.oauthClientId),
            clientSecret: asString(config.oauthClientSecret),
            refreshToken: asString(config.oauthRefreshToken),
            // accessToken omesso: nodemailer lo ricava dal refreshToken.
          }
        : username
          ? { user: username, pass: password }
          : undefined,
    ...(dkim ? { dkim } : {}),
  });

  const attachments = await parseAttachments(config.attachmentsJson, context.readBinary, false);
  const inlineImages = await parseAttachments(config.inlineImagesJson, context.readBinary, true);
  const allAttachments = [...(attachments ?? []), ...(inlineImages ?? [])];

  const headers = parseHeadersJson(config.headersJson) ?? {};

  // Threading headers — manual since SendMailOptions.references / inReplyTo
  // are passthrough, but providers like Gmail are picky about angle brackets.
  if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
  if (references) headers.References = references;

  // Priority — nodemailer has `priority` but it ALSO needs the legacy
  // X-Priority + Importance headers for old clients (Outlook 2010, etc).
  if (priority === 'high') {
    headers['X-Priority'] = '1';
    headers.Importance = 'High';
  } else if (priority === 'low') {
    headers['X-Priority'] = '5';
    headers.Importance = 'Low';
  }

  // Sanitize tutti i campi indirizzo + subject contro CRLF header injection
  // (audit 2026-05-31). RFC 5322: reject \r/\n/\0 in email; strip in subject.
  const message: SendMailOptions = {
    from: sanitizeEmailWithDisplayName(from),
    to: sanitizeEmailList(to),
    subject: sanitizeEmailHeader(subject),
  };
  if (cc) message.cc = sanitizeEmailList(cc);
  if (bcc) message.bcc = sanitizeEmailList(bcc);
  if (replyTo) message.replyTo = sanitizeEmailWithDisplayName(replyTo);
  if (Object.keys(headers).length > 0) message.headers = headers;
  if (bodyType === 'html') message.html = body;
  else if (bodyType === 'markdown') {
    // Lightweight: pass markdown as both html and text. nodemailer doesn't
    // render markdown itself, but downstream clients will display the
    // plain-text fallback while the HTML preserves the formatting.
    message.html = body;
    message.text = body;
  } else {
    message.text = body;
  }
  if (allAttachments.length > 0) message.attachments = allAttachments;
  if (priority === 'high' || priority === 'low') {
    message.priority = priority === 'high' ? 'high' : 'low';
  }

  // Per-host SMTP circuit breaker — if Gmail/IONOS/SES/etc. throttles us
  // or returns 4xx repeatedly, fail fast for 60s rather than queueing
  // every workflow node behind a tcp-timeout chain.
  const breakerName = `smtp:${host}:${port.toString()}`;
  const breaker =
    CircuitBreakerRegistry.getInstance().get(breakerName) ??
    new CircuitBreaker<unknown>(breakerName, {
      failureThreshold: 5,
      windowMs: 60_000,
      cooldownMs: 60_000,
    });

  const info = await breaker.execute(async () => {
    try {
      return await transport.sendMail(message);
    } finally {
      transport.close();
    }
  });

  return {
    output: {
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response,
      // Deliverability report incluso nell'output quando il check è abilitato.
      // Pattern: RunInspector ha già la card "smart card" per JSON nested,
      // quindi l'utente vede SPF/DKIM/DMARC status direttamente sotto al
      // messageId, senza click extra. Null se mode=off (default).
      ...(deliverabilityReport ? { deliverability: deliverabilityReport } : {}),
    },
    durationMs: Date.now() - start,
  };
};
