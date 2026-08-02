/**
 * Test bug-bounty — host-allowlist (guard anti-esfiltrazione credenziali).
 * Il valore del guard è rifiutare l'exfil verso host arbitrari: testo i VALIDI e tutti i
 * trucchi di bypass (suffix-confusion, lookalike, subdomain-suffix, IP, URL rotto, case, porta).
 */
import { describe, it, expect } from 'vitest';
import { assertHostAllowed, HostNotAllowedError } from './host-allowlist.js';

const ok = (url: string, allow: string[]) => assertHostAllowed(url, allow);
const blocked = (url: string, allow: string[]) =>
  expect(() => assertHostAllowed(url, allow), `doveva bloccare ${url}`).toThrow(
    HostNotAllowedError,
  );

describe('assertHostAllowed', () => {
  it('host esatto consentito', () => {
    expect(() => ok('https://api.calendly.com/scheduled_events', ['calendly.com'])).not.toThrow();
    expect(() => ok('https://calendly.com/x', ['calendly.com'])).not.toThrow();
  });

  it('sotto-dominio del suffisso consentito (*.suffix)', () => {
    expect(() =>
      ok('https://eu11.my.salesforce.com/services/data', ['salesforce.com', 'force.com']),
    ).not.toThrow();
    expect(() =>
      ok('https://mydomain.my.force.com/x', ['salesforce.com', 'force.com']),
    ).not.toThrow();
  });

  it('🚨 EXFIL: host attaccante arbitrario → bloccato', () => {
    blocked('https://attacker.com/x', ['calendly.com']);
    blocked('http://evil.example/services/oauth2/token', ['salesforce.com', 'force.com']);
  });

  it('🚨 BYPASS suffix-confusion: api.calendly.com.attacker.com → bloccato', () => {
    blocked('https://api.calendly.com.attacker.com/x', ['calendly.com']);
    blocked('https://my.salesforce.com.evil.net/token', ['salesforce.com']);
  });

  it('🚨 BYPASS lookalike senza dot: evilcalendly.com / xsalesforce.com → bloccato', () => {
    blocked('https://evilcalendly.com/x', ['calendly.com']);
    blocked('https://xsalesforce.com/token', ['salesforce.com']);
  });

  it('🚨 IP diretto (anche pubblico) non è il dominio provider → bloccato', () => {
    blocked('https://203.0.113.5/x', ['calendly.com']);
    blocked('http://169.254.169.254/latest/meta-data', ['salesforce.com']);
  });

  it('🚨 URL non valido → bloccato (fail-closed)', () => {
    blocked('not-a-url', ['calendly.com']);
    blocked('', ['calendly.com']);
    blocked('javascript:alert(1)', ['calendly.com']);
  });

  it('case-insensitive + porta non aggira il match', () => {
    expect(() => ok('https://API.Calendly.COM/x', ['calendly.com'])).not.toThrow();
    expect(() => ok('https://api.calendly.com:443/x', ['calendly.com'])).not.toThrow();
    blocked('https://API.ATTACKER.COM/x', ['calendly.com']);
  });

  it('errore espone host atteso (debug) ma è una HostNotAllowedError tipizzata', () => {
    try {
      assertHostAllowed('https://attacker.com', ['calendly.com']);
      throw new Error('doveva lanciare');
    } catch (e) {
      expect(e).toBeInstanceOf(HostNotAllowedError);
      expect((e as HostNotAllowedError).host).toBe('attacker.com');
      expect((e as HostNotAllowedError).allowed).toEqual(['calendly.com']);
    }
  });
});
