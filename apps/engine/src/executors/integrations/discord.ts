/**
 * Discord executor — Webhook (no auth) o Bot API (botToken in vault).
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { IntegrationError, requireIntegration, withRetry } from './common.js';
import { jsonFetch, getIntegrationLabel, parseJsonObj } from './saas-shared.js';

export const discordExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const mode = coerceString(cfg.mode ?? 'webhook');
  const content = coerceString(cfg.content ?? '').slice(0, 2000);
  const embedRaw = parseJsonObj('discord', cfg.embedJson, 'embedJson');
  const body: Record<string, unknown> = {};
  if (content) body.content = content;
  if (Object.keys(embedRaw).length > 0) body.embeds = [embedRaw];
  if (!body.content && !body.embeds) {
    throw new IntegrationError({ provider: 'discord', code: 'INVALID_PAYLOAD', message: 'content o embedJson richiesto' });
  }

  let messageId: string | null = null; let channelId: string | null = null;

  await withRetry(async () => {
    if (mode === 'webhook') {
      const url = coerceString(cfg.webhookUrl ?? '').trim();
      const isWebhook = url.startsWith('https://discord.com/api/webhooks/')
        || url.startsWith('https://discordapp.com/api/webhooks/');
      if (!url || !isWebhook) {
        throw new IntegrationError({ provider: 'discord', code: 'INVALID_PAYLOAD', message: 'webhookUrl invalido' });
      }
      const r = await jsonFetch<{ id?: string; channel_id?: string }>(
        'discord', `${url}?wait=true`, null,
        { method: 'POST', body, headers: {} },
      );
      messageId = r.id ?? null; channelId = r.channel_id ?? null;
    } else {
      const integ = requireIntegration({ provider: 'discord', tenantId: context.tenantId, label: getIntegrationLabel(cfg) });
      const botToken = (integ.credentials as { botToken?: string }).botToken;
      if (!botToken) throw new IntegrationError({ provider: 'discord', code: 'INVALID_CREDENTIALS', message: 'botToken assente' });
      const channel = coerceString(cfg.channelId ?? '').trim();
      if (!channel) throw new IntegrationError({ provider: 'discord', code: 'INVALID_PAYLOAD', message: 'channelId obbligatorio per mode=bot' });
      const r = await jsonFetch<{ id?: string; channel_id?: string }>(
        'discord', `https://discord.com/api/v10/channels/${channel}/messages`, null,
        { method: 'POST', body, headers: { Authorization: `Bot ${botToken}` } },
      );
      messageId = r.id ?? null; channelId = r.channel_id ?? channel;
    }
  }, { label: 'discord.send' });

  return { output: { ok: true, messageId, channelId, sentAt: new Date().toISOString() }, durationMs: Date.now() - start };
};
