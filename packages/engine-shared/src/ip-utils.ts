/**
 * IP Utilities — IPv4 + IPv6 CIDR matching with BigInt
 *
 * IPv4 uses 32-bit BigInt space. IPv6 uses 128-bit BigInt space.
 * They are SEPARATE address spaces — never mixed.
 *
 * Pre-computed ranges are split into rangesV4 and rangesV6 arrays.
 * Matching selects the correct array based on IP type after normalization.
 */

/**
 * Normalize IP address: trim whitespace, strip port suffix, convert IPv4-mapped IPv6.
 * MUST be called on ANY IP before using it for matching.
 *
 * Handling:
 * - Whitespace: "  1.2.3.4  " → "1.2.3.4"
 * - Port suffix IPv4: "1.2.3.4:8080" → "1.2.3.4"
 * - Port suffix IPv6 bracketed: "[::1]:8080" → "::1"
 * - IPv4-mapped IPv6: "::ffff:66.249.66.1" → "66.249.66.1"
 * - IPv4-mapped hex: "::ffff:c0a8:101" → stays IPv6
 * - Uppercase: "2001:DB8::1" → "2001:db8::1"
 */
export function normalizeIp(ip: string): string {
  let s = ip.trim();

  // [IPv6]:port → strip brackets and port
  if (s.startsWith('[')) {
    const closeBracket = s.indexOf(']');
    if (closeBracket !== -1) s = s.slice(1, closeBracket);
  }

  // IPv4:port → strip port (ONLY if exactly 1 colon and starts with digit)
  // Do NOT attempt to strip port on non-bracketed IPv6 (e.g., 2001:db8::1:443)
  const colonCount = (s.match(/:/g) ?? []).length;
  if (colonCount === 1 && /^\d/.test(s)) {
    const colonIdx = s.indexOf(':');
    s = s.slice(0, colonIdx);
  }

  // Lowercase for IPv6
  s = s.toLowerCase();

  // IPv4-mapped IPv6: ::ffff:1.2.3.4 → 1.2.3.4
  // Match ONLY dotted-decimal form (not ::ffff:c0a8:101)
  const v4MappedMatch = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (v4MappedMatch) return v4MappedMatch[1]!;

  return s;
}

/**
 * Parse IPv4 address to BigInt (32-bit space).
 */
