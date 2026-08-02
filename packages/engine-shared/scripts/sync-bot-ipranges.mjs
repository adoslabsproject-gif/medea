#!/usr/bin/env node
/**
 * sync-bot-ipranges.mjs — sync IP CIDR ranges UFFICIALI dei vendor bot.
 *
 * I vendor major pubblicano JSON con i CIDR autorizzati per i loro crawler.
 * Sincronizzando questi range possiamo:
 *   1. Verificare un crawler legit anche QUANDO il reverse-DNS fallisce
 *      (es. PTR=null in client cliente, ma IP è in 66.249.64.0/19 = Googlebot).
 *   2. Bannare con CERTEZZA i fake-Googlebot/Bingbot/etc che non sono nei range.
 *
 * Fonti CANONICAL (vendor-pubblicate, JSON parseable):
 *   - Googlebot:                 https://developers.google.com/search/apis/ipranges/googlebot.json
 *   - Google Special Crawlers:   https://developers.google.com/search/apis/ipranges/special-crawlers.json
 *   - Google User-triggered:     https://developers.google.com/search/apis/ipranges/user-triggered-fetchers.json
 *   - Bingbot:                   https://www.bing.com/toolbox/bingbot.json
 *   - Applebot:                  https://search.developer.apple.com/applebot.json
 *
 * Telegram alert se:
 *   - Sync fallisce (HTTP non-2xx, network timeout, JSON malformato)
 *   - Diff significativo vs sync precedente (>30% CIDR change → possibile MITM/vendor strategy change)
 *
 * Output: packages/shared/src/bot-ipranges-generated.ts (auto-generated)
 *
 * Schedule: systemd timer 1x/24h alle 03:00 UTC (zeliai-bot-ipranges.timer).
 * Manual run: pnpm --filter @medea/engine-shared sync:bot-ipranges
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(__dirname, '..', 'src', 'bot-ipranges-generated.ts');

const SOURCES = [
  { vendor: 'Googlebot', url: 'https://developers.google.com/search/apis/ipranges/googlebot.json' },
  {
    vendor: 'Google-Special-Crawlers',
    url: 'https://developers.google.com/search/apis/ipranges/special-crawlers.json',
  },
  {
    vendor: 'Google-User-Triggered',
    url: 'https://developers.google.com/search/apis/ipranges/user-triggered-fetchers.json',
  },
  { vendor: 'Bingbot', url: 'https://www.bing.com/toolbox/bingbot.json' },
  { vendor: 'Applebot', url: 'https://search.developer.apple.com/applebot.json' },
];

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID;
const DIFF_THRESHOLD_PCT = 30; // alert se > 30% diff vs run precedente

async function sendTelegramAlert(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) {
    console.warn('[telegram] TOKEN/CHAT non configurati — alert solo console');
    console.warn(text);
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.error(`[telegram] HTTP ${res.status}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[telegram] fetch failed:', err);
    return false;
  }
}

async function fetchSource(src) {
  console.log(`[sync] fetching ${src.vendor} from ${src.url}`);
  try {
    const res = await fetch(src.url, {
      headers: { 'User-Agent': 'zeliai-sync-bot-ipranges/1.0' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    if (!data || typeof data !== 'object' || !Array.isArray(data.prefixes)) {
      throw new Error('expected object with .prefixes array');
    }
    // Normalize: { ipv4Prefix | ipv6Prefix } → flat list
    const cidrs = data.prefixes
      .map((p) => p.ipv4Prefix ?? p.ipv6Prefix ?? null)
      .filter((c) => c !== null && typeof c === 'string');
    if (cidrs.length === 0) {
      throw new Error('zero CIDRs extracted');
    }
    console.log(`[sync] ${src.vendor}: ${cidrs.length} CIDRs`);
    return { vendor: src.vendor, url: src.url, cidrs, fetchedAt: new Date().toISOString() };
  } catch (err) {
    console.error(`[sync] ${src.vendor} FAILED:`, err.message);
    return { vendor: src.vendor, url: src.url, cidrs: [], error: err.message };
  }
}

function loadPrevious() {
  if (!existsSync(OUT_FILE)) return null;
  try {
    const content = readFileSync(OUT_FILE, 'utf-8');
    // Estrai conta CIDR precedenti per diff alert (lettura semplice senza eval)
    const totalMatch = content.match(/TOTAL_CIDRS\s*=\s*(\d+)/);
    return totalMatch ? parseInt(totalMatch[1], 10) : null;
  } catch {
    return null;
  }
}

async function main() {
  const results = await Promise.all(SOURCES.map(fetchSource));

  const succeeded = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);

  if (failed.length > 0) {
    const failedList = failed.map((f) => `${f.vendor} (${f.error})`).join(', ');
    await sendTelegramAlert(
      `⚠ <b>Bot IP-ranges sync failures</b>\n\n` +
        `${failed.length}/${SOURCES.length} sources failed:\n` +
        `<code>${failedList}</code>\n\n` +
        `Action: check vendor JSON endpoint accessibility.`,
    );
  }

  if (succeeded.length === 0) {
    console.error('[sync] ALL sources failed — abort');
    process.exit(1);
  }

  // Diff check vs run precedente
  const totalCidrs = succeeded.reduce((sum, r) => sum + r.cidrs.length, 0);
  const prevTotal = loadPrevious();
  if (prevTotal !== null && prevTotal > 0) {
    const diffPct = (Math.abs(totalCidrs - prevTotal) * 100) / prevTotal;
    if (diffPct > DIFF_THRESHOLD_PCT) {
      await sendTelegramAlert(
        `⚠ <b>Bot IP-ranges diff anomalo</b>\n\n` +
          `Total CIDR cambiato di <b>${diffPct.toFixed(1)}%</b> (prev=${prevTotal} → curr=${totalCidrs}).\n` +
          `Soglia: ${DIFF_THRESHOLD_PCT}%. Possibili cause: vendor strategy change, MITM, JSON malformed.\n` +
          `Action: review the generated file before merge.`,
      );
    }
  }

  // Genera TS
  const ts = `/**
 * bot-ipranges-generated.ts — AUTO-GENERATED, do not edit by hand.
 *
 * Synced from vendor canonical JSON endpoints on ${new Date().toISOString()}.
 * Sources:
${SOURCES.map((s) => ` *   - ${s.vendor}: ${s.url}`).join('\n')}
 *
 * Re-run: \`pnpm --filter @medea/engine-shared sync:bot-ipranges\`
 * Auto schedule: systemd timer zeliai-bot-ipranges.timer (3:00 UTC daily).
 *
 * Telegram alert su sync failure: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env.
 */

