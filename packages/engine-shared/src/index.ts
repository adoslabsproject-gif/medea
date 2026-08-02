/**
 * @medea/engine-shared
 *
 * Shared utilities for ZeliAI enterprise infrastructure.
 *
 * - Circuit Breaker: State machine with HALF_OPEN probe safety
 * - Circuit Breaker Registry: Singleton for managing all breakers
 * - IP Utils: IPv4 + IPv6 CIDR matching with BigInt
 */

// Circuit Breaker
export {
  CircuitBreaker,
  CircuitOpenError,
  type CircuitState,
  type CircuitBreakerOptions,
  type CircuitBreakerStats,
} from './circuit-breaker.js';

// Circuit Breaker Registry
export { CircuitBreakerRegistry } from './circuit-breaker-registry.js';

// IP Utilities
export {
  normalizeIp,
  ipv4ToNumber,
  ipv6ToNumber,
  ipToNumber,
  cidrToRange,
  isIpInCidr,
  isIpInRanges,
  precomputeRanges,
  isPrivateOrReserved,
} from './ip-utils.js';

// Honeypot path classification (shared between Hono middlewares + analytics)
export {
  HONEYPOT_PATTERNS,
  classifyHoneypotPath,
  type HoneypotCategory,
  type HoneypotPattern,
  type HoneypotMatch,
} from './honeypot-paths.js';

// Ban-safety guard — refuse to ban Cloudflare / infra / reserved IPs
export {
  classifyBanSafety,
  isBanSafe,
  CLOUDFLARE_V4,
  CLOUDFLARE_V6,
  ZELI_INFRA_CIDRS,
  type BanUnsafeReason,
  type BanSafetyResult,
} from './ban-safety.js';

// PII redaction helpers — GDPR-compliant logging
export { maskEmail, maskIp } from './mask-pii.js';

// Bot allowlist — comprehensive legit bot registry (curated)
export {
  LEGITIMATE_BOTS,
  matchLegitimateBot,
  verifyReverseDns,
  classifyBot,
  type BotCategory,
  type LegitimateBot,
  type BotMatch,
  type BotVerificationStatus,
} from './bot-allowlist.js';

// Bot long-tail registry (auto-sync da GitHub monperrus/crawler-user-agents)
export { KNOWN_CRAWLERS, isKnownCrawler, type KnownCrawler } from './known-crawlers-generated.js';

// Bot IP ranges canonical (auto-sync da vendor JSON endpoints)
export { BOT_IPRANGES, TOTAL_CIDRS, LAST_SYNC_AT, findVendorByIp, type BotIpRange } from './bot-ipranges-generated.js';

// Spoofer policy — UA claim vs reverse-DNS verification → ban_immediate decision
export {
  decideSpooferPolicy,
  isSpoofer,
  SPOOFER_BAN_DURATION_MS,
  SPOOFER_BAN_REASON_CODE,
  type SpooferAction,
  type SpooferDecision,
  type SpooferPolicyOptions,
} from './spoofer-policy.js';
