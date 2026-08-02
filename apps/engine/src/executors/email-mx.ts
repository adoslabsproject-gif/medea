/**
 * Executor per action_email_validate_mx.
 * Wrap su email-mx.service.ts — service contiene cache LRU + DNS multi-fallback.
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { validateEmailMx } from '@/services/email-mx.service.js';

export const emailMxExecutor: NodeExecutor = async (config, _input, _context) => {
  const start = Date.now();
  const email = coerceString(config.email ?? '').trim();
  if (!email) {
    throw new Error('action_email_validate_mx: config.email è obbligatorio');
  }
  const timeoutMs = Number(config.timeoutMs ?? 4000);
  const minConfidence = Number(config.minConfidence ?? 70);

  const result = await validateEmailMx(email, timeoutMs);
  return {
    output: {
      mx_valid: result.mx_valid,
      mx_records: result.mx_records,
      using_a_fallback: result.using_a_fallback,
      disposable: result.disposable,
      role_based: result.role_based,
      confidence: result.confidence,
      reason: result.reason,
      ok: result.confidence >= minConfidence,
    },
    durationMs: Date.now() - start,
  };
};
