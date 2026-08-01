/**
 * Test — lib/connect-host-guard (SSRF guard per connessioni mail/non-HTTP).
 *
 * Bug-bounty: host interni/privati/loopback/IMDS → throw; pubblici → ok;
 * host in allowlist operatore → ammesso (on-prem); host vuoto → throw.
 * Mutation: ogni ramo (allowlist / validateUrlForFetch / empty) verificato.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// L'allowlist host-interni (gestita dall'operatore) è mockata: il set decide
// quali host sono "fidati". Default vuoto → fail-closed.
const allowlistMock = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('./egress-policy.js', () => ({
  resolveOutboundDispatcher: (host: string) => ({ allowlisted: allowlistMock.allowed.has(host) }),
}));

import { assertConnectHostAllowed } from './connect-host-guard.js';

beforeEach(() => { allowlistMock.allowed.clear(); });

describe('assertConnectHostAllowed — SSRF su host di connessione', () => {
  it.each([
    '172.20.0.1',          // flowforge-net gateway
    '127.0.0.1',           // loopback
    'localhost',           // reserved
    '10.0.0.5',            // RFC1918
    '192.168.1.1',         // RFC1918
    '169.254.169.254',     // cloud IMDS
    '[::1]',               // IPv6 loopback
  ])('🔴 host interno "%s" → throw (no allowlist)', (host) => {
    expect(() => assertConnectHostAllowed(host)).toThrow();
  });

  it.each(['smtp.gmail.com', 'smtps.aruba.it', 'imaps.pec.aruba.it', '8.8.8.8'])(
    '🟢 host pubblico "%s" → ok', (host) => {
      expect(() => assertConnectHostAllowed(host)).not.toThrow();
    },
  );

  it('🟢 host interno MA in allowlist operatore → ammesso (on-prem legittimo)', () => {
    allowlistMock.allowed.add('mail.intranet.local');
    expect(() => assertConnectHostAllowed('mail.intranet.local')).not.toThrow();
  });

  it('🔴 host interno NON in allowlist → throw anche se un altro host è allowlisted', () => {
    allowlistMock.allowed.add('mail.intranet.local');
    expect(() => assertConnectHostAllowed('172.20.0.1')).toThrow();
  });

  it('🔴 host vuoto → throw (no target valido)', () => {
    expect(() => assertConnectHostAllowed('')).toThrow(/host mancante/);
  });

  it('il messaggio cita il label per diagnosi', () => {
    expect(() => assertConnectHostAllowed('10.0.0.1', 'SMTP')).toThrow(/SMTP/);
  });
});
