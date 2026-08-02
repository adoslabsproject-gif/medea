/**
 * Telegram integration executor — Bot API sendMessage + sendPhoto.
 *
 * Credentials shape:
 *   { botToken: string }   // 123456789:ABCdef...
 *
 * @module executors/integrations/telegram
 */

import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { IntegrationError, requireIntegration, withRetry } from './common.js';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
import { readJsonCapped } from '@/lib/capped-response.js';

const TG_API = 'https://api.telegram.org/bot';

interface TelegramCredentials { botToken: string }

interface TgResponse<T> { ok: boolean; result?: T; description?: string; error_code?: number }

export const telegramExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const chatId = coerceString(cfg.chatId ?? '').trim();
  if (!chatId) throw new IntegrationError({
    provider: 'telegram', code: 'INVALID_PAYLOAD', message: 'integration_telegram_send: "chatId" e\\` obbligatorio',
  });
  const text = coerceString(cfg.text ?? '').trim();
  const photoUrl = coerceString(cfg.photoUrl ?? '').trim();
  if (!text && !photoUrl) {
    throw new IntegrationError({
      provider: 'telegram', code: 'INVALID_PAYLOAD',
      message: 'integration_telegram_send: serve almeno uno tra "text" e "photoUrl"',
    });
  }

  const integration = requireIntegration({
    provider: 'telegram',
    tenantId: context.tenantId,
    label: typeof cfg.integrationLabel === 'string' && cfg.integrationLabel ? cfg.integrationLabel : null,
  });
  const creds = integration.credentials as unknown as TelegramCredentials;
  if (!creds.botToken || !/^\d+:[A-Za-z0-9_-]+$/.test(creds.botToken)) {
    throw new IntegrationError({
      provider: 'telegram', code: 'INVALID_CREDENTIALS',
      message: 'integration_telegram_send: botToken non valido (formato: <id>:<token>)',
    });
  }

  const parseMode = coerceString(cfg.parseMode ?? 'MarkdownV2');
  if (!['MarkdownV2', 'HTML', 'Markdown', 'none'].includes(parseMode)) {
    throw new IntegrationError({
      provider: 'telegram', code: 'INVALID_PAYLOAD',
      message: `integration_telegram_send: parseMode "${parseMode}" non supportato (MarkdownV2/HTML/Markdown/none)`,
    });
  }

  const isPhoto = photoUrl.length > 0;
  const endpoint = isPhoto ? 'sendPhoto' : 'sendMessage';
  const payload: Record<string, unknown> = { chat_id: chatId };
  if (parseMode !== 'none') payload.parse_mode = parseMode;
  if (isPhoto) {
    payload.photo = photoUrl;
    if (text) payload.caption = text;
  } else {
    payload.text = text;
  }
  if (cfg.disableNotification === true || String(cfg.disableNotification) === 'true') {
    payload.disable_notification = true;
  }
  if (cfg.disableWebPagePreview === true || String(cfg.disableWebPagePreview) === 'true') {
    payload.disable_web_page_preview = true;
  }

  const result = await withRetry(async () => {
    const res = await safeOutboundFetch(`${TG_API}${creds.botToken}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: context.abortSignal ?? AbortSignal.timeout(15_000),
    });
    if (!res.ok && res.status !== 400) {
      throw new IntegrationError({
        provider: 'telegram', code: 'API_HTTP_ERROR',
        message: `Telegram HTTP ${String(res.status)} ${res.statusText}`,
        httpStatus: res.status, retryable: res.status >= 500 || res.status === 429,
      });
    }
    const body = await readJsonCapped<TgResponse<{ message_id: number; chat: { id: number }; date: number }>>(res);
    if (!body.ok) {
      throw new IntegrationError({
        provider: 'telegram', code: 'API_ERROR',
        message: `Telegram API error ${String(body.error_code ?? '?')}: ${body.description ?? 'unknown'}`,
        retryable: body.error_code === 429 || (body.error_code !== undefined && body.error_code >= 500),
      });
    }
    return body.result;
  }, { label: 'telegram.send' });

  return {
    output: {
      ok: true,
      messageId: result?.message_id ?? null,
      chatId: result?.chat.id ?? chatId,
      date: result?.date ?? null,
      mode: isPhoto ? 'photo' : 'message',
    },
    durationMs: Date.now() - start,
  };
};