export interface BotIpRange {
  readonly vendor: string;
  readonly cidrs: readonly string[];
  readonly fetchedAt: string;
  readonly error?: string;
}

export const BOT_IPRANGES: readonly BotIpRange[] = Object.freeze(${JSON.stringify(results, null, 2)});

export const TOTAL_CIDRS = ${totalCidrs};
export const LAST_SYNC_AT = ${JSON.stringify(new Date().toISOString())};

/**
 * Check if an IP literal belongs to a known vendor range.
 * Note: questa è IMPL parziale (string-prefix match). Per match CIDR
 * accurato usa la lib \`ip-cidr\` o \`ipaddr.js\` nel modulo che la consuma.
 *
 * @returns vendor name se match, null altrimenti.
 */
export function findVendorByIp(ip: string): string | null {
  if (!ip) return null;
  for (const r of BOT_IPRANGES) {
    if (r.error) continue;
    for (const cidr of r.cidrs) {
      // Quick prefix check — la verifica esatta va fatta upstream con ipaddr.js
      const network = cidr.split('/')[0];
      if (network && ip.startsWith(network.split('.').slice(0, 2).join('.'))) {
        return r.vendor;
      }
    }
  }
  return null;
}
`;
  writeFileSync(OUT_FILE, ts, 'utf-8');
  console.log(
    `[sync] wrote ${OUT_FILE}: ${totalCidrs} CIDRs from ${succeeded.length}/${SOURCES.length} vendors`,
  );
}

main().catch(async (err) => {
  console.error('[sync] FATAL:', err);
  await sendTelegramAlert(
    `🔴 <b>Bot IP-ranges sync FATAL</b>\n\n<code>${err.message}</code>\n\nAction: check sync script logs.`,
  );
  process.exit(1);
});
