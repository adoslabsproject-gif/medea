/**
 * Tests per mask-pii.ts — GDPR-compliant logging utility.
 *
 * Standard di qualità: copre TUTTE le branche (typeof check, length edge,
 * domain con/senza TLD, IPv4/IPv6, input malformati). Target: 100% coverage.
 */

import { describe, it, expect } from 'vitest';
import { maskEmail, maskIp } from '../mask-pii.js';

describe('maskEmail', () => {
  describe('happy path', () => {
    it('maschera email standard preservando primo+ultimo char di local e domain', () => {
      expect(maskEmail('mario.rossi@gmail.com')).toBe('m*********i@g***l.com');
    });

    it('maschera email lunga con punto nel local part', () => {
      expect(maskEmail('mario.rossi@example.com')).toBe('m*********i@e*****e.com');
    });

    it('preserva il TLD anche con sub-domain', () => {
      // domain base = 'mail.example.co' (15 char) → m + 13 asterischi + o
      expect(maskEmail('john@mail.example.co.uk')).toBe('j**n@m*************o.uk');
    });

    it('maschera email con + (sub-addressing)', () => {
      // domain base = 'protonmail' (10 char) → p + 8 asterischi + l
      expect(maskEmail('info+newsletter@protonmail.com')).toBe('i*************r@p********l.com');
    });
  });

  describe('edge cases — local part corto', () => {
    it('local part di 1 char → singolo asterisco', () => {
      expect(maskEmail('a@gmail.com')).toBe('*@g***l.com');
    });

    it('local part di 2 char → primo + asterisco', () => {
      expect(maskEmail('ab@gmail.com')).toBe('a*@g***l.com');
    });

    it('local part di 3 char → primo + asterisco + ultimo', () => {
      expect(maskEmail('abc@gmail.com')).toBe('a*c@g***l.com');
    });
  });

  describe('edge cases — domain corto', () => {
    it('domain di 1 char senza TLD', () => {
      expect(maskEmail('user@x')).toBe('u**r@*');
    });

    it('domain di 2 char senza TLD', () => {
      expect(maskEmail('user@ab')).toBe('u**r@a*');
    });

    it('domain di 1 char con TLD (a@b.it)', () => {
      expect(maskEmail('a@b.it')).toBe('*@*.it');
    });
  });

  describe('input invalidi → [redacted]', () => {
    it('stringa vuota', () => {
      expect(maskEmail('')).toBe('[redacted]');
    });

    it('non-stringa: undefined', () => {
      expect(maskEmail(undefined)).toBe('[redacted]');
    });

    it('non-stringa: null', () => {
      expect(maskEmail(null)).toBe('[redacted]');
    });

    it('non-stringa: numero', () => {
      expect(maskEmail(42)).toBe('[redacted]');
    });

    it('non-stringa: oggetto', () => {
      expect(maskEmail({ email: 'x@y.it' })).toBe('[redacted]');
    });

    it('senza @ → [redacted]', () => {
      expect(maskEmail('not-an-email')).toBe('[redacted]');
    });

    it("@ all'inizio → [redacted]", () => {
      expect(maskEmail('@gmail.com')).toBe('[redacted]');
    });

    it('@ alla fine → [redacted]', () => {
      expect(maskEmail('user@')).toBe('[redacted]');
    });
  });

  describe('GDPR property — non leak informazione', () => {
    it('email diverse con stesso prefisso → output diversi', () => {
      const a = maskEmail('mario.rossi@gmail.com');
      const b = maskEmail('mario.bianchi@gmail.com');
      expect(a).not.toBe(b);
    });

    it('output non deve mai contenere la stringa originale completa', () => {
      const original = 'sensitive@example.com';
      const masked = maskEmail(original);
      expect(masked).not.toContain(original);
    });

    it('local part > 4 char NON deve essere ricostruibile dai char visibili', () => {
      // mario.rossi (11 char) → m + 9 asterischi + i. Solo m...i visibile.
      const masked = maskEmail('mario.rossi@gmail.com');
      const localPart = masked.split('@')[0]!;
      // Solo primo e ultimo char dell'originale leak (m, i)
      expect(localPart.replace(/\*/g, '')).toBe('mi');
    });
  });

  describe('idempotency — mai crash', () => {
    it('non lancia eccezioni su input strani', () => {
      expect(() => maskEmail('@@@@@')).not.toThrow();
      expect(() => maskEmail('user@@gmail.com')).not.toThrow();
      expect(() => maskEmail('.@.')).not.toThrow();
      expect(() => maskEmail('x'.repeat(10_000) + '@y.it')).not.toThrow();
    });

    it('mantiene determinismo (stessa input → stesso output)', () => {
      const email = 'user@example.com';
      expect(maskEmail(email)).toBe(maskEmail(email));
    });
  });
});

