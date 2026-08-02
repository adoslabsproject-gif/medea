/**
 * Spoofer policy — decisione "spoofer found → ban immediate".
 *
 * Razionale (user requirement 2026-06-02):
 * "Se spoofi, stai ficcando il naso dove non devi o quella è l'intenzione".
 *
 * Quando un client dichiara di essere Googlebot/Bingbot/Yandex/etc MA il
 * suo reverse-DNS NON matcha i suffix ufficiali pubblicati dal vendor,
 * è un comportamento INTENZIONALMENTE ingannevole:
 *
 *   1. Reale Googlebot esiste solo da `*.googlebot.com` / `*.google.com`.
 *      Vendor pubblica ufficialmente la lista (RFC-style commitment).
 *      Chi dichiara Googlebot da AWS / DigitalOcean / OVH / Hetzner / Azure
 *      sta LAVORANDO ATTIVAMENTE per ingannare il sistema di scoring.
 *
 *   2. Use case malicious typici:
 *      - Scraper aggressivo che vuole gli stessi privilegi del bot legit
 *      - Vulnerability scanner che maschera l'origine
 *      - Bot DDoS-coordination camuffato da search engine
 *      - Botnet che fa SSRF / probe usando UA Googlebot per bypass WAF
 *
 *   3. NO false positive: i vendor publican o documentano i suffix DNS.
 *      Un crawler legit DEVE essere identificabile via reverse-DNS.
 *      Se NON lo è, vendor avrebbe già pubblicato un'API o un workaround.
 *
 * Policy: spoofer → ban 7 giorni + audit + log JSONL `event_type='bot_spoof_detected'`.
 * NO honeypot threshold (3 hit) per gli spoofer — basta 1 detection.
 */

import { classifyBot } from './bot-allowlist.js';

export type SpooferAction =
  | 'ban_immediate' // spoofer confermato — ban 7gg + audit
  | 'allow_verified' // bot legit verificato via DNS
  | 'allow_ua_trust' // bot legit (vendor non pubblica DNS suffix)
  | 'allow_unknown'; // UA non in allowlist — passa al next layer (Behavioral)

export interface SpooferDecision {
  action: SpooferAction;
  reason: string;
  /** Bot family riconosciuto (utile per audit + logging). */
  claimedBotFamily: string | null;
  /** Ban duration suggerita (ms). 0 se no ban. */
  banDurationMs: number;
  /** Severity per audit / Telegram alert. */
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
}

export interface SpooferPolicyOptions {
  /**
   * strictMode default false (anti-false-positive):
   *  - false → se PTR=null (reverse DNS non risolve), trattiamo come
   *    "evidence insufficiente" → allow_unknown (NO ban). Protegge da
   *    false positive su client legit con setup DNS atipico (es. ASN
   *    che NON registra PTR sui propri IP). Lo spoofer reale invece ha
   *    PTR di un cloud provider che NON matcha — quello viene bannato.
   *  - true → PTR=null è già sufficiente per BAN. Più aggressivo, da usare
   *    DOPO osservazione (es. 48h di soft-log) per zero rischio.
   */
  strictMode?: boolean;
}

const BAN_DURATION_SPOOFER_MS = 7 * 24 * 60 * 60 * 1000; // 7 giorni

/**
 * Decide policy per una request based on UA + reverse-DNS.
 *
 * Safety: NON blocca legit bot. La policy `ban_immediate` scatta SOLO se:
 *   1. UA dichiara UN bot family con DNS suffix ufficiale pubblicato
 *   2. Reverse-DNS dell'IP origine NON matcha NESSUNO dei suffix
 *   3. (strictMode false) Reverse-DNS NON è null
 *
 * Esempi safe:
 *   - Real Googlebot da *.googlebot.com → allow_verified
 *   - GPTBot da QUALSIASI IP (no DNS suffix richiesto) → allow_ua_trust
 *   - Chrome reale → allow_unknown (no bot ID claim, no decision)
 *
 * Esempi blocked:
 *   - UA Googlebot + reverse-DNS amazonaws.com → ban_immediate (clear spoof)
 *
 * @param userAgent header User-Agent ricevuto
 * @param reverseDnsHostname risultato del reverse DNS lookup sull'IP origine
 *   (null = lookup non eseguito O nessun PTR record).
 * @param options policy options (strictMode default false).
 */
export function decideSpooferPolicy(
  userAgent: string,
  reverseDnsHostname: string | null,
  options: SpooferPolicyOptions = {},
): SpooferDecision {
  const strictMode = options.strictMode ?? false;
  const { status, match } = classifyBot(userAgent, reverseDnsHostname);

  switch (status) {
    case 'verified_legit': {
      return {
        action: 'allow_verified',
        reason: `${match?.name ?? 'unknown'} verified via reverse-DNS — passing through.`,
        claimedBotFamily: match?.name ?? null,
        banDurationMs: 0,
        severity: 'info',
      };
    }
    case 'ua_claimed_spoofable': {
      const family = match?.name ?? 'unknown';
      const suffixes = match?.verifyReverseDnsSuffix?.join(', ') ?? 'unknown';

      // Safety: PTR=null in non-strict mode → no ban (evidence insufficiente).
      // Lo spoofer reale ha PTR di un cloud provider, NON null. Il null è
      // ambiguous: client legit con setup atipico vs lookup fallito.
      if (reverseDnsHostname === null && !strictMode) {
        return {
          action: 'allow_unknown',
          reason:
            `Evidence insufficiente: UA dichiara ${family} ma reverse-DNS non disponibile (PTR=null). ` +
            `In non-strict mode passa al next layer (behavioral) invece di bannare.`,
          claimedBotFamily: family,
          banDurationMs: 0,
          severity: 'low',
        };
      }

      return {
        action: 'ban_immediate',
        reason:
          `SPOOFER: UA dichiara ${family} ma reverse-DNS "${reverseDnsHostname ?? 'NO_PTR'}" ` +
          `non matcha i suffix vendor (atteso: ${suffixes}). Ban 7gg immediato.`,
        claimedBotFamily: family,
        banDurationMs: BAN_DURATION_SPOOFER_MS,
        severity: 'high',
      };
    }
    case 'unknown':
    default: {
      return {
        action: 'allow_unknown',
        reason: 'UA non in allowlist — proseguire valutazione behavioral.',
        claimedBotFamily: null,
        banDurationMs: 0,
        severity: 'info',
      };
    }
  }
}

/**
 * Helper esposto per analytics: solo flag "is spoofer", senza dettaglio.
 */
export function isSpoofer(userAgent: string, reverseDnsHostname: string | null): boolean {
  return decideSpooferPolicy(userAgent, reverseDnsHostname).action === 'ban_immediate';
}

/**
 * Costanti per altri moduli (audit, Telegram, JSONL).
 */
export const SPOOFER_BAN_DURATION_MS = BAN_DURATION_SPOOFER_MS;
export const SPOOFER_BAN_REASON_CODE = 'bot_spoof_detected';
