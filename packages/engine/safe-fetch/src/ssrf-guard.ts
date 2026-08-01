/**
 * SSRF guard — validazione URL per `fetch()` su input utente non-trusted.
 *
 * Modulo SHARED (`@flowforge/safe-fetch`). Pre-N20 c'erano DUE copie:
 *   - apps/flowforge-runtime/src/lib/ssrf-guard.ts (canonical)
 *   - packages/flowforge/nodes/stdlib/src/lib/ssrf-guard.ts (mirror)
 *
 * Diverged silentemente: nuove regole aggiunte alla canonical non
 * propagate al mirror → drift. N20 audit (2026-05-29) ha unificato
 * tutto qui per prevenire il pattern "fix non propagato a codice cugino".
 *
 * Bloccato:
 *   - scheme non http(s) (file:, gopher:, ftp:, javascript:, data:)
 *   - IP RFC1918 (10/8, 172.16/12, 192.168/16), loopback (127/8), link-local
 *     (169.254/16 — include cloud metadata IMDS), broadcast
 *   - IPv6 loopback (::1), link-local (fe80::), site-local (fc00::/7)
 *   - hostname `localhost` letterale + altri reserved (vedi `RESERVED_HOSTS`)
 *
 * Difesa DNS-rebinding (2026-06-10):
 *   - `validateUrlForFetch` valida i LETTERALI (IP nell'URL + hostname riservati).
 *   - `validateIpForFetch(ip)` valida un IP GIÀ RISOLTO con le stesse regole.
 *     Il chiamante Node-side (es. `safeOutboundFetch`) risolve il DNS PRIMA
 *     del fetch e passa ogni indirizzo qui → blocca l'host pubblico che risolve
 *     a 127.0.0.1 / 10.x / 169.254.169.254 (vettore SSRF-via-DNS più comune).
 *   - Questo modulo è browser-safe (zero `node:dns`): la risoluzione DNS vive
 *     nel chiamante Node, qui resta solo la validazione pura dell'IP.
 *
 * Difesa completa (2 layer):
 *   - Layer 1 (qui + caller): validazione letterali + `validateIpForFetch` sugli
 *     IP pre-risolti. Errori chiari, copre il vettore SSRF-via-DNS comune.
 *   - Layer 2 (runtime `secure-dispatcher.ts`): dispatcher undici con
 *     `connect.lookup` hook → valida l'IP ESATTO che la socket userà, al momento
 *     della connessione. Chiude il rebinding sub-secondo (TOCTOU) e copre ogni
 *     hop/connessione del pool automaticamente.
 *
 * Limiti residui:
 *   - Redirect cross-host: `redirect: 'follow'` può portare a IP privato.
 *     Tutti i callsite DEVONO usare `redirect: 'manual'` e re-validare
 *     ogni Location header con questo modulo (o usare `safeFetchWithRedirects`
 *     che incapsula il loop).
 */

// N20 fix (2026-05-29): pure-JS isomorphic `isIP` — non importiamo
// `node:net` perche\` questo pacchetto e\` incluso nel bundle browser
// dell'editor (cascade workspace via nodes-stdlib). I 42 test SSRF
// validano l'equivalenza semantica con Node `net.isIP` per i nostri input.
import { isIP } from './is-ip.js';

export type SsrfBlockReason =
  | 'INVALID_URL'
  | 'BLOCKED_SCHEME'
  | 'BLOCKED_HOST'
  | 'BLOCKED_PRIVATE_IP'
  | 'BLOCKED_LOOPBACK'
  | 'BLOCKED_LINK_LOCAL'
  | 'BLOCKED_RESERVED';

export interface SsrfValidationResult {
  ok: boolean;
  reason?: SsrfBlockReason;
  detail?: string;
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/**
 * Hostname stringa letterali da bloccare anche prima della risoluzione DNS.
 * `localhost.*` cattura sottodomini deliberati (`evil.localhost`, etc).
 */
const RESERVED_HOSTS = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'broadcasthost',
  // Cloud metadata endpoints — anche se IMDSv2 richiede token, IMDSv1
  // è spesso ancora accessibile e leak credenziali ruoli IAM.
  'metadata.google.internal',
  'metadata.googleapis.com',
  'instance-data.ec2.internal',
  'metadata.azure.com',
  'metadata.alibabacloud.com',
]);

/** Match suffisso `.localhost` (RFC 6761). */
function isLocalhostSuffix(host: string): boolean {
  return host.endsWith('.localhost');
}

/**
 * Check se IPv4 in range RFC1918, loopback, link-local, broadcast.
 * Implementazione esplicita (no dipendenza ipaddr.js) — input gia` validato
 * come IPv4 da `isIP()`.
 */
