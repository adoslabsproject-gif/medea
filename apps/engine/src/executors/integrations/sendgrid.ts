/**
 * SendGrid executor — Mail Send API v3 (Bearer API key).
 *
 * Operazioni: sendEmail (to/from/subject/body text|html), sendTemplate
 * (templateId + dynamicTemplateData). Credenziali vault: { apiKey } (SG....).
 * HTTP via jsonFetch → safeOutboundFetch (SSRF + breaker + timeout) + withRetry.
 * Email validate (sintassi base), errori tipizzati IntegrationError. SendGrid
 * risponde 202 senza body → output deterministico { accepted: true }.
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { IntegrationError, requireIntegration, withRetry } from './common.js';
import { jsonFetch, getIntegrationLabel, parseJsonObj } from './saas-shared.js';

interface SendgridCreds {
  apiKey?: string;
}

function assertEmail(v: string, field: string): string {
  const e = v.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    throw new IntegrationError({
      provider: 'sendgrid',
      code: 'INVALID_PAYLOAD',
      message: `${field} non è un'email valida: "${v}"`,
    });
  }
  return e;
}

export const sendgridExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const operation = coerceString(cfg.operation ?? 'sendEmail');

  const integ = requireIntegration({
    provider: 'sendgrid',
    tenantId: context.tenantId,
    label: getIntegrationLabel(cfg),
  });
  const apiKey = (integ.credentials as SendgridCreds).apiKey;
  if (!apiKey)
    throw new IntegrationError({
      provider: 'sendgrid',
      code: 'INVALID_CREDENTIALS',
      message: 'apiKey assente nel vault',
    });
  const headers = { Authorization: `Bearer ${apiKey}` };

  const to = assertEmail(coerceString(cfg.to ?? ''), 'to');
  const from = assertEmail(coerceString(cfg.from ?? ''), 'from');
  const fromName = coerceString(cfg.fromName ?? '').trim();
  const fromObj = fromName ? { email: from, name: fromName } : { email: from };
  const replyToRaw = coerceString(cfg.replyTo ?? '').trim();

  const body: Record<string, unknown> = {
    personalizations: [{ to: [{ email: to }] }],
    from: fromObj,
  };
  if (replyToRaw) body.reply_to = { email: assertEmail(replyToRaw, 'replyTo') };

  if (operation === 'sendTemplate') {
    const templateId = coerceString(cfg.templateId ?? '').trim();
    if (!templateId)
      throw new IntegrationError({
        provider: 'sendgrid',
        code: 'INVALID_PAYLOAD',
        message: 'templateId obbligatorio per sendTemplate',
      });
    body.template_id = templateId;
    const dyn = parseJsonObj('sendgrid', cfg.dynamicDataJson, 'dynamicDataJson');
    (body.personalizations as Record<string, unknown>[])[0]!.dynamic_template_data = dyn;
  } else if (operation === 'sendEmail') {
    const subject = coerceString(cfg.subject ?? '').trim();
    if (!subject)
      throw new IntegrationError({
        provider: 'sendgrid',
        code: 'INVALID_PAYLOAD',
        message: 'subject obbligatorio per sendEmail',
      });
    const content = coerceString(cfg.body ?? '').trim();
    if (!content)
      throw new IntegrationError({
        provider: 'sendgrid',
        code: 'INVALID_PAYLOAD',
        message: 'body obbligatorio per sendEmail',
      });
    const type =
      coerceString(cfg.contentType ?? 'text/plain') === 'text/html' ? 'text/html' : 'text/plain';
    body.subject = subject;
    body.content = [{ type, value: content }];
  } else {
    throw new IntegrationError({
      provider: 'sendgrid',
      code: 'INVALID_PAYLOAD',
      message: `operation "${operation}" non supportata (sendEmail/sendTemplate)`,
    });
  }

  await withRetry(
    async () => {
      // SendGrid /mail/send → 202 Accepted senza body. jsonFetch ritorna {} su 2xx no-content.
      await jsonFetch<unknown>('sendgrid', 'https://api.sendgrid.com/v3/mail/send', null, {
        method: 'POST',
        body,
        headers,
      });
    },
    { label: `sendgrid.${operation}` },
  );

  return {
    output: { ok: true, operation, accepted: true, to, from },
    durationMs: Date.now() - start,
  };
};
