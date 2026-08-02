/**
 * Tests per ban-safety.ts — guard anti-auto-ban su IP infrastruttura.
 *
 * Invariante CRITICA: NESSUN IP Cloudflare / privato / riservato / infra
 * ZeliAI deve mai risultare bannabile. Bannare un edge CF = auto-DoS di
 * massa (migliaia di utenti dietro lo stesso IP). Il guard è fail-safe:
 * IP non parsabile → NON bannabile.
 *
 * Copre: tutti i range CF v4+v6 (boundary inizio/fine), private/reserved,
 * self+NHA, normalizzazione (port, IPv4-mapped, case), extra CIDR param,
 * e i veri positivi (scanner pubblici reali devono restare bannabili).
 */

import { describe, it, expect } from 'vitest';
import {
  classifyBanSafety,
  isBanSafe,
  CLOUDFLARE_V4,
  CLOUDFLARE_V6,
  ZELI_INFRA_CIDRS,
} from '../ban-safety.js';
import { cidrToRange } from '../ip-utils.js';

/** Ricostruisce un IP stringa dal numero (per testare boundary dei range). */
function v4FromNum(n: bigint): string {
  return [(n >> 24n) & 0xffn, (n >> 16n) & 0xffn, (n >> 8n) & 0xffn, n & 0xffn].join('.');
}

describe('classifyBanSafety — Cloudflare (mai bannare)', () => {
  it('IPv6 della segnalazione reale 2a06:98c0:3600::103 → cloudflare', () => {
    const r = classifyBanSafety('2a06:98c0:3600::103');
    expect(r.safe).toBe(false);
    expect(r.reason).toBe('cloudflare');
    expect(r.normalizedIp).toBe('2a06:98c0:3600::103');
  });

  it('ogni range CF IPv4: primo e ultimo IP del blocco → cloudflare', () => {
    for (const cidr of CLOUDFLARE_V4) {
      const range = cidrToRange(cidr);
      expect(range, `cidr ${cidr} deve parsare`).not.toBeNull();
      if (!range) continue;
      const first = v4FromNum(range.start);
      const last = v4FromNum(range.end);
      expect(isBanSafe(first), `${cidr} start ${first} deve essere protetto`).toBe(false);
      expect(isBanSafe(last), `${cidr} end ${last} deve essere protetto`).toBe(false);
      expect(classifyBanSafety(first).reason).toBe('cloudflare');
    }
  });

  it('ogni range CF IPv6: primo IP del blocco → cloudflare', () => {
    for (const cidr of CLOUDFLARE_V6) {
      const ip = cidr.split('/')[0]!;
      const r = classifyBanSafety(ip);
      expect(r.safe, `${cidr} base ${ip} deve essere protetto`).toBe(false);
      expect(r.reason).toBe('cloudflare');
    }
  });

  it('IP appena FUORI da un range CF → bannabile (no over-blocking)', () => {
    // 104.16.0.0/13 → ultimo è 104.23.255.255; 104.24.0.0 è range diverso (CF).
    // Uso un IP chiaramente fuori da TUTTI i blocchi CF: 8.8.8.8 (Google DNS).
    expect(isBanSafe('8.8.8.8')).toBe(true);
  });
});

describe('classifyBanSafety — private / reserved (mai bannare)', () => {
  it.each([
    ['127.0.0.1'],
    ['10.0.0.5'],
    ['172.16.0.1'],
    ['192.168.1.1'],
    ['169.254.0.1'],
    ['100.64.0.1'],
    ['::1'],
    ['fe80::1'],
    ['fc00::1'],
  ])('%s → private_reserved', (ip) => {
    const r = classifyBanSafety(ip);
    expect(r.safe).toBe(false);
    expect(r.reason).toBe('private_reserved');
  });
});