function isPrivateIPv4(ip: string): { blocked: boolean; reason?: SsrfBlockReason } {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return { blocked: true, reason: 'INVALID_URL' };
  }
  const [a = 0, b = 0] = parts;
  // RFC 5735 + RFC 1918 + RFC 6598 (CGN) + RFC 3927 (link-local) + RFC 2544
  if (a === 10) return { blocked: true, reason: 'BLOCKED_PRIVATE_IP' };
  if (a === 172 && b >= 16 && b <= 31) return { blocked: true, reason: 'BLOCKED_PRIVATE_IP' };
  if (a === 192 && b === 168) return { blocked: true, reason: 'BLOCKED_PRIVATE_IP' };
  if (a === 127) return { blocked: true, reason: 'BLOCKED_LOOPBACK' };
  if (a === 169 && b === 254) return { blocked: true, reason: 'BLOCKED_LINK_LOCAL' };       // include 169.254.169.254 cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return { blocked: true, reason: 'BLOCKED_PRIVATE_IP' };       // RFC 6598 CGN
  if (a === 0) return { blocked: true, reason: 'BLOCKED_RESERVED' };                                  // 0.0.0.0/8
  if (a === 192 && b === 0) return { blocked: true, reason: 'BLOCKED_RESERVED' };                     // 192.0.0.0/24 + 192.0.2.0/24
  if (a === 198 && b === 51) return { blocked: true, reason: 'BLOCKED_RESERVED' };                    // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0) return { blocked: true, reason: 'BLOCKED_RESERVED' };                     // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return { blocked: true, reason: 'BLOCKED_RESERVED' };                                 // 224/4 multicast + 240/4 reserved
  return { blocked: false };
}

/**
 * Check IPv6 loopback/link-local/site-local/multicast/unique-local.
 * Input `ip` deve essere gia` validato come IPv6 da `isIP() === 6`.
 */
function isPrivateIPv6(ip: string): { blocked: boolean; reason?: SsrfBlockReason } {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return { blocked: true, reason: 'BLOCKED_LOOPBACK' };
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return { blocked: true, reason: 'BLOCKED_RESERVED' };
  // fe80::/10 link-local
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return { blocked: true, reason: 'BLOCKED_LINK_LOCAL' };
  }
  // fc00::/7 unique local
  if (lower.startsWith('fc') || lower.startsWith('fd')) {
    return { blocked: true, reason: 'BLOCKED_PRIVATE_IP' };
  }
  // ff00::/8 multicast
  if (lower.startsWith('ff')) return { blocked: true, reason: 'BLOCKED_RESERVED' };
  // IPv4 EMBEDDED in IPv6 — controllo FORM-AGNOSTICO (compressa/espansa/dotted):
  // espandiamo a 8 hextet e verifichiamo i prefissi /96 numericamente, così copriamo
  // sia `::ffff:7f00:1` sia `0:0:0:0:0:ffff:7f00:1`, sia `64:ff9b::a00:1` sia
  // `64:ff9b:0:0:0:0:a00:1`. (Un regex sulla sola forma `::` lascerebbe scoperta
  // la forma espansa — vettore teorico ma da chiudere comunque, no compromessi.)
  const hx = expandIPv6Hextets(lower);
  if (hx) {
    const [g0, g1, g2, g3, g4, g5, g6, g7] = hx;
    const embeddedV4 = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
    // ::ffff:0:0/96 — IPv4-mapped IPv6
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
      return isPrivateIPv4(embeddedV4);
    }
    // 64:ff9b::/96 — NAT64 well-known (RFC 6052): IPv4 PUBBLICO embedded resta lecito.
    if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
      return isPrivateIPv4(embeddedV4);
    }
  }
  return { blocked: false };
}

/**
 * Espande un IPv6 (qualsiasi forma: `::`-compressa, espansa, con IPv4 dotted finale)
 * in 8 hextet numerici 0..0xffff. Ritorna `null` se non parsabile. Input atteso già
 * validato come IPv6 da `isIP() === 6`; questa è la normalizzazione per il match dei
 * prefissi embedded-IPv4 (indipendente dalla forma testuale che arriva al guard).
 */
function expandIPv6Hextets(ip: string): [number, number, number, number, number, number, number, number] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%'); // scarta lo zone-id (%eth0)
  if (zone >= 0) s = s.slice(0, zone);
  // IPv4 dotted finale → due hextet hex.
  let invalid = false;
  s = s.replace(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u, (_m, a: string, b: string, c: string, d: string) => {
    const o = [a, b, c, d].map(Number);
    if (o.some((n) => n > 255)) { invalid = true; return ''; }
    return `${(((o[0] ?? 0) << 8) | (o[1] ?? 0)).toString(16)}:${(((o[2] ?? 0) << 8) | (o[3] ?? 0)).toString(16)}`;
  });
  if (invalid) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (g === '' ? 0 : parseInt(g, 16)));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return nums as [number, number, number, number, number, number, number, number];
}

