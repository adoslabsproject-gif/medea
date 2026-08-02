/**
 * Twilio executor — SMS/WhatsApp via REST API 2010-04-01 (Basic auth SID:token).
 *
 * Operazioni: sendSms (To/From/Body), sendWhatsapp (prefisso whatsapp:),
 * getMessage (status delivery). Credenziali vault: { accountSid, authToken,
 * fromNumber }. Body form-encoded (Twilio non accetta JSON). HTTP via
 * jsonFetch → safeOutboundFetch (SSRF + breaker + timeout) + withRetry.
 * Numeri validati E.164. Errori tipizzati IntegrationError.
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { IntegrationError, requireIntegration, withRetry } from './common.js';
import { jsonFetch, getIntegrationLabel } from './saas-shared.js';
import { checkTwilioSendRateLimit } from './twilio-guards.js';

interface TwilioCreds {
  accountSid?: string;
  authToken?: string;
  fromNumber?: string;
}

function assertE164(n: string, field: string): string {
  const v = n.trim();
  // Permette prefisso whatsapp: per il canale WA.
  const core = v.replace(/^whatsapp:/, '');
  if (!/^\+[1-9]\d{6,14}$/.test(core)) {
    throw new IntegrationError({
      provider: 'twilio',
      code: 'INVALID_PAYLOAD',
      message: `${field} non in formato E.164 (es. +393331234567): "${n}"`,
    });
  }
  return v;
}

export const twilioExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const operation = coerceString(cfg.operation ?? 'sendSms');

  const integ = requireIntegration({
    provider: 'twilio',
    tenantId: context.tenantId,
    label: getIntegrationLabel(cfg),
  });
  const creds = integ.credentials as TwilioCreds;
  if (!creds.accountSid || !creds.authToken) {
    throw new IntegrationError({
      provider: 'twilio',
      code: 'INVALID_CREDENTIALS',
      message: 'accountSid o authToken assente nel vault',
    });
  }
  if (!/^AC[0-9a-f]{32}$/i.test(creds.accountSid)) {
    throw new IntegrationError({
      provider: 'twilio',
      code: 'INVALID_CREDENTIALS',
      message: 'accountSid non valido (atteso "AC" + 32 hex)',
    });
  }
  const base = `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}`;
  const auth = `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')}`;
  const headers = { Authorization: auth };

  // ANTI TOLL-FRAUD: tetto invii/minuto PER-TENANT, controllato UNA volta prima del
  // withRetry (un loop/abuso che emette migliaia di SMS = bolletta Twilio enorme).
  // getMessage (sola lettura) non consuma il budget.
  if (operation === 'sendSms' || operation === 'sendWhatsapp') {
    const rl = checkTwilioSendRateLimit(context.tenantId);
    if (!rl.allowed) {
      throw new IntegrationError({
        provider: 'twilio',
        code: 'RATE_LIMITED',
        message: `Limite invii Twilio superato (${rl.max}/min per tenant): protezione anti toll-fraud. Riprova tra poco o aumenta MEDEA_TWILIO_MAX_SENDS_PER_MIN.`,
        retryable: false,
      });
    }
  }

  let output: Record<string, unknown> = {};

  await withRetry(
    async () => {
      switch (operation) {
        case 'sendSms':
        case 'sendWhatsapp': {
          const body = coerceString(cfg.body ?? '').slice(0, 1600);
          if (!body)
            throw new IntegrationError({
              provider: 'twilio',
              code: 'INVALID_PAYLOAD',
              message: 'body (testo messaggio) obbligatorio',
            });
          const isWa = operation === 'sendWhatsapp';
          const rawFrom = coerceString(cfg.fromNumber ?? creds.fromNumber ?? '').trim();
          const rawTo = coerceString(cfg.to ?? '').trim();
          if (!rawFrom)
            throw new IntegrationError({
              provider: 'twilio',
              code: 'INVALID_PAYLOAD',
              message: 'fromNumber obbligatorio (config o vault)',
            });
          if (!rawTo)
            throw new IntegrationError({
              provider: 'twilio',
              code: 'INVALID_PAYLOAD',
              message: 'to (destinatario) obbligatorio',
            });
          const from = isWa
            ? `whatsapp:${assertE164(rawFrom, 'fromNumber').replace(/^whatsapp:/, '')}`
            : assertE164(rawFrom, 'fromNumber');
          const to = isWa
            ? `whatsapp:${assertE164(rawTo, 'to').replace(/^whatsapp:/, '')}`
            : assertE164(rawTo, 'to');
          const form = new URLSearchParams({ To: to, From: from, Body: body }).toString();
          const r = await jsonFetch<{ sid?: string; status?: string }>(
            'twilio',
            `${base}/Messages.json`,
            null,
            { method: 'POST', body: form, asForm: true, headers },
          );
          output = { messageSid: r.sid ?? null, status: r.status ?? null, to, from };
          break;
        }
        case 'getMessage': {
          const sid = coerceString(cfg.messageSid ?? '').trim();
          if (!sid)
            throw new IntegrationError({
              provider: 'twilio',
              code: 'INVALID_PAYLOAD',
              message: 'messageSid obbligatorio per getMessage',
            });
          const r = await jsonFetch<{ sid?: string; status?: string; error_code?: number }>(
            'twilio',
            `${base}/Messages/${encodeURIComponent(sid)}.json`,
            null,
            { method: 'GET', headers },
          );
          output = {
            messageSid: r.sid ?? null,
            status: r.status ?? null,
            errorCode: r.error_code ?? null,
          };
          break;
        }
        default:
          throw new IntegrationError({
            provider: 'twilio',
            code: 'INVALID_PAYLOAD',
            message: `operation "${operation}" non supportata (sendSms/sendWhatsapp/getMessage)`,
          });
      }
    },
    { label: `twilio.${operation}` },
  );

  return { output: { ok: true, operation, ...output }, durationMs: Date.now() - start };
};
