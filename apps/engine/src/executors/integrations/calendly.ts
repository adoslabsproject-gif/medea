/**
 * Calendly executor — REST API v2 (Personal Access Token in vault).
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { IntegrationError, requireIntegration, withRetry } from './common.js';
import { jsonFetch, getIntegrationLabel } from './saas-shared.js';

/**
 * Anti-esfiltrazione: eventUri/inviteeUri arrivano da config del tenant. SENZA questo
 * vincolo un `eventUri = https://attacker.com/x` riceverebbe il PAT Calendly in chiaro.
 * Tutte le chiamate (anche quelle con host hardcoded) passano l'allowlist.
 */
const CALENDLY_HOSTS = ['calendly.com'] as const;

export const calendlyExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const operation = coerceString(cfg.operation ?? 'listScheduledEvents');

  const integ = requireIntegration({
    provider: 'calendly',
    tenantId: context.tenantId,
    label: getIntegrationLabel(cfg),
  });
  const token = (integ.credentials as { personalAccessToken?: string }).personalAccessToken;
  if (!token)
    throw new IntegrationError({
      provider: 'calendly',
      code: 'INVALID_CREDENTIALS',
      message: 'personalAccessToken assente',
    });

  let events: unknown[] = [];
  let invitees: unknown[] = [];
  let event: unknown = null;
  let invitee: unknown = null;
  let cancelled = false;
  await withRetry(
    async () => {
      switch (operation) {
        case 'listScheduledEvents': {
          const userUri = coerceString(cfg.userUri ?? '').trim();
          if (!userUri)
            throw new IntegrationError({
              provider: 'calendly',
              code: 'INVALID_PAYLOAD',
              message: 'userUri obbligatorio (es. https://api.calendly.com/users/...)',
            });
          const params = new URLSearchParams();
          params.set('user', userUri);
          const status = coerceString(cfg.status ?? 'active');
          if (status !== 'all') params.set('status', status);
          if (cfg.minStartTime) params.set('min_start_time', coerceString(cfg.minStartTime));
          if (cfg.maxStartTime) params.set('max_start_time', coerceString(cfg.maxStartTime));
          const r = await jsonFetch<{ collection: unknown[] }>(
            'calendly',
            `https://api.calendly.com/scheduled_events?${params.toString()}`,
            token,
            { allowHosts: CALENDLY_HOSTS },
          );
          events = r.collection;
          break;
        }
        case 'getEvent': {
          const uri = coerceString(cfg.eventUri ?? '').trim();
          if (!uri)
            throw new IntegrationError({
              provider: 'calendly',
              code: 'INVALID_PAYLOAD',
              message: 'eventUri obbligatorio',
            });
          event = await jsonFetch('calendly', uri, token, { allowHosts: CALENDLY_HOSTS });
          break;
        }
        case 'listInvitees': {
          const uri = coerceString(cfg.eventUri ?? '').trim();
          if (!uri)
            throw new IntegrationError({
              provider: 'calendly',
              code: 'INVALID_PAYLOAD',
              message: 'eventUri obbligatorio',
            });
          const r = await jsonFetch<{ collection: unknown[] }>(
            'calendly',
            `${uri}/invitees`,
            token,
            { allowHosts: CALENDLY_HOSTS },
          );
          invitees = r.collection;
          break;
        }
        case 'getInvitee': {
          const uri = coerceString(cfg.inviteeUri ?? '').trim();
          if (!uri)
            throw new IntegrationError({
              provider: 'calendly',
              code: 'INVALID_PAYLOAD',
              message: 'inviteeUri obbligatorio',
            });
          invitee = await jsonFetch('calendly', uri, token, { allowHosts: CALENDLY_HOSTS });
          break;
        }
        case 'cancelEvent': {
          const uri = coerceString(cfg.eventUri ?? '').trim();
          if (!uri)
            throw new IntegrationError({
              provider: 'calendly',
              code: 'INVALID_PAYLOAD',
              message: 'eventUri obbligatorio',
            });
          await jsonFetch('calendly', `${uri}/cancellation`, token, {
            method: 'POST',
            body: { reason: coerceString(cfg.cancelReason ?? 'Cancelled via FlowForge') },
            allowHosts: CALENDLY_HOSTS,
          });
          cancelled = true;
          break;
        }
        default:
          throw new IntegrationError({
            provider: 'calendly',
            code: 'INVALID_PAYLOAD',
            message: `operation "${operation}" non supportata`,
          });
      }
    },
    { label: `calendly.${operation}` },
  );

  return {
    output: { ok: true, events, count: events.length, invitees, event, invitee, cancelled },
    durationMs: Date.now() - start,
  };
};