/**
 * Valida una URL per `fetch()` su input utente non-trusted.
 *
 * Ritorna `{ ok: true }` solo se URL valida + scheme http(s) + host pubblico.
 * Per cluster Docker interni (es. `flowforge-net`), passare `allowDockerNet: true`
 * MA: solo per comunicazione service-to-service esplicita, MAI per input utente.
 */
/** Parsing di UN componente inet_aton: decimale, esadecimale (`0x..`), ottale (`0..`). */
function parseInetComponent(p: string): number | null {
  if (p === '') return null;
  if (/^0[xX][0-9a-fA-F]+$/.test(p)) return parseInt(p.slice(2), 16);
  if (/^0[0-7]+$/.test(p)) return parseInt(p.slice(1), 8); // ottale (leading 0)
  if (/^[0-9]+$/.test(p)) return parseInt(p, 10);
  return null; // componente non-numerico → NON è un IPv4 (è un hostname)
}

/**
 * Normalizza un host IPv4 OFFUSCATO (decimale `2130706433`, hex `0x7f000001`, ottale
 * `0177.0.0.1`, o forme a 1-3 parti tipo `127.1`) nella forma dotted-decimal canonica.
 * Ritorna `null` se l'host NON è un IPv4 (es. un vero hostname `example.com`).
 *
 * È la `host normalization` che il commento di is-ip.ts prometteva e che MANCAVA: senza,
 * `http://2130706433` → `isIP` ritorna 0 → `isPrivateIPv4` non viene mai chiamato → SSRF
 * AGGIRATA da consumer che NON beneficiano della normalizzazione WHATWG-URL (browser
 * bundle, host passato a `validateIpForFetch` grezzo). Regole inet_aton: l'ultima parte
 * assorbe i byte rimanenti.
 */
export function normalizeObfuscatedIPv4(host: string): string | null {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const n = parseInetComponent(p);
    if (n === null || !Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  let value: number;
  switch (nums.length) {
    case 1:
      value = nums[0]!;
      break;
    case 2:
      if (nums[0]! > 0xff) return null;
      value = nums[0]! * 0x1000000 + nums[1]!;
      break;
    case 3:
      if (nums[0]! > 0xff || nums[1]! > 0xff) return null;
      value = nums[0]! * 0x1000000 + nums[1]! * 0x10000 + nums[2]!;
      break;
    default: // 4
      if (nums.slice(0, 3).some((n) => n > 0xff)) return null;
      value = nums[0]! * 0x1000000 + nums[1]! * 0x10000 + nums[2]! * 0x100 + nums[3]!;
      break;
  }
  if (value < 0 || value > 0xffffffff) return null;
  // Aritmetica (no bit-shift: in JS `>>` è signed 32-bit → negativo oltre 2^31).
  const o0 = Math.floor(value / 0x1000000) % 256;
  const o1 = Math.floor(value / 0x10000) % 256;
  const o2 = Math.floor(value / 0x100) % 256;
  const o3 = value % 256;
  return `${o0}.${o1}.${o2}.${o3}`;
}

export function validateUrlForFetch(
  rawUrl: string,
  opts: { allowDockerNet?: boolean; allowedHosts?: readonly string[] } = {},
): SsrfValidationResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'INVALID_URL', detail: 'URL non parsabile' };
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return { ok: false, reason: 'BLOCKED_SCHEME', detail: `scheme "${url.protocol}" non permesso` };
  }

  // Esenzione ESPLICITA per host:porta fidati (es. il gateway LLM interno di sistema,
  // FLOWFORGE_LIARA_BASE_URL=172.20.0.1:3006, raggiunto via la bridge docker). È
  // traffico di SISTEMA, non URL controllata dall'utente → l'IP privato è by-design.
  // Match ESATTO host+porta: NON apre la rete privata, solo l'endpoint enumerato. Lo
  // passano SOLO i call-site interni (mai il tool http_request dell'agent). Coerente
  // con guardCustomBaseUrl della chat (esenzione per origin del gateway interno). Lo
  // scheme è già validato sopra; i redirect verso host NON in allowedHosts restano bloccati.
  if (opts.allowedHosts && opts.allowedHosts.length > 0 && opts.allowedHosts.includes(url.host.toLowerCase())) {
    return { ok: true };
  }

  const rawHost = url.hostname.toLowerCase();
  if (rawHost === '') {
    return { ok: false, reason: 'INVALID_URL', detail: 'hostname vuoto' };
  }
  // WHATWG URL conserva le quadre `[…]` per literal IPv6 in `hostname`.
  // `isIP()` non riconosce con quadre — strip per il check IP.
  const host = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost;

  if (RESERVED_HOSTS.has(host) || isLocalhostSuffix(host)) {
    return { ok: false, reason: 'BLOCKED_HOST', detail: `hostname riservato: ${host}` };
  }

  // Normalizza un IPv4 OFFUSCATO (decimale/hex/ottale/parti-multiple) a dotted-decimal
  // PRIMA del check: difesa auto-sufficiente del package (i consumer che non beneficiano
  // della normalizzazione WHATWG-URL non sono esposti).
  const ipHost = normalizeObfuscatedIPv4(host) ?? host;
  const ipKind = isIP(ipHost);
  if (ipKind === 4) {
    const r = isPrivateIPv4(ipHost);
    if (r.blocked) return { ok: false, reason: r.reason ?? 'BLOCKED_PRIVATE_IP', detail: `IPv4 privato/riservato: ${host}` };
  } else if (ipKind === 6) {
    const r = isPrivateIPv6(ipHost);
    if (r.blocked) return { ok: false, reason: r.reason ?? 'BLOCKED_PRIVATE_IP', detail: `IPv6 privato/riservato: ${host}` };
  }
  // Hostname non-IP: il check definitivo avverrebbe DOPO risoluzione DNS.
  // Qui blocchiamo solo letterali. La defense-in-depth è demandata al
  // lookup hook (vedi modulo doc above).

  // Docker bridge net `flowforge-*.flowforge-net` — bloccato di default.
  // Solo callsite interni con `allowDockerNet: true` possono usarlo.
  if (!opts.allowDockerNet && host.endsWith('.flowforge-net')) {
    return { ok: false, reason: 'BLOCKED_HOST', detail: 'Docker internal network non permessa' };
  }

  return { ok: true };
}

