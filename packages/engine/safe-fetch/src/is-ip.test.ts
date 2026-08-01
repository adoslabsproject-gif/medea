/**
 * Tests `isIP` isomorphic — equivalenza semantica con `node:net#isIP`.
 *
 * Coverage:
 *  • IPv4 valido / invalido / leading zero / out of range
 *  • IPv6 valido / compresso `::` / multipli `::` / IPv4-mapped
 *  • Edge cases: stringa vuota, hostname testuale, "::"
 */
import { describe, it, expect } from 'vitest';
import { isIP } from './is-ip.js';

describe('isIP — IPv4', () => {
  it.each([
    '127.0.0.1',
    '0.0.0.0',
    '255.255.255.255',
    '192.168.1.1',
    '10.0.0.1',
    '169.254.169.254',
    '8.8.8.8',
  ])('OK %s', (s) => {
    expect(isIP(s)).toBe(4);
  });

  it.each([
    '256.0.0.1',          // out of range
    '127.0.0',            // 3 octets
    '127.0.0.1.5',        // 5 octets
    '01.2.3.4',           // leading zero (Node rifiuta)
    '127.0.0.a',          // non-numeric
    '127.0.0.',           // trailing dot
    '.127.0.0.1',         // leading dot
    '127..0.1',           // empty octet
  ])('KO %s', (s) => {
    expect(isIP(s)).toBe(0);
  });
});

describe('isIP — IPv6', () => {
  it.each([
    '::1',                // loopback
    '::',                 // all zero
    'fe80::1',
    '2001:db8::1',
    '2001:0db8:0000:0000:0000:0000:0000:0001',  // full form
    '2001:db8:0:0:0:0:0:1',
    'fc00::1',
    '::ffff:127.0.0.1',   // IPv4-mapped IPv6
    '::ffff:1.2.3.4',
    '2001:db8::1:2:3:4:5',
  ])('OK %s', (s) => {
    expect(isIP(s)).toBe(6);
  });

  it.each([
    ':::',                // 3 colons
    '::1::2',             // doppio ::
    '1:2:3:4:5:6:7',      // 7 gruppi senza ::
    '1:2:3:4:5:6:7:8:9',  // 9 gruppi
    'gggg::1',            // hex invalido
    '1::1::1',            // due ::
    '2001:db8::1::',      // due ::
    '12345::1',           // gruppo > 4 char
  ])('KO %s', (s) => {
    expect(isIP(s)).toBe(0);
  });
});

describe('isIP — non-IP', () => {
  it.each(['', 'example.com', 'localhost', 'not.an.ip.at.all', '127.0.0.1.example.com'])(
    'KO %s',
    (s) => {
      expect(isIP(s)).toBe(0);
    },
  );
});
