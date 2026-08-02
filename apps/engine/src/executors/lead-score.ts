/**
 * Executor per action_lead_score.
 * Wrap su lead-score.service.ts — service deterministic, no async/external.
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { scoreLeadFromContent, type LeadScoreConfig } from '@/services/lead-score.service.js';

export const leadScoreExecutor: NodeExecutor = (config, _input, _context) => {
  const start = Date.now();
  const content = coerceString(config.content ?? '');
  if (!content) {
    throw new Error('action_lead_score: config.content è obbligatorio');
  }
  const country = coerceString(config.country ?? '').trim() || undefined;
  const profileRaw = coerceString(config.profile ?? 'marine-thrusters');
  const profile = profileRaw === 'custom' ? 'custom' : 'marine-thrusters';
  const threshold = Number(config.threshold ?? 50);

  const cfg: LeadScoreConfig = { profile, threshold };
  if (profile === 'custom') {
    try {
      const posRaw = coerceString(config.customPositiveJson ?? '').trim();
      const negRaw = coerceString(config.customNegativeJson ?? '').trim();
      if (posRaw) {
        const parsed = JSON.parse(posRaw) as NonNullable<LeadScoreConfig['customPositive']>;
        cfg.customPositive = parsed;
      }
      if (negRaw) {
        const parsed = JSON.parse(negRaw) as NonNullable<LeadScoreConfig['customNegative']>;
        cfg.customNegative = parsed;
      }
    } catch (e) {
      throw new Error(
        `action_lead_score: customPositiveJson/customNegativeJson non parse-able: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const result = scoreLeadFromContent(content, country, cfg);
  return Promise.resolve({
    output: {
      score: result.score,
      category: result.category,
      matched_positive: result.matched_positive,
      matched_negative: result.matched_negative,
      country_bonus: result.country_bonus,
      send_recommended: result.send_recommended,
      reason: result.reason,
    },
    durationMs: Date.now() - start,
  });
};