/**
 * Valida un IP GIÀ RISOLTO (output di una lookup DNS) con le stesse regole
 * private/loopback/link-local/reserved di `validateUrlForFetch`.
 *
 * Difesa DNS-rebinding statico: il chiamante Node risolve l'hostname PRIMA del
 * fetch e passa ogni indirizzo qui. Un host pubblico il cui A record punta a
 * 127.0.0.1 / 10.x / 169.254.169.254 viene così bloccato (la sola validazione
 * dell'URL non basta perché l'hostname è "pubblico").
 *
 * Input atteso: una stringa IP (v4 o v6). Una stringa che NON è un IP valido
 * ritorna `INVALID_URL` (difensivo: il chiamante deve passare IP risolti).
 */
export function validateIpForFetch(ip: string): SsrfValidationResult {
  // Defense-in-depth: se il chiamante passa un IPv4 OFFUSCATO (decimale/hex/ottale),
  // normalizzalo a dotted-decimal prima del check privato (no bypass auto-sufficiente).
  const normalized = normalizeObfuscatedIPv4(ip) ?? ip;
  const kind = isIP(normalized);
  if (kind === 4) {
    const r = isPrivateIPv4(normalized);
    if (r.blocked) return { ok: false, reason: r.reason ?? 'BLOCKED_PRIVATE_IP', detail: `IPv4 privato/riservato risolto: ${ip}` };
    return { ok: true };
  }
  if (kind === 6) {
    const r = isPrivateIPv6(ip);
    if (r.blocked) return { ok: false, reason: r.reason ?? 'BLOCKED_PRIVATE_IP', detail: `IPv6 privato/riservato risolto: ${ip}` };
    return { ok: true };
  }
  return { ok: false, reason: 'INVALID_URL', detail: `non è un IP valido: ${ip}` };
}

/**
 * Helper convenience — throw se URL non valida (per use in async flows
 * dove vogliamo propagare l'errore con stack trace).
 */
export class SsrfBlockedError extends Error {
  constructor(public readonly reason: SsrfBlockReason, public readonly detail: string) {
    super(`SSRF blocked (${reason}): ${detail}`);
    this.name = 'SsrfBlockedError';
  }
}

export function assertUrlSafe(
  rawUrl: string,
  opts?: { allowDockerNet?: boolean; allowedHosts?: readonly string[] },
): void {
  const r = validateUrlForFetch(rawUrl, opts);
  if (!r.ok) throw new SsrfBlockedError(r.reason ?? 'INVALID_URL', r.detail ?? 'invalid');
}