export function ipv4ToNumber(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let result = BigInt(0);
  for (let i = 0; i < 4; i++) {
    const part = parts[i]!;
    // Reject empty, non-numeric, leading zeros (except "0"), or out of range
    if (part === '' || !/^\d+$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const num = parseInt(part, 10);
    if (num < 0 || num > 255) return null;
    result = (result << BigInt(8)) | BigInt(num);
  }

  return result;
}

/**
 * Parse IPv6 address to BigInt (full 128-bit space).
 *
 * Handles:
 * - Full notation: 2001:0db8:85a3:0000:0000:8a2e:0370:7334
 * - Compressed: 2001:db8::1
 * - IPv4-mapped: ::ffff:192.0.2.1 (parsed as IPv6 128-bit)
 * - Loopback: ::1
 * - All zeros: ::
 *
 * Validation (critical — parsing errors = spoof bypass):
 * - :: can appear AT MOST once
 * - Each hex group must be 1-4 characters
 * - After expansion, total groups MUST be exactly 8
 * - Valid characters: [0-9a-fA-F:.]
 * - Each group value <= 0xFFFF
 */
export function ipv6ToNumber(ip: string): bigint | null {
  const lower = ip.toLowerCase();

  // Validate characters
  if (!/^[0-9a-f:.]+$/.test(lower)) return null;

  // Handle IPv4-mapped in IPv6 (e.g., ::ffff:192.0.2.1)
  const lastColon = lower.lastIndexOf(':');
  const afterLastColon = lower.slice(lastColon + 1);
  if (afterLastColon.includes('.')) {
    // IPv4 suffix — parse the IPv4 part and prepend to IPv6
    const ipv4Num = ipv4ToNumber(afterLastColon);
    if (ipv4Num === null) return null;
    // Replace IPv4 part with two hex groups
    const hi = (ipv4Num >> BigInt(16)) & BigInt(0xffff);
    const lo = ipv4Num & BigInt(0xffff);
    const prefix = lower.slice(0, lastColon + 1) + hi.toString(16) + ':' + lo.toString(16);
    return ipv6ToNumber(prefix);
  }

  // Check :: appears at most once
  const doubleColonParts = lower.split('::');
  if (doubleColonParts.length > 2) return null;

  let groups: string[];

  if (doubleColonParts.length === 2) {
    // Has :: compression
    const left = doubleColonParts[0] === '' ? [] : doubleColonParts[0]!.split(':');
    const right = doubleColonParts[1] === '' ? [] : doubleColonParts[1]!.split(':');

    // Check for empty groups from triple colons (:::)
    if (left.some(g => g === '') || right.some(g => g === '')) return null;

    const fillerCount = 8 - left.length - right.length;
    if (fillerCount < 0) return null;

    groups = [...left, ...Array<string>(fillerCount).fill('0'), ...right];
  } else {
    // No :: — must have exactly 8 groups
    groups = lower.split(':');
  }

  if (groups.length !== 8) return null;

  let result = BigInt(0);
  for (const group of groups) {
    // Each group: 1-4 hex characters, no empty
    if (group.length === 0 || group.length > 4) return null;
    if (!/^[0-9a-f]+$/.test(group)) return null;

    const value = parseInt(group, 16);
    if (value > 0xffff) return null;

    result = (result << BigInt(16)) | BigInt(value);
  }

  return result;
}

/**
 * Parse any IP (v4 or v6) to BigInt.
 * Call normalizeIp() BEFORE this to handle IPv4-mapped, port suffix, whitespace.
 */
export function ipToNumber(ip: string): bigint | null {
  if (ip.includes(':')) return ipv6ToNumber(ip);
  return ipv4ToNumber(ip);
}

/**
 * Parse CIDR notation to numeric range.
 * IPv4 returns 32-bit range. IPv6 returns 128-bit range.
 */
export function cidrToRange(cidr: string): { start: bigint; end: bigint; isV6: boolean } | null {
  const slashIdx = cidr.indexOf('/');
  if (slashIdx === -1) return null;

  const ip = cidr.slice(0, slashIdx);
  const prefixStr = cidr.slice(slashIdx + 1);
  if (!ip || !prefixStr) return null;

  const prefix = parseInt(prefixStr, 10);
  if (isNaN(prefix)) return null;

  const isV6 = ip.includes(':');

  if (isV6) {
    const ipNum = ipv6ToNumber(ip);
    if (ipNum === null || prefix < 0 || prefix > 128) return null;
    if (prefix === 128) return { start: ipNum, end: ipNum, isV6: true };
    const mask = (BigInt(1) << BigInt(128 - prefix)) - BigInt(1);
    const start = ipNum & ~mask;
    const end = start | mask;
    return { start, end, isV6: true };
  } else {
    const ipNum = ipv4ToNumber(ip);
    if (ipNum === null || prefix < 0 || prefix > 32) return null;
    if (prefix === 32) return { start: ipNum, end: ipNum, isV6: false };
    const mask = (BigInt(1) << BigInt(32 - prefix)) - BigInt(1);
    const start = ipNum & ~mask;
    const end = start | mask;
    return { start, end, isV6: false };
  }
}

/**
 * Check if IP is within a CIDR range.
 */
export function isIpInCidr(ip: string, cidr: string): boolean {
  const range = cidrToRange(cidr);
  if (!range) return false;

  const isV6 = ip.includes(':');
  if (isV6 !== range.isV6) return false;

  const ipNum = isV6 ? ipv6ToNumber(ip) : ipv4ToNumber(ip);
  if (ipNum === null) return false;

  return ipNum >= range.start && ipNum <= range.end;
}

/**
 * Check if IP is within any of the given pre-computed ranges.
 * IP MUST already be normalized with normalizeIp().
 */
export function isIpInRanges(ip: string, ranges: readonly { start: bigint; end: bigint }[]): boolean {
  const isV6 = ip.includes(':');
  const ipNum = isV6 ? ipv6ToNumber(ip) : ipv4ToNumber(ip);
  if (ipNum === null) return false;

  for (const range of ranges) {
    if (ipNum >= range.start && ipNum <= range.end) {
      return true;
    }
  }
  return false;
}

/**
 * Pre-compute CIDR ranges for fast lookup.
 * Returns separate V4 and V6 arrays.
 */
export function precomputeRanges(cidrs: readonly string[]): {
  rangesV4: { start: bigint; end: bigint }[];
  rangesV6: { start: bigint; end: bigint }[];
} {
  const rangesV4: { start: bigint; end: bigint }[] = [];
  const rangesV6: { start: bigint; end: bigint }[] = [];

  for (const cidr of cidrs) {
    const range = cidrToRange(cidr);
    if (range) {
      if (range.isV6) {
        rangesV6.push({ start: range.start, end: range.end });
      } else {
        rangesV4.push({ start: range.start, end: range.end });
      }
    }
  }

  return { rangesV4, rangesV6 };
}

// ─── Private/Reserved ranges ─────────────────────────────────────────────────

const PRIVATE_RESERVED_V4 = [
  '10.0.0.0/8',           // RFC 1918
  '172.16.0.0/12',        // RFC 1918
  '192.168.0.0/16',       // RFC 1918
  '127.0.0.0/8',          // Loopback
  '169.254.0.0/16',       // Link-local
  '100.64.0.0/10',        // CGNAT (RFC 6598)
  '0.0.0.0/8',            // This network
  '224.0.0.0/4',          // Multicast
  '240.0.0.0/4',          // Reserved
  '192.0.2.0/24',         // TEST-NET-1 (RFC 5737)
  '198.51.100.0/24',      // TEST-NET-2 (RFC 5737)
  '203.0.113.0/24',       // TEST-NET-3 (RFC 5737)
];

const PRIVATE_RESERVED_V6 = [
  'fc00::/7',             // ULA (RFC 4193)
  'fe80::/10',            // Link-local
  '::1/128',              // Loopback
  '::/128',               // Unspecified
  'ff00::/8',             // Multicast
  '2001:db8::/32',        // Documentation (RFC 3849)
];

const _privateRangesV4 = precomputeRanges(PRIVATE_RESERVED_V4);
const _privateRangesV6 = precomputeRanges(PRIVATE_RESERVED_V6);

/**
 * Check if CIDR falls within private/reserved address space.
 * Used to reject bogus bot ranges from compromised endpoints.
 */
export function isPrivateOrReserved(cidr: string): boolean {
  const range = cidrToRange(cidr);
  if (!range) return false;

  // Check if the START of the range falls within any private range
  const privateRanges = range.isV6 ? _privateRangesV6.rangesV6 : _privateRangesV4.rangesV4;

  for (const priv of privateRanges) {
    // If the CIDR start IP falls within a private range, it's private
    if (range.start >= priv.start && range.start <= priv.end) return true;
    // If the CIDR end IP falls within a private range, it overlaps
    if (range.end >= priv.start && range.end <= priv.end) return true;
    // If the CIDR fully contains a private range
    if (range.start <= priv.start && range.end >= priv.end) return true;
  }

  return false;
}