describe('classifyBanSafety — infra ZeliAI (mai bannare)', () => {
  it('self server 78.46.219.172 → infrastructure', () => {
    expect(classifyBanSafety('78.46.219.172').reason).toBe('infrastructure');
  });
  it('NHA proxy 91.98.131.3 → infrastructure', () => {
    expect(classifyBanSafety('91.98.131.3').reason).toBe('infrastructure');
  });
  it('vicino di self (78.46.219.173) → bannabile (/32 non over-blocca)', () => {
    expect(isBanSafe('78.46.219.173')).toBe(true);
  });
  it('ZELI_INFRA_CIDRS sono tutti /32 (no over-block accidentale)', () => {
    for (const c of ZELI_INFRA_CIDRS) {
      expect(c.endsWith('/32') || c.endsWith('/128')).toBe(true);
    }
  });
});

describe('classifyBanSafety — fail-safe su input sporco', () => {
  it.each([['not-an-ip'], [''], ['999.999.999.999'], ['1.2.3'], ['::ggg'], ['  ']])(
    '%j → unparseable (NON bannabile)',
    (raw) => {
      const r = classifyBanSafety(raw);
      expect(r.safe).toBe(false);
      expect(r.reason).toBe('unparseable');
    },
  );
});

describe('classifyBanSafety — normalizzazione', () => {
  it('CF IPv4 con port suffix → riconosciuto cloudflare', () => {
    expect(classifyBanSafety('104.16.5.5:54321').reason).toBe('cloudflare');
  });
  it('CF IPv6 bracketed con porta → riconosciuto cloudflare', () => {
    expect(classifyBanSafety('[2606:4700::1]:443').reason).toBe('cloudflare');
  });
  it('IPv4-mapped IPv6 di IP privato → private_reserved', () => {
    expect(classifyBanSafety('::ffff:10.0.0.1').reason).toBe('private_reserved');
  });
  it('whitespace attorno → trimmato', () => {
    expect(classifyBanSafety('  8.8.8.8  ').safe).toBe(true);
  });
});

describe('classifyBanSafety — veri positivi (scanner reali bannabili)', () => {
  it.each([['45.137.21.9'], ['185.220.101.1'], ['193.142.146.35'], ['8.8.8.8']])(
    '%s → bannabile (client esterno reale)',
    (ip) => {
      const r = classifyBanSafety(ip);
      expect(r.safe).toBe(true);
      expect(r.reason).toBeNull();
    },
  );
});

describe('classifyBanSafety — extra protected CIDRs (param)', () => {
  it('IP dentro extra CIDR → infrastructure', () => {
    const r = classifyBanSafety('203.0.113.50', ['203.0.113.0/24']);
    // 203.0.113.0/24 è TEST-NET-3 → già private_reserved, vince quello.
    expect(r.safe).toBe(false);
  });
  it('IP pubblico dentro extra CIDR custom → infrastructure', () => {
    const r = classifyBanSafety('45.137.21.9', ['45.137.21.0/24']);
    expect(r.safe).toBe(false);
    expect(r.reason).toBe('infrastructure');
  });
  it('IP pubblico FUORI da extra CIDR → resta bannabile', () => {
    expect(isBanSafe('45.137.99.9', ['45.137.21.0/24'])).toBe(true);
  });
  it('extra CIDR vuoto/non valido → ignorato graceful', () => {
    expect(isBanSafe('8.8.8.8', ['', 'garbage', '///'])).toBe(true);
  });
});

describe('liste Cloudflare — integrità', () => {
  it('CLOUDFLARE_V4 e V6 sono freezate e non vuote', () => {
    expect(Object.isFrozen(CLOUDFLARE_V4)).toBe(true);
    expect(Object.isFrozen(CLOUDFLARE_V6)).toBe(true);
    expect(CLOUDFLARE_V4.length).toBeGreaterThanOrEqual(15);
    expect(CLOUDFLARE_V6.length).toBeGreaterThanOrEqual(7);
  });
  it('tutti i CIDR CF parsano correttamente', () => {
    for (const c of [...CLOUDFLARE_V4, ...CLOUDFLARE_V6]) {
      expect(cidrToRange(c), `${c} deve parsare`).not.toBeNull();
    }
  });
});
