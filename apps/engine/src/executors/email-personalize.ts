/**
 * Executor per action_email_personalize.
 * Wrap su email-personalize.service.ts.
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@flowforge/nodes-stdlib';
import { logLlmExchange } from '@flowforge/nodes-stdlib';
import { personalizeEmail } from '@/services/email-personalize.service.js';

export const emailPersonalizeExecutor: NodeExecutor = async (config, _input, context) => {
  const start = Date.now();
  const content = coerceString(config.content ?? '');
  const company_name = coerceString(config.company_name ?? '').trim();
  const language = coerceString(config.language ?? '').trim().toLowerCase();
  const toneRaw = coerceString(config.tone ?? 'formal');
  const tone = (toneRaw === 'conversational' ? 'conversational' : 'formal');
  const senderProductContext = coerceString(config.sender_product_context ?? '').trim();

  if (!content) throw new Error('action_email_personalize: config.content è obbligatorio');
  if (!company_name) throw new Error('action_email_personalize: config.company_name è obbligatorio');
  if (!language) throw new Error('action_email_personalize: config.language è obbligatorio (codice 2-letter)');

  const result = await personalizeEmail({
    content,
    company_name,
    language,
    tone,
    tenantId: context.tenantId,
    ...(senderProductContext ? { senderProductContext } : {}),
  });

  // Fase 3 (#15): prompt+risposta della chiamata fresca → StepLog 'llm'
  // (cache-hit = nessun exchange, nessun log: onesto).
  if (result.llm_exchange) {
    logLlmExchange(context, {
      provider: result.llm_provider ?? 'liara',
      model: result.llm_model ?? `${result.llm_provider ?? 'liara'}-default`,
      system: result.llm_exchange.system,
      user: result.llm_exchange.user,
      response: result.llm_exchange.response,
    });
  }

  return {
    output: {
      snippet: result.snippet,
      evidence_quote: result.evidence_quote,
      confidence: result.confidence,
      success: result.success,
      reason: result.reason,
      llm_provider: result.llm_provider ?? null,
      llm_model: result.llm_model ?? null,
      // Fase 1b (#13): usage standard cross-nodo. Presente SOLO su chiamata LLM
      // fresca — cache-hit / validazioni pre-LLM non spendono token.
      ...(result.llm_usage !== undefined ? {
        _llm: {
          inputTokens: result.llm_usage.input,
          outputTokens: result.llm_usage.output,
          model: result.llm_model ?? `${result.llm_provider ?? 'liara'}-default`,
          provider: result.llm_provider ?? 'liara',
          fromApi: result.llm_usage.fromApi,
        },
      } : {}),
    },
    durationMs: Date.now() - start,
  };
};
