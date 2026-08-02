/**
 * Test internal-host-allowlist — security primitive. Bug-bounty: match ESATTO,
 * 🚨 anti-bypass (substring/suffix non dot-bounded NON matcha), wildcard esplicita,
 * case/trailing-dot, env vuota = feature off.
 */
import { describe, it, expect } from 'vitest';
import {
  parseInternalHostAllowlist,
  isHostAllowlisted,
  internalGatewayTrustedHost,
} from './internal-host-allowlist.js';

describe('parseInternalHostAllowlist', () => {
  it('CSV → Set normalizzato (lowercase, trim, no vuoti)', () => {
    const s = parseInternalHostAllowlist(' ERP.Internal , 192.168.1.50 ,, ');
    expect([...s].sort()).toEqual(['192.168.1.50', 'erp.internal']);
  });
  it('vuota/undefined/null → Set vuoto (feature OFF)', () => {
    expect(parseInternalHostAllowlist(undefined).size).toBe(0);
    expect(parseInternalHostAllowlist(null).size).toBe(0);
    expect(parseInternalHostAllowlist('').size).toBe(0);
    expect(parseInternalHostAllowlist('   ').size).toBe(0);
  });
});

describe('isHostAllowlisted', () => {
  const al = parseInternalHostAllowlist('erp.internal, 10.0.0.5, *.svc.cluster.local');

  it('allowlist vuota → SEMPRE false (feature off, #201 preservato)', () => {
    expect(isHostAllowlisted('erp.internal', new Set())).toBe(false);
  });

  it('match esatto (case-insensitive, trailing-dot tollerato)', () => {
    expect(isHostAllowlisted('erp.internal', al)).toBe(true);
    expect(isHostAllowlisted('ERP.INTERNAL', al)).toBe(true);
    expect(isHostAllowlisted('erp.internal.', al)).toBe(true);
    expect(isHostAllowlisted('10.0.0.5', al)).toBe(true);
  });

  it('🚨 ANTI-BYPASS: substring/suffix non dot-bounded NON matcha', () => {
    expect(isHostAllowlisted('evil-erp.internal', al)).toBe(false);
    expect(isHostAllowlisted('erp.internal.attacker.com', al)).toBe(false);
    expect(isHostAllowlisted('xerp.internal', al)).toBe(false);
    expect(isHostAllowlisted('10.0.0.50', al)).toBe(false); // non è 10.0.0.5
  });

  it('🚨 wildcard esplicita *.suffix → matcha SOLO sotto-domini dot-bounded', () => {
    expect(isHostAllowlisted('a.svc.cluster.local', al)).toBe(true);
    expect(isHostAllowlisted('a.b.svc.cluster.local', al)).toBe(true);
    expect(isHostAllowlisted('svc.cluster.local', al)).toBe(false); // il suffisso stesso NO
    expect(isHostAllowlisted('.svc.cluster.local', al)).toBe(false); // h === suffisso col dot → NO (guard length)
    expect(isHostAllowlisted('evilsvc.cluster.local', al)).toBe(false); // non dot-bounded
    expect(isHostAllowlisted('a.svc.cluster.local.evil.com', al)).toBe(false);
  });

  it('host vuoto → false', () => {
    expect(isHostAllowlisted('', al)).toBe(false);
    expect(isHostAllowlisted('   ', al)).toBe(false);
  });
});

// Fase 2 (#14): SSOT dell'esenzione origin-based (nata in nodes-ai-agents,
// fix SSRF nLA_liara; qui perché serve anche ai nodi stdlib). La suite
// completa vive nei consumer (ai-agents index.test.ts) — qui il contratto base.
describe('internalGatewayTrustedHost', () => {
  const GW = 'http://172.20.0.1:3006/api/v1/llm';
  it('stesso origin del gateway (path qualsiasi) → host:porta esente', () => {
    expect(
      internalGatewayTrustedHost('http://172.20.0.1:3006/api/v1/llm/chat/completions', GW),
    ).toBe('172.20.0.1:3006');
  });
  it('🚨 origin DIVERSO (BYOK utente / porta diversa) → undefined (guard pieno)', () => {
    expect(
      internalGatewayTrustedHost('https://api.openai.com/v1/chat/completions', GW),
    ).toBeUndefined();
    expect(internalGatewayTrustedHost('http://172.20.0.1:9999/x', GW)).toBeUndefined();
  });
  it('gateway assente o URL malformata → undefined', () => {
    expect(internalGatewayTrustedHost('http://x/y', undefined)).toBeUndefined();
    expect(internalGatewayTrustedHost('non-un-url', GW)).toBeUndefined();
  });
});
