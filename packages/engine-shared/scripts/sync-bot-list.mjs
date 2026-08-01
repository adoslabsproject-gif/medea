#!/usr/bin/env node
/**
 * sync-bot-list.mjs — sync KNOWN_CRAWLERS_PATTERNS da source GitHub canonical.
 *
 * Source: monperrus/crawler-user-agents (MIT, ~620 voci, mantained 2014+)
 *   https://github.com/monperrus/crawler-user-agents
 *
 * Output: packages/shared/src/known-crawlers-generated.ts (auto-generated,
 * NOT to edit by hand — re-run sync per aggiornare).
 *
 * Run: pnpm --filter @zeliai/shared sync:bot-list
 *
 * CI: integrare in workflow GitHub Actions weekly per mantenere lista
 * fresca (i bot nuovi vengono aggiunti upstream regolarmente).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(__dirname, '..', 'src', 'known-crawlers-generated.ts');

const SOURCE_URL =
  'https://raw.githubusercontent.com/monperrus/crawler-user-agents/master/crawler-user-agents.json';

async function main() {
  console.log(`[sync-bot-list] fetching ${SOURCE_URL}`);
  const res = await fetch(SOURCE_URL, {
    headers: { 'User-Agent': 'zeliai-sync-bot-list/1.0' },
  });
  if (!res.ok) {
    console.error(`fetch failed: HTTP ${res.status}`);
    process.exit(1);
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    console.error('expected array, got', typeof data);
    process.exit(1);
  }

  // Filtra:
  //  - Entries con `pattern` field non vuoto (definite)
  //  - Esclude pattern che potrebbero matchare browser legitimi
  //    (es. solo "Mozilla", "Safari" — già fanno parte del flow umano)
  const FILTER_OUT_PATTERNS = new Set([
    'Mozilla', 'Safari', 'AppleWebKit', 'Chrome', 'Firefox', 'Edge',
    'compatible',
  ]);

  const entries = [];
  for (const item of data) {
    const pat = item.pattern ?? item.user_agent ?? null;
    if (!pat || typeof pat !== 'string' || pat.length < 3) continue;
    if (FILTER_OUT_PATTERNS.has(pat)) continue;
    // Sanitize: la lista upstream usa stringhe regex-style. Manteniamo as-is.
    entries.push({
      pattern: pat,
      additionDate: item.addition_date ?? null,
      url: item.url ?? null,
    });
  }

  console.log(`[sync-bot-list] ${entries.length} crawler patterns retained (filtered ${data.length - entries.length})`);

  const ts = `/**
 * known-crawlers-generated.ts — AUTO-GENERATED, do not edit by hand.
 *
 * Synced from monperrus/crawler-user-agents (GitHub, MIT) on ${new Date().toISOString()}.
 * Re-run sync: \`pnpm --filter @zeliai/shared sync:bot-list\`
 *
 * Purpose: long-tail bot allowlist (oltre i ~70 curati in bot-allowlist.ts).
 * Pattern usati come substring case-insensitive — NO reverse-DNS verify
 * (lista solo per categorizzazione "known crawler"; per anti-spoofing
 * affidabile usa LEGITIMATE_BOTS con suffix DNS).
 */

export interface KnownCrawler {
  /** Pattern UA da matchare (substring case-insensitive). */
  readonly pattern: string;
  /** Data prima aggiunta upstream (ISO YYYY-MM-DD). */
  readonly additionDate: string | null;
  /** Documentazione vendor (se nota). */
  readonly url: string | null;
}

export const KNOWN_CRAWLERS: readonly KnownCrawler[] = Object.freeze(${JSON.stringify(entries, null, 2)});

/**
 * Substring case-insensitive match contro la lista canonical.
 * Ritorna primo pattern che matcha o null.
 */
export function isKnownCrawler(userAgent: string): KnownCrawler | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  for (const c of KNOWN_CRAWLERS) {
    if (ua.includes(c.pattern.toLowerCase())) {
      return c;
    }
  }
  return null;
}
`;
  writeFileSync(OUT_FILE, ts, 'utf-8');
  console.log(`[sync-bot-list] wrote ${OUT_FILE} (${ts.length} bytes)`);
}

main().catch((err) => {
  console.error('[sync-bot-list] FAILED:', err);
  process.exit(1);
});
