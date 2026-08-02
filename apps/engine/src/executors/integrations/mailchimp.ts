/**
 * Mailchimp executor — Marketing API 3.0 (API key + datacenter).
 *
 * Operazioni: addMember (upsert idempotent via MD5 lowercase email), getMember,
 * updateMember, addTag. Credenziali vault: { apiKey } (formato `key-us21`, il
 * datacenter è il suffisso dopo l'ultimo '-'). Tutto l'HTTP via jsonFetch →
 * safeOutboundFetch (SSRF + breaker + timeout) + withRetry. Auth Basic (any
 * user + apiKey come password). Errori tipizzati IntegrationError.
 */
import { coerceString } from '@/lib/coerce.js';
import { createHash } from 'node:crypto';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { IntegrationError, requireIntegration, withRetry } from './common.js';
import { jsonFetch, getIntegrationLabel, parseJsonObj } from './saas-shared.js';

interface MailchimpCreds {
  apiKey?: string;
}

function datacenter(apiKey: string): string {
  const dc = apiKey.split('-').pop() ?? '';
  if (!/^[a-z]{2}\d{1,3}$/i.test(dc)) {
    throw new IntegrationError({
      provider: 'mailchimp',
      code: 'INVALID_CREDENTIALS',
      message: 'apiKey senza datacenter valido (atteso suffisso tipo "-us21")',
    });
  }
  return dc;
}

function subscriberHash(email: string): string {
  return createHash('md5').update(email.trim().toLowerCase()).digest('hex');
}

export const mailchimpExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const operation = coerceString(cfg.operation ?? 'addMember');
  const listId = coerceString(cfg.listId ?? '').trim();
  if (!listId)
    throw new IntegrationError({
      provider: 'mailchimp',
      code: 'INVALID_PAYLOAD',
      message: 'listId (Audience ID) obbligatorio',
    });

  const integ = requireIntegration({
    provider: 'mailchimp',
    tenantId: context.tenantId,
    label: getIntegrationLabel(cfg),
  });
  const apiKey = (integ.credentials as MailchimpCreds).apiKey;
  if (!apiKey)
    throw new IntegrationError({
      provider: 'mailchimp',
      code: 'INVALID_CREDENTIALS',
      message: 'apiKey assente nel vault',
    });

  const base = `https://${datacenter(apiKey)}.api.mailchimp.com/3.0`;
  const auth = `Basic ${Buffer.from(`flowforge:${apiKey}`).toString('base64')}`;
  const headers = { Authorization: auth };

  let output: Record<string, unknown> = {};

  await withRetry(
    async () => {
      switch (operation) {
        case 'addMember': {
          const email = coerceString(cfg.email ?? '').trim();
          if (!email)
            throw new IntegrationError({
              provider: 'mailchimp',
              code: 'INVALID_PAYLOAD',
              message: 'email obbligatoria per addMember',
            });
          const mergeFields = parseJsonObj('mailchimp', cfg.mergeFieldsJson, 'mergeFieldsJson');
          const statusVal = coerceString(cfg.status ?? 'subscribed');
          // PUT su subscriberHash = upsert idempotent (no duplicati su re-run).
          const r = await jsonFetch<{ id?: string; status?: string }>(
            'mailchimp',
            `${base}/lists/${listId}/members/${subscriberHash(email)}`,
            null,
            {
              method: 'PUT',
              body: {
                email_address: email,
                status_if_new: statusVal,
                status: statusVal,
                merge_fields: mergeFields,
              },
              headers,
            },
          );
          output = { memberId: r.id ?? null, status: r.status ?? null, email };
          break;
        }
        case 'getMember': {
          const email = coerceString(cfg.email ?? '').trim();
          if (!email)
            throw new IntegrationError({
              provider: 'mailchimp',
              code: 'INVALID_PAYLOAD',
              message: 'email obbligatoria per getMember',
            });
          const r = await jsonFetch<Record<string, unknown>>(
            'mailchimp',
            `${base}/lists/${listId}/members/${subscriberHash(email)}`,
            null,
            { method: 'GET', headers },
          );
          output = { member: r };
          break;
        }
        case 'addTag': {
          const email = coerceString(cfg.email ?? '').trim();
          const tag = coerceString(cfg.tag ?? '').trim();
          if (!email || !tag)
            throw new IntegrationError({
              provider: 'mailchimp',
              code: 'INVALID_PAYLOAD',
              message: 'email e tag obbligatori per addTag',
            });
          await jsonFetch<unknown>(
            'mailchimp',
            `${base}/lists/${listId}/members/${subscriberHash(email)}/tags`,
            null,
            { method: 'POST', body: { tags: [{ name: tag, status: 'active' }] }, headers },
          );
          output = { tagged: true, email, tag };
          break;
        }
        default:
          throw new IntegrationError({
            provider: 'mailchimp',
            code: 'INVALID_PAYLOAD',
            message: `operation "${operation}" non supportata (addMember/getMember/addTag)`,
          });
      }
    },
    { label: `mailchimp.${operation}` },
  );

  return { output: { ok: true, operation, ...output }, durationMs: Date.now() - start };
};
