/**
 * `action_whatsapp_send` — executor.
 *
 * @module actions/whatsapp_send/executor
 */

import type { NodeExecutor, NodeExecutionResult } from '../../types.js';
import { parseConfig } from '../../core/config-parser.js';
import {
  HttpError,
  NetworkError,
  TimeoutError,
  AbortedError,
  ValidationError,
} from '../../core/node-error.js';
import {
  sendText,
  sendTemplate,
  WhatsAppApiError,
  WhatsAppTransportError,
  type WhatsAppHttpTransport,
} from '../../lib/whatsapp/cloud-api-client.js';
import { WhatsAppSendConfigSchema } from './schema.js';
import { safeFetchWithRedirects } from '@medea/engine-safe-fetch';

export const whatsAppSendExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const startedAt = Date.now();

  const parsed = parseConfig(WhatsAppSendConfigSchema, rawConfig);
  if (!parsed.ok) throw parsed.error;
  const cfg = parsed.value;

  if (context.abortSignal?.aborted) throw new AbortedError();

  const auth = {
    phoneNumberId: cfg.phoneNumberId,
    accessToken: cfg.accessToken,
    apiVersion: cfg.apiVersion,
  };
  const transport = makeSafeFetchTransport();
  const fetchOpts: { timeoutMs: number; signal?: AbortSignal } = { timeoutMs: cfg.timeoutMs };
  if (context.abortSignal) fetchOpts.signal = context.abortSignal;

  try {
    const sendStartedAt = Date.now();
    const result =
      cfg.mode === 'text'
        ? await sendText(
            auth,
            {
              recipient: cfg.recipient,
              body: cfg.body!,
              previewUrl: cfg.previewUrl,
            },
            transport,
            fetchOpts,
          )
        : await sendTemplate(
            auth,
            {
              recipient: cfg.recipient,
              templateName: cfg.templateName!,
              languageCode: cfg.languageCode!,
              components: (cfg.componentsJson ?? []) as never,
            },
            transport,
            fetchOpts,
          );

    const messageId = result.messages?.[0]?.id ?? null;
    const output: Record<string, unknown> = {
      messageId,
      recipient: cfg.recipient,
      mode: cfg.mode,
      response: result,
    };
    if (cfg.includePipelineLog) {
      output.pipelineSteps = [
        {
          name: cfg.mode === 'text' ? 'whatsapp_send_text' : 'whatsapp_send_template',
          startedAt: sendStartedAt,
          durationMs: Date.now() - sendStartedAt,
          ok: true,
          evidence: {
            messageId,
            ...(cfg.mode === 'template'
              ? { templateName: cfg.templateName, languageCode: cfg.languageCode }
              : {}),
          },
        },
      ];
    }
    return { output, durationMs: Date.now() - startedAt } satisfies NodeExecutionResult;
  } catch (err) {
    if (context.abortSignal?.aborted && !(err instanceof AbortedError)) throw new AbortedError();
    if (err instanceof WhatsAppApiError) {
      // Meta-side error — bubble up with a typed shape the workflow author
      // can branch on (e.g. logic_if checking meta code == 131047).
      throw new ValidationError(`WHATSAPP_META_ERROR: code=${err.metaCode} ${err.metaMessage}`, {
        metaCode: err.metaCode,
        metaMessage: err.metaMessage,
        httpStatus: err.status,
      });
    }
    if (err instanceof WhatsAppTransportError) {
      if (typeof err.status === 'number') {
        throw new HttpError({
          status: err.status,
          statusText: err.message,
          url: 'https://graph.facebook.com',
        });
      }
      throw new NetworkError(err.message, { cause: err });
    }
    if (
      err instanceof TimeoutError ||
      err instanceof AbortedError ||
      err instanceof HttpError ||
      err instanceof NetworkError
    ) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new NetworkError(msg, { ...(err instanceof Error ? { cause: err } : {}) });
  }
};

// ────────────────────────────────────────────────────────────────────────────
// Transport
// ────────────────────────────────────────────────────────────────────────────

function makeSafeFetchTransport(): WhatsAppHttpTransport {
  return {
    async post({ url, body, headers, timeoutMs, signal }) {
      const timeoutCtrl = new AbortController();
      const t = setTimeout(() => {
        timeoutCtrl.abort();
      }, timeoutMs);

      try {
        const aborter = new Promise<never>((_, reject) => {
          if (timeoutCtrl.signal.aborted) {
            reject(new Error('per_call_timeout'));
            return;
          }
          timeoutCtrl.signal.addEventListener(
            'abort',
            () => {
              reject(new Error('per_call_timeout'));
            },
            { once: true },
          );
          if (signal) {
            if (signal.aborted) {
              reject(new Error('run_aborted'));
              return;
            }
            signal.addEventListener(
              'abort',
              () => {
                reject(new Error('run_aborted'));
              },
              { once: true },
            );
          }
        });

        const res = await Promise.race([
          safeFetchWithRedirects(url, { method: 'POST', headers: { ...headers }, body, timeoutMs }),
          aborter,
        ]);
        const text = await res.text();
        return { status: res.status, text };
      } catch (err) {
        if (signal?.aborted) throw new AbortedError();
        if (timeoutCtrl.signal.aborted) throw new TimeoutError({ url, timeoutMs });
        throw err;
      } finally {
        clearTimeout(t);
      }
    },
  };
}