describe('maskIp', () => {
  describe('IPv4 — happy path', () => {
    it('IP standard → /24', () => {
      expect(maskIp('192.168.1.42')).toBe('192.168.1.0/24');
    });

    it('IP pubblico → /24', () => {
      expect(maskIp('95.230.116.76')).toBe('95.230.116.0/24');
    });

    it('IP 0.0.0.0 → 0.0.0.0/24', () => {
      expect(maskIp('0.0.0.0')).toBe('0.0.0.0/24');
    });

    it('IP con valore massimo (255) → preservato nei /24', () => {
      expect(maskIp('255.255.255.255')).toBe('255.255.255.0/24');
    });

    it('IP con 4° octet già 0 → idempotente', () => {
      expect(maskIp('10.0.0.0')).toBe('10.0.0.0/24');
    });
  });

  describe('IPv4 — validazione', () => {
    it('octet > 255 → [redacted]', () => {
      expect(maskIp('192.168.1.999')).toBe('[redacted]');
      expect(maskIp('256.0.0.0')).toBe('[redacted]');
    });

    it('octet non-numerico → [redacted]', () => {
      expect(maskIp('192.168.1.abc')).toBe('[redacted]');
    });

    it('3 octet (malformato) → [redacted]', () => {
      expect(maskIp('192.168.1')).toBe('[redacted]');
    });

    it('5 octet (malformato) → [redacted]', () => {
      expect(maskIp('192.168.1.1.1')).toBe('[redacted]');
    });
  });

  describe('IPv6 — happy path con abbreviazione ::', () => {
    it('IPv6 abbreviato 2 hextet → /48 normalizzato', () => {
      // 2a01:4f8::ab → espanso → 2a01:4f8:0:0:0:0:0:ab → primi 3 → 2a01:4f8:0::/48
      expect(maskIp('2a01:4f8::ab')).toBe('2a01:4f8:0::/48');
    });

    it('IPv6 full senza ::', () => {
      expect(maskIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe('2001:0db8:85a3::/48');
    });

    it('IPv6 localhost ::1 → primi 3 segment zero', () => {
      expect(maskIp('::1')).toBe('0:0:0::/48');
    });

    it('IPv6 :: completo (unspecified address)', () => {
      expect(maskIp('::')).toBe('[redacted]'); // no segment validi
    });

    it('IPv6 con prefix dappertutto', () => {
      expect(maskIp('2001:db8:85a3::8a2e:370:7334')).toBe('2001:db8:85a3::/48');
    });

    it('IPv6 long form 8 hextet', () => {
      expect(maskIp('2a01:4f8:201:abcd:dead:beef:1234:5678')).toBe('2a01:4f8:201::/48');
    });
  });

  describe('IPv6 — validazione', () => {
    it('hextet > 4 char → [redacted]', () => {
      expect(maskIp('2a01:4f8123::ab')).toBe('[redacted]');
    });

    it('hextet con char non-hex → [redacted]', () => {
      expect(maskIp('2a01:zzzz::ab')).toBe('[redacted]');
    });

    it('più di una `::` (invalid per RFC 5952) → [redacted]', () => {
      expect(maskIp('2a01::4f8::ab')).toBe('[redacted]');
    });
  });

  describe('input invalidi → [redacted]', () => {
    it('stringa vuota', () => {
      expect(maskIp('')).toBe('[redacted]');
    });

    it('non-stringa: undefined', () => {
      expect(maskIp(undefined)).toBe('[redacted]');
    });

    it('non-stringa: null', () => {
      expect(maskIp(null)).toBe('[redacted]');
    });

    it('non-stringa: numero', () => {
      expect(maskIp(192)).toBe('[redacted]');
    });

    it('garbage string', () => {
      expect(maskIp('not-an-ip')).toBe('[redacted]');
    });
  });

  describe('GDPR property — host part azzerato (security invariant)', () => {
    it('IPv4: 4° ottetto è SEMPRE 0', () => {
      const masked = maskIp('203.0.113.42');
      expect(masked.split('.').pop()).toBe('0/24');
    });

    it('IPv4: primi 3 ottetti preservati per geo/abuse tracking', () => {
      const masked = maskIp('203.0.113.42');
      expect(masked.startsWith('203.0.113.')).toBe(true);
    });

    it('IPv6: dal 4° hextet in poi SEMPRE compresso a 0 via ::', () => {
      const masked = maskIp('2a01:4f8:201:abcd:dead:beef:1234:5678');
      // Output NON deve contenere alcun byte dei segmenti 4-8 originali
      expect(masked).not.toContain('abcd');
      expect(masked).not.toContain('dead');
      expect(masked).not.toContain('beef');
      expect(masked).not.toContain('1234');
      expect(masked).not.toContain('5678');
      expect(masked).toBe('2a01:4f8:201::/48');
    });

    it('IPv6: localhost NON deve essere identificabile (anti-localhost-leak)', () => {
      const masked = maskIp('::1');
      // Il segment "1" originale NON deve apparire nell'output
      // (era il bug della versione precedente — `::1` → `::1:0/48` = leak)
      const beforeSlash = masked.split('/')[0]!;
      const hextets = beforeSlash.replace(/::/g, ':').split(':').filter(Boolean);
      expect(hextets.includes('1')).toBe(false);
    });
  });

  describe('idempotency — mai crash', () => {
    it('non lancia eccezioni su input weird', () => {
      expect(() => maskIp(':')).not.toThrow();
      expect(() => maskIp('....')).not.toThrow();
      expect(() => maskIp('1.2.3.4.5.6.7.8')).not.toThrow();
      expect(() => maskIp(':::')).not.toThrow();
    });
  });
});
