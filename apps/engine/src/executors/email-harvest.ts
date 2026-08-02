/**
 * Executor per action_email_harvest.
 * Wrapper minimo sul service `email-harvest.service.ts` — la logica complessa
 * sta nel service (testabile in isolamento), l'executor fa solo input adapting.
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { harvestEmails } from '@/services/email-harvest.service.js';

export const emailHarvestExecutor: NodeExecutor = (config, _input, _context) => {
  const start = Date.now();
  const html = coerceString(config.html ?? '');
  if (!html) {
    throw new Error('action_email_harvest: config.html è obbligatorio (HTML/text della pagina)');
  }
  const strictNoise = config.strictNoise === true || config.strictNoise === 'true';
  void strictNoise; // currently always strict, future flag for relaxed mode

  // Custom preferred local parts (override default selection rule)
  const preferredCsv = coerceString(config.preferredLocalParts ?? '').trim();
  const preferred = preferredCsv
    ? preferredCsv
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : [];

  const result = harvestEmails(html);

  // Re-rank primary_email se preferredLocalParts forniti
  if (preferred.length > 0 && result.all_emails.length > 0) {
    const rerank = result.all_emails
      .map((e) => {
        const local = e.email.split('@')[0] ?? '';
        const prio = preferred.findIndex(
          (p) => local === p || local.startsWith(`${p}.`) || local.startsWith(`${p}-`),
        );
        return { ...e, _prio: prio < 0 ? 999 : prio };
      })
      .sort((a, b) => a._prio - b._prio || b.confidence - a.confidence);
    result.primary_email = rerank[0]?.email ?? null;
  }

  return Promise.resolve({
    output: {
      primary_email: result.primary_email,
      all_emails: result.all_emails,
      counts: result.counts,
      has_emails: result.all_emails.length > 0,
    },
    durationMs: Date.now() - start,
  });
};
