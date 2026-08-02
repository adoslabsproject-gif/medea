/**
 * Ban-safety guard — refuse to ban infrastructure IPs.
 *
 * PERCHÉ ESISTE
 * -------------
 * La catena di ban (Sentinel honeypot → recordBan → security_bans → nginx
 * banned-ips.conf) blocca a livello firewall qualsiasi IP che gli arriva.
 * Se per QUALSIASI motivo (header cf-connecting-ip assente, drift della lista
 * Cloudflare, bug futuro, payload manipolato) la catena ricevesse un IP che
 * NON è un client esterno reale, il blocco sarebbe catastrofico:
 *
 *   - IP Cloudflare → dietro un singolo edge CF passano MIGLIAIA di utenti
 *     legittimi → bloccarlo = auto-DoS di massa
 *   - IP privato/loopback (127.0.0.1, 10.x, ::1) → blocca health-check interni
 *     e traffico server-to-server
 *   - IP del nostro server (78.46.219.172) → self-block
 *   - IP infra interna nota (NHA proxy 91.98.131.3) → rompe l'integrazione
 *
 * Questa è una rete di sicurezza FAIL-SAFE: nel dubbio (IP non parsabile)
 * rifiuta il ban. Meglio non bannare un attaccante che bannarsi da soli.
 *
 * ISOMORFO: nessuna dipendenza da Node — usabile sia nel portal (Node) sia
 * in bundle browser. Riusa il motore CIDR BigInt di ./ip-utils.
 *
 * Le liste Cloudflare sono lo specchio di infrastructure/firewall/
 * update-cloudflare-ips.sh (che genera i file nginx). Restano canoniche e
 * stabili — CF aggiunge range raramente. Sincronizzate il 2026-06-01.
 * Fonte: https://www.cloudflare.com/ips-v4 + /ips-v6
 */

import { normalizeIp, ipToNumber, isPrivateOrReserved, precomputeRanges } from './ip-utils.js';

/** Cloudflare IPv4 published ranges (cloudflare.com/ips-v4). */
export const CLOUDFLARE_V4: readonly string[] = Object.freeze([
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
]);

/** Cloudflare IPv6 published ranges (cloudflare.com/ips-v6). */
export const CLOUDFLARE_V6: readonly string[] = Object.freeze([
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29', // <- contiene 2a06:98c0:3600::103 della segnalazione 2026-06-01
  '2c0f:f248::/32',
]);

/**
 * Infra ZeliAI interna da non bannare MAI. Specchio di:
 *  - SERVER_SELF_IP in update-cloudflare-ips.sh (78.46.219.172)
 *  - memory/internal-ips-whitelist.md (NHA production proxy 91.98.131.3)
 */
export const ZELI_INFRA_CIDRS: readonly string[] = Object.freeze([
  '78.46.219.172/32', // Hetzner GEX131 — questo server (health-check via public IP)
  '91.98.131.3/32', // NHA production server (proxy interno → Liara gateway)
]);

/** Motivo per cui un IP NON è bannabile. `null` = bannabile (client reale). */
export type BanUnsafeReason = 'unparseable' | 'private_reserved' | 'cloudflare' | 'infrastructure';

export interface BanSafetyResult {
  /** true ⇒ è un client esterno reale, si può bannare. */
  readonly safe: boolean;
  /** Motivo del rifiuto, o null se safe. */
  readonly reason: BanUnsafeReason | null;
  /** IP normalizzato (post normalizeIp), per logging coerente. */
  readonly normalizedIp: string;
}

// Pre-compute una sola volta a load-time.
const _cloudflare = precomputeRanges([...CLOUDFLARE_V4, ...CLOUDFLARE_V6]);
const _zeliInfra = precomputeRanges(ZELI_INFRA_CIDRS);

function inRanges(
  ip: string,
  ranges: {
    rangesV4: readonly { start: bigint; end: bigint }[];
    rangesV6: readonly { start: bigint; end: bigint }[];
  },
): boolean {
  const ipNum = ipToNumber(ip);
  if (ipNum === null) return false;
  const list = ip.includes(':') ? ranges.rangesV6 : ranges.rangesV4;
  for (const r of list) {
    if (ipNum >= r.start && ipNum <= r.end) return true;
  }
  return false;
}

/**
 * Classifica un IP: bannabile (client reale) o protetto (infra).
 *
 * @param rawIp IP grezzo (verrà normalizzato; accetta port suffix, IPv4-mapped, ecc.)
 * @param extraProtectedCidrs CIDR aggiuntivi da proteggere (es. da env del chiamante)
 */
export function classifyBanSafety(
  rawIp: string,
  extraProtectedCidrs: readonly string[] = [],
): BanSafetyResult {
  const ip = normalizeIp(rawIp ?? '');

  // FAIL-SAFE: ciò che non sappiamo parsare non lo banniamo.
  if (ipToNumber(ip) === null) {
    return { safe: false, reason: 'unparseable', normalizedIp: ip };
  }

  const slashSuffix = ip.includes(':') ? '/128' : '/32';
  if (isPrivateOrReserved(`${ip}${slashSuffix}`)) {
    return { safe: false, reason: 'private_reserved', normalizedIp: ip };
  }

  if (inRanges(ip, _cloudflare)) {
    return { safe: false, reason: 'cloudflare', normalizedIp: ip };
  }

  if (inRanges(ip, _zeliInfra)) {
    return { safe: false, reason: 'infrastructure', normalizedIp: ip };
  }

  if (extraProtectedCidrs.length > 0) {
    const extra = precomputeRanges(extraProtectedCidrs);
    if (inRanges(ip, extra)) {
      return { safe: false, reason: 'infrastructure', normalizedIp: ip };
    }
  }

  return { safe: true, reason: null, normalizedIp: ip };
}

/**
 * Shortcut booleano: true ⇒ si può bannare (client esterno reale).
 */
export function isBanSafe(rawIp: string, extraProtectedCidrs: readonly string[] = []): boolean {
  return classifyBanSafety(rawIp, extraProtectedCidrs).safe;
}
