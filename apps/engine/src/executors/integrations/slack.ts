/**
 * Slack integration executor — chat.postMessage.
 *
 * Credentials shape:
 *   { botToken: string }   // xoxb-* (Bot User OAuth Token)
 *
 * Idempotency: header `client_msg_id` derivato da runId:nodeId per evitare
 * duplicate post su retry. Slack rifiuta silently messaggi duplicati con
 * stesso client_msg_id < 5 min.
 *
 * @module executors/integrations/slack
 */

import { coerceString } from '@/lib/coerce.js';
import { createHash } from 'node:crypto';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { IntegrationError, requireIntegration, withRetry } from './common.js';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
import { readJsonCapped } from '@/lib/capped-response.js';

const SLACK_API = 'https://slack.com/api';

interface SlackCredentials {
  botToken: string;
}

interface SlackPostResponse {
  ok: boolean;
  ts?: string;
  channel?: string;
  message?: { text?: string; ts?: string; user?: string; bot_id?: string };
  error?: string;
  response_metadata?: { messages?: string[] };
}

export const slackExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const channel = coerceString(cfg.channel ?? '').trim();
  if (!channel)
    throw new IntegrationError({
      provider: 'slack',
      code: 'INVALID_PAYLOAD',
      message: 'integration_slack_post: "channel" e\\` obbligatorio',
    });
  const text = coerceString(cfg.text ?? '').trim();
  if (!text)
    throw new IntegrationError({
      provider: 'slack',
      code: 'INVALID_PAYLOAD',
      message:
        'integration_slack_post: "text" e\\` obbligatorio (anche se usi blocks — serve per fallback)',
    });

  const integration = requireIntegration({
    provider: 'slack',
    tenantId: context.tenantId,
    label:
      typeof cfg.integrationLabel === 'string' && cfg.integrationLabel
        ? cfg.integrationLabel
        : null,
  });
  const creds = integration.credentials as unknown as SlackCredentials;
  if (!creds.botToken?.startsWith('xoxb-')) {
    throw new IntegrationError({
      provider: 'slack',
      code: 'INVALID_CREDENTIALS',
      message: 'integration_slack_post: botToken mancante o non valido (deve iniziare con "xoxb-")',
    });
  }

  // Parse blocks JSON if provided
  let blocks: unknown = undefined;
  if (typeof cfg.blocks === 'string' && cfg.blocks.trim()) {
    try {
      blocks = JSON.parse(cfg.blocks);
      if (!Array.isArray(blocks)) {
        throw new Error('blocks must be an array');
      }
    } catch (err) {
      throw new IntegrationError({
        provider: 'slack',
        code: 'INVALID_PAYLOAD',
        message: `integration_slack_post: blocks JSON parse fallito — ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const idempotencyKey = createHash('sha256')
    .update(`slack:${context.runId}:${context.nodeId}`)
    .digest('hex')
    .slice(0, 32);

  const payload: Record<string, unknown> = { channel, text };
  if (blocks !== undefined) payload.blocks = blocks;
  if (typeof cfg.threadTs === 'string' && cfg.threadTs.trim())
    payload.thread_ts = cfg.threadTs.trim();
  if (cfg.unfurlLinks === false || String(cfg.unfurlLinks) === 'false')
    payload.unfurl_links = false;
  payload.client_msg_id = idempotencyKey;

  const result = await withRetry(
    async () => {
      const res = await safeOutboundFetch(`${SLACK_API}/chat.postMessage`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds.botToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(payload),
        signal: context.abortSignal ?? AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        throw new IntegrationError({
          provider: 'slack',
          code: 'API_HTTP_ERROR',
          message: `Slack HTTP ${String(res.status)} ${res.statusText}`,
          httpStatus: res.status,
          retryable: res.status >= 500,
        });
      }
      const body = await readJsonCapped<SlackPostResponse>(res);
      if (!body.ok) {
        const errCode = body.error ?? 'unknown_error';
        throw new IntegrationError({
          provider: 'slack',
          code: errCode.toUpperCase(),
          message: `Slack API error: ${errCode}${body.response_metadata?.messages ? ` — ${body.response_metadata.messages.join('; ')}` : ''}`,
          retryable: errCode === 'rate_limited' || errCode === 'service_unavailable',
        });
      }
      return body;
    },
    { label: 'slack.postMessage' },
  );

  return {
    output: {
      ok: result.ok,
      ts: result.ts ?? null,
      channel: result.channel ?? channel,
      message: result.message ?? null,
    },
    durationMs: Date.now() - start,
  };
};
