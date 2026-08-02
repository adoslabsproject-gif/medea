/**
 * Server-side executor per il nodo `action_contact_discovery`.
 *
 * Riusa interamente il service `contact-discovery.service.ts` che è già
 * stato disegnato per essere LLM-agnostic e enterprise-grade 2026.
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { discoverContacts } from '@/services/contact-discovery.service.js';

export const contactDiscoveryExecutor: NodeExecutor = async (config, _input, _context) => {
  const start = Date.now();
  const homeUrl = coerceString(config.homeUrl ?? '').trim();
  if (!homeUrl) {
    throw new Error('action_contact_discovery: config.homeUrl è obbligatorio');
  }

  const maxPages = parsePositiveInt(config.maxPages, 5);
  const timeoutMs = parsePositiveInt(config.timeoutMs, 30_000);
  const respectRobots = parseBool(config.respectRobots, true);
  const ddgFallback = parseBool(config.ddgFallback, true);
  const bypassCache = parseBool(config.bypassCache, false);

  const result = await discoverContacts(homeUrl, {
    maxPages,
    timeoutMs,
    respectRobots,
    ddgFallback,
    bypassCache,
  });

  return {
    output: {
      // Flat fields per espressioni semplici: {{$node.discover.json.primary_email}}
      emails: result.emails,
      primary_email: result.primary_email,
      source_page: result.source_page,
      pages_visited: result.pages_visited,
      paths_tried: result.paths_tried,
      domain: result.domain,
      took_ms: result.took_ms,
      cache_hit: result.cache_hit,
      reason_if_empty: result.reason_if_empty ?? null,
      // Convenience flag: ottimo per logic_if subito a valle
      has_emails: result.emails.length > 0,
      // ── Standard 2026 enrichment: niente più "prep_personalize" nodes ──
      // Tutti i campi business-ready esposti direttamente:
      company_name: result.company_name,
      description: result.description,
      site_language: result.site_language,
      content_text: result.content_text,
      og_image: result.og_image,
      // Alias di comodo per espressioni leggibili (lead_score/personalize):
      content: result.content_text,
    },
    durationMs: Date.now() - start,
  };
};

function parsePositiveInt(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : Number(coerceString(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseBool(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  const s = coerceString(raw).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return fallback;
}
