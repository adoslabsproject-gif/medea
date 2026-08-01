/**
 * Tests per ip-utils.ts — IPv4 + IPv6 CIDR matching con BigInt.
 *
 * Coverage target: 100%. Copre TUTTE le branche di parsing + edge case
 * security-critical (leading zeros = octal injection, IPv4-mapped IPv6,
 * triple-colon, gruppi > 0xffff, port suffix con/senza bracket).
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeIp,
  ipv4ToNumber,
  ipv6ToNumber,
  ipToNumber,
  cidrToRange,
  isIpInCidr,
  isIpInRanges,
  precomputeRanges,
  isPrivateOrReserved,
} from '../ip-utils.js';

describe('normalizeIp', () => {
  it('trim whitespace', () => {
    expect(normalizeIp('  1.2.3.4  ')).toBe('1.2.3.4');
  });

  it('strip port da IPv4', () => {
    expect(normalizeIp('1.2.3.4:8080')).toBe('1.2.3.4');
  });

  it('strip port da IPv6 bracketed', () => {
    expect(normalizeIp('[::1]:8080')).toBe('::1');
  });

  it('IPv6 senza bracket non viene stripp-ato (port ambiguo con ultimo gruppo)', () => {
    expect(normalizeIp('2001:db8::1:443')).toBe('2001:db8::1:443');
  });

  it('lowercase IPv6', () => {
    expect(normalizeIp('2001:DB8::1')).toBe('2001:db8::1');
  });

  it('IPv4-mapped IPv6 → IPv4 puro', () => {
    expect(normalizeIp('::ffff:66.249.66.1')).toBe('66.249.66.1');
  });

  it('IPv4-mapped in hex resta IPv6', () => {
    expect(normalizeIp('::ffff:c0a8:101')).toBe('::ffff:c0a8:101');
  });

  it('bracket senza chiusura: lascia stringa intatta dal "["', () => {
    expect(normalizeIp('[unfinished')).toBe('[unfinished');
  });

  it('IPv4 senza port preservato', () => {
    expect(normalizeIp('1.2.3.4')).toBe('1.2.3.4');
  });
});

describe('ipv4ToNumber', () => {
  it('IP standard parsed correttamente', () => {
    expect(ipv4ToNumber('1.2.3.4')).toBe(BigInt(0x01020304));
  });

  it('IP 0.0.0.0 → 0n', () => {
    expect(ipv4ToNumber('0.0.0.0')).toBe(BigInt(0));
  });

  it('IP 255.255.255.255 → max 32-bit', () => {
    expect(ipv4ToNumber('255.255.255.255')).toBe(BigInt(0xffffffff));
  });

  describe('reject malformed', () => {
    it.each([
      ['1.2.3', '3 octet'],
      ['1.2.3.4.5', '5 octet'],
      ['1..3.4', 'empty octet'],
      ['1.2.3.abc', 'octet non-numerico'],
      ['1.2.3.256', 'octet > 255'],
      ['1.2.3.-1', 'octet negativo (regex fails)'],
      ['1.2.3.0a', 'octet con suffisso non-numerico'],
    ])('rejects %s (%s)', (input) => {
      expect(ipv4ToNumber(input)).toBeNull();
    });

    it('rejects leading zeros (octal injection prevention)', () => {
      // 010.1.1.1 in octal sarebbe 8.1.1.1 → potential bypass
      expect(ipv4ToNumber('010.1.1.1')).toBeNull();
      expect(ipv4ToNumber('1.2.3.04')).toBeNull();
    });

    it('accept single 0', () => {
      expect(ipv4ToNumber('0.0.0.0')).toBe(BigInt(0));
    });
  });
});

describe('ipv6ToNumber', () => {
  it('full notation', () => {
    expect(ipv6ToNumber('2001:0db8:0000:0000:0000:0000:0000:0001')).not.toBeNull();
  });

  it('compressed ::1 → loopback', () => {
    expect(ipv6ToNumber('::1')).toBe(BigInt(1));
  });

  it(':: (unspecified all-zero)', () => {
    expect(ipv6ToNumber('::')).toBe(BigInt(0));
  });

  it('compression mid-address', () => {
    expect(ipv6ToNumber('2001:db8::1')).not.toBeNull();
  });

  it('IPv4-mapped in IPv6 ::ffff:1.2.3.4', () => {
    const result = ipv6ToNumber('::ffff:1.2.3.4');
    expect(result).not.toBeNull();
    // Equivalent to ::ffff:0102:0304
    expect(result).toBe(ipv6ToNumber('::ffff:0102:0304'));
  });

  describe('reject malformed (security: spoof prevention)', () => {
    it.each([
      ['invalid', 'no colon'],
      ['2001:db8:::1', 'triple colon'],
      ['2001::db8::1', 'two :: blocks'],
      ['2001:db8:1:2:3:4:5:6:7', 'too many groups'],
      ['2001:db8:1:2:3:4:5', 'too few groups no ::'],
      ['gggg::1', 'invalid hex char'],
      ['12345::1', 'group > 4 hex chars'],
      ['2001:db8::1.2.3', 'invalid IPv4 suffix'],
    ])('rejects %s (%s)', (input) => {
      expect(ipv6ToNumber(input)).toBeNull();
    });

    it('rejects IPv4-mapped with invalid IPv4', () => {
      expect(ipv6ToNumber('::ffff:256.1.1.1')).toBeNull();
    });
  });

  it('uppercase normalized', () => {
    const lower = ipv6ToNumber('2001:db8::1');
    const upper = ipv6ToNumber('2001:DB8::1');
    expect(lower).toBe(upper);
  });
});

describe('ipToNumber', () => {
  it('routes IPv4', () => {
    expect(ipToNumber('1.2.3.4')).toBe(BigInt(0x01020304));
  });

  it('routes IPv6', () => {
    expect(ipToNumber('::1')).toBe(BigInt(1));
  });

  it('null on garbage', () => {
    expect(ipToNumber('nope')).toBeNull();
  });
});

describe('cidrToRange', () => {
  describe('IPv4', () => {
    it('/24 → 256 IP range', () => {
      const r = cidrToRange('192.168.1.0/24');
      expect(r).not.toBeNull();
      expect(r!.isV6).toBe(false);
      expect(r!.end - r!.start).toBe(BigInt(255));
    });

    it('/32 → single host', () => {
      const r = cidrToRange('1.2.3.4/32');
      expect(r!.start).toBe(r!.end);
    });

    it('/0 → all IPv4 space', () => {
      const r = cidrToRange('0.0.0.0/0');
      expect(r!.start).toBe(BigInt(0));
      expect(r!.end).toBe(BigInt(0xffffffff));
    });
  });

  describe('IPv6', () => {
    it('/48 → 80-bit range', () => {
      const r = cidrToRange('2001:db8::/48');
      expect(r!.isV6).toBe(true);
      expect(r!.end - r!.start).toBe((BigInt(1) << BigInt(80)) - BigInt(1));
    });

    it('/128 → single host', () => {
      const r = cidrToRange('::1/128');
      expect(r!.start).toBe(r!.end);
    });
  });

  describe('reject malformed', () => {
    it.each([
      ['no-slash', 'no slash'],
      ['/24', 'no IP'],
      ['1.2.3.4/', 'no prefix'],
      ['1.2.3.4/abc', 'non-numeric prefix'],
      ['1.2.3.4/33', 'prefix > 32 for IPv4'],
      ['1.2.3.4/-1', 'negative prefix'],
      ['::1/129', 'prefix > 128 for IPv6'],
      ['notip/24', 'invalid IP'],
    ])('rejects %s (%s)', (input) => {
      expect(cidrToRange(input)).toBeNull();
    });
  });
});

describe('isIpInCidr', () => {
  it('IPv4 match', () => {
    expect(isIpInCidr('192.168.1.42', '192.168.1.0/24')).toBe(true);
  });

  it('IPv4 no-match', () => {
    expect(isIpInCidr('10.0.0.1', '192.168.1.0/24')).toBe(false);
  });

  it('IPv6 match', () => {
    expect(isIpInCidr('2001:db8::1', '2001:db8::/32')).toBe(true);
  });

  it('IPv6 no-match', () => {
    expect(isIpInCidr('2001:db8::1', '2001:dead::/32')).toBe(false);
  });

  it('IPv4 contro CIDR IPv6 → false (mai cross-family match)', () => {
    expect(isIpInCidr('1.2.3.4', '::/0')).toBe(false);
  });

  it('IPv6 contro CIDR IPv4 → false', () => {
    expect(isIpInCidr('::1', '0.0.0.0/0')).toBe(false);
  });

  it('garbage IP → false (mai crash)', () => {
    expect(isIpInCidr('nope', '1.2.3.0/24')).toBe(false);
  });

  it('garbage CIDR → false', () => {
    expect(isIpInCidr('1.2.3.4', 'garbage')).toBe(false);
  });
});

describe('precomputeRanges', () => {
  it('split V4 / V6 separately', () => {
    const out = precomputeRanges(['1.2.3.0/24', '2001:db8::/32', '10.0.0.0/8']);
    expect(out.rangesV4).toHaveLength(2);
    expect(out.rangesV6).toHaveLength(1);
  });

  it('CIDR invalidi vengono filtrati (no crash)', () => {
    const out = precomputeRanges(['1.2.3.0/24', 'garbage', '::/0']);
    expect(out.rangesV4.length + out.rangesV6.length).toBe(2);
  });

  it('empty input → array vuoti', () => {
    const out = precomputeRanges([]);
    expect(out.rangesV4).toHaveLength(0);
    expect(out.rangesV6).toHaveLength(0);
  });
});

describe('isIpInRanges', () => {
  it('match IPv4', () => {
    const out = precomputeRanges(['192.168.1.0/24', '10.0.0.0/8']);
    expect(isIpInRanges('192.168.1.42', out.rangesV4)).toBe(true);
    expect(isIpInRanges('10.5.5.5', out.rangesV4)).toBe(true);
    expect(isIpInRanges('8.8.8.8', out.rangesV4)).toBe(false);
  });

  it('match IPv6', () => {
    const out = precomputeRanges(['2001:db8::/32']);
    expect(isIpInRanges('2001:db8::1', out.rangesV6)).toBe(true);
    expect(isIpInRanges('2001:dead::1', out.rangesV6)).toBe(false);
  });

  it('garbage IP → false (no crash)', () => {
    const out = precomputeRanges(['1.0.0.0/8']);
    expect(isIpInRanges('not-an-ip', out.rangesV4)).toBe(false);
  });
});

describe('isPrivateOrReserved', () => {
  it.each([
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '100.64.0.0/10',
    '0.0.0.0/8',
    '224.0.0.0/4',
    '192.0.2.0/24',
    '203.0.113.0/24',
  ])('detect IPv4 private/reserved: %s', (cidr) => {
    expect(isPrivateOrReserved(cidr)).toBe(true);
  });

  it.each(['fc00::/7', 'fe80::/10', '::1/128', 'ff00::/8', '2001:db8::/32'])(
    'detect IPv6 private/reserved: %s',
    (cidr) => {
      expect(isPrivateOrReserved(cidr)).toBe(true);
    },
  );

  it.each(['8.8.8.0/24', '1.1.1.0/24', '95.230.116.0/24', '2606:4700::/32'])(
    'public CIDR NOT private: %s',
    (cidr) => {
      expect(isPrivateOrReserved(cidr)).toBe(false);
    },
  );

  it('CIDR invalid → false (mai crash)', () => {
    expect(isPrivateOrReserved('garbage')).toBe(false);
  });

  it('CIDR che contiene completamente un private range → true', () => {
    // 0.0.0.0/0 contiene tutti i range privati
    expect(isPrivateOrReserved('0.0.0.0/0')).toBe(true);
  });
});
