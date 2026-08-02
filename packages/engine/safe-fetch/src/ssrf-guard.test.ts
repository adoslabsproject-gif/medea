/**
 * Tests SSRF guard — `@medea/engine-safe-fetch` shared (#202 P0-3 + N20 structural).
 *
 * Coverage:
 *   - scheme allowed (http, https) vs blocked (file:, javascript:, gopher:, data:)
 *   - IPv4 RFC1918 + loopback + link-local + reserved + CGN + multicast
 *   - IPv4 octal/hex obfuscation (0177.0.0.1, 0x7f.0.0.1)
 *   - IPv6 loopback (::1), link-local (fe80::), site-local (fc00::/7), ULA
 *   - IPv4-mapped IPv6 (::ffff:127.0.0.1)
 *   - reserved hostnames (localhost, IMDS endpoints)
 *   - Docker internal network suffix
 *   - assertUrlSafe throws SsrfBlockedError con reason corretto
 */

import { describe, it, expect } from 'vitest';
import { validateUrlForFetch, validateIpForFetch, assertUrlSafe, SsrfBlockedError, normalizeObfuscatedIPv4 } from './ssrf-guard.js';

describe('🚨 SSRF — IPv4 OFFUSCATI (decimale/hex/ottale) normalizzati e bloccati', () => {
  // Senza host-normalization, isIP ritorna 0 → isPrivateIPv4 mai chiamato → bypass del
  // blocco IP privati. Tutti questi sono 127.0.0.1 / IP privati in forme alternative.
  it.each([
    ['http://2130706433/', 'decimale 127.0.0.1'],
    ['http://0x7f000001/', 'hex 127.0.0.1'],
    ['http://0177.0.0.1/', 'ottale 127.0.0.1'],
    ['http://127.1/', '2-parti → 127.0.0.1'],
    ['http://0x7f.0.0.1/', 'hex misto'],
    ['http://3232235521/', 'decimale 192.168.0.1'],
    ['http://2852039166/', 'decimale 169.254.169.254 IMDS'],
  ])('blocca %s (%s)', (url) => {
    const r = validateUrlForFetch(url);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/BLOCKED_PRIVATE_IP|BLOCKED_LOOPBACK|BLOCKED_LINK_LOCAL|BLOCKED_RESERVED/);
  });

  it('anti-regressione: un IP PUBBLICO offuscato NON viene falsamente bloccato', () => {
    // 8.8.8.8 = 134744072 decimale → public → ok.
    expect(validateUrlForFetch('http://134744072/').ok).toBe(true);
  });

  it('normalizeObfuscatedIPv4: forme → dotted-decimal; hostname → null', () => {
    expect(normalizeObfuscatedIPv4('2130706433')).toBe('127.0.0.1');
    expect(normalizeObfuscatedIPv4('0x7f000001')).toBe('127.0.0.1');
    expect(normalizeObfuscatedIPv4('0177.0.0.1')).toBe('127.0.0.1');
    expect(normalizeObfuscatedIPv4('127.1')).toBe('127.0.0.1');
    expect(normalizeObfuscatedIPv4('192.168.1.1')).toBe('192.168.1.1');
    // NON è un IPv4 → null (resta un hostname).
    expect(normalizeObfuscatedIPv4('example.com')).toBeNull();
    expect(normalizeObfuscatedIPv4('a.b.c.d')).toBeNull();
    expect(normalizeObfuscatedIPv4('1.2.3.4.5')).toBeNull(); // 5 parti
    expect(normalizeObfuscatedIPv4('999.0.0.1')).toBeNull(); // ottetto non-finale > 255
  });
});

describe('validateUrlForFetch — scheme', () => {
  it('http allowed', () => expect(validateUrlForFetch('http://example.com').ok).toBe(true));
  it('https allowed', () => expect(validateUrlForFetch('https://example.com').ok).toBe(true));
  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'gopher://internal',
    'data:text/html,<h1>x</h1>',
    'ftp://internal',
  ])('blocks scheme: %s', (url) => {
    const r = validateUrlForFetch(url);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/BLOCKED_SCHEME|INVALID_URL/);
  });
});

describe('validateUrlForFetch — IPv4 RFC1918 + loopback + link-local', () => {
  it.each([
    ['http://10.0.0.1', 'BLOCKED_PRIVATE_IP'],
    ['http://172.16.0.1', 'BLOCKED_PRIVATE_IP'],
    ['http://172.31.255.255', 'BLOCKED_PRIVATE_IP'],
    ['http://192.168.1.1', 'BLOCKED_PRIVATE_IP'],
    ['http://127.0.0.1', 'BLOCKED_LOOPBACK'],
    ['http://127.255.255.255', 'BLOCKED_LOOPBACK'],
    ['http://169.254.169.254', 'BLOCKED_LINK_LOCAL'],   // AWS IMDS
    ['http://0.0.0.0', 'BLOCKED_RESERVED'],
    ['http://100.64.0.1', 'BLOCKED_PRIVATE_IP'],        // CGN RFC 6598 (shared address space — usato come privato)
    ['http://224.0.0.1', 'BLOCKED_RESERVED'],           // multicast
    ['http://240.0.0.1', 'BLOCKED_RESERVED'],           // reserved
  ])('blocks %s as %s', (url, reason) => {
    const r = validateUrlForFetch(url);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(reason);
  });

  it('allows public IPv4 (8.8.8.8 Google DNS)', () => {
    expect(validateUrlForFetch('http://8.8.8.8').ok).toBe(true);
  });
});

describe('validateUrlForFetch — IPv4 octal/hex obfuscation', () => {
  it('octal 0177.0.0.1 = 127.0.0.1 → bloccato', () => {
    const r = validateUrlForFetch('http://0177.0.0.1');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('BLOCKED_LOOPBACK');
  });

  it('hex 0x7f.0.0.1 = 127.0.0.1 → bloccato', () => {
    const r = validateUrlForFetch('http://0x7f.0.0.1');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('BLOCKED_LOOPBACK');
  });

  it('decimal 192.168.1.1 → bloccato', () => {
    const r = validateUrlForFetch('http://192.168.1.1');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('BLOCKED_PRIVATE_IP');
  });
});

describe('validateUrlForFetch — IPv6', () => {
  it('::1 loopback', () => {
    const r = validateUrlForFetch('http://[::1]');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('BLOCKED_LOOPBACK');
  });

  it('fe80:: link-local', () => {
    const r = validateUrlForFetch('http://[fe80::1]');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('BLOCKED_LINK_LOCAL');
  });

  it('fc00:: ULA private', () => {
    const r = validateUrlForFetch('http://[fc00::1]');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('BLOCKED_PRIVATE_IP');
  });

  it('fd00:: ULA private', () => {
    const r = validateUrlForFetch('http://[fd00::1]');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('BLOCKED_PRIVATE_IP');
  });

  it('IPv4-mapped IPv6 ::ffff:127.0.0.1 → bloccato (fail-secure)', () => {
    // WHATWG URL canonicalizza in `[::ffff:7f00:1]` (hex). Il guard è
    // fail-secure per qualsiasi `::ffff:` (perdiamo la granularità del
    // reason ma garantiamo che NON passi).
    const r = validateUrlForFetch('http://[::ffff:127.0.0.1]');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/BLOCKED_/);
  });

  it('IPv4-mapped IPv6 ::ffff:192.168.1.1 → bloccato (fail-secure)', () => {
    const r = validateUrlForFetch('http://[::ffff:192.168.1.1]');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/BLOCKED_/);
  });

  it('🚨🚨 NAT64 64:ff9b::a00:1 (=10.0.0.1) → bloccato (IPv4 privato embedded)', () => {
    // hex compatto (a00:1 = 10.0.0.1) e dotted: entrambi devono decodificare e bloccare.
    expect(validateIpForFetch('64:ff9b::a00:1').ok).toBe(false);
    expect(validateIpForFetch('64:ff9b::10.0.0.1').ok).toBe(false);
    const u = validateUrlForFetch('http://[64:ff9b::a00:1]');
    expect(u.ok).toBe(false);
    expect(u.reason).toMatch(/BLOCKED_/);
  });

  it('🚨 NAT64 verso IMDS/loopback → bloccato', () => {
    expect(validateIpForFetch('64:ff9b::7f00:1').ok).toBe(false);   // 127.0.0.1
    expect(validateIpForFetch('64:ff9b::a9fe:a9fe').ok).toBe(false); // 169.254.169.254
  });

  it('🚨 NAT64 verso IPv4 PUBBLICO (8.8.8.8) → consentito (non è un bypass)', () => {
    // 8.8.8.8 = 0808:0808 → embedding legittimo verso host pubblico.
    expect(validateIpForFetch('64:ff9b::808:808').ok).toBe(true);
  });

  it('🚨🚨 NAT64/mapped in forma ESPANSA (non `::`) → comunque bloccato (form-agnostic)', () => {
    // Il guard non deve dipendere dalla forma testuale: espande gli hextet e matcha /96.
    expect(validateIpForFetch('64:ff9b:0:0:0:0:a00:1').ok).toBe(false);       // NAT64 10.0.0.1 espanso
    expect(validateIpForFetch('64:ff9b:0:0:0:0:7f00:1').ok).toBe(false);      // NAT64 127.0.0.1 espanso
    expect(validateIpForFetch('0:0:0:0:0:ffff:7f00:1').ok).toBe(false);       // ::ffff:127.0.0.1 espanso
    expect(validateIpForFetch('64:ff9b:0:0:0:0:10.0.0.1').ok).toBe(false);    // NAT64 dotted espanso
  });

  it('🚨 NAT64 espanso verso IPv4 pubblico → consentito', () => {
    expect(validateIpForFetch('64:ff9b:0:0:0:0:808:808').ok).toBe(true);
  });
});

describe('validateUrlForFetch — reserved hostnames', () => {
  it.each([
    'http://localhost',
    'http://evil.localhost',
    'http://metadata.google.internal',
    'http://metadata.googleapis.com',
    'http://instance-data.ec2.internal',
    'http://metadata.azure.com',
  ])('blocks: %s', (url) => {
    const r = validateUrlForFetch(url);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('BLOCKED_HOST');
  });

  it('public hostname allowed (example.com)', () => {
    expect(validateUrlForFetch('https://example.com/path?q=1').ok).toBe(true);
  });
});

describe('validateUrlForFetch — Docker net', () => {
  it('blocks *.flowforge-net (default)', () => {
    const r = validateUrlForFetch('http://tenant-abc.flowforge-net:3100');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('BLOCKED_HOST');
  });

  it('OK *.flowforge-net con allowDockerNet=true (service-to-service)', () => {
    const r = validateUrlForFetch('http://tenant-abc.flowforge-net:3100', { allowDockerNet: true });
    expect(r.ok).toBe(true);
  });

  it('SECURITY: allowDockerNet NON bypassa altri block (loopback ancora bloccato)', () => {
    const r = validateUrlForFetch('http://127.0.0.1:3100', { allowDockerNet: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('BLOCKED_LOOPBACK');
  });
});

describe('validateUrlForFetch — input edge cases', () => {
  it('empty string → INVALID_URL', () => {
    expect(validateUrlForFetch('').reason).toBe('INVALID_URL');
  });
  it('garbage → INVALID_URL', () => {
    expect(validateUrlForFetch('not-a-url').reason).toBe('INVALID_URL');
  });
  it('URL senza hostname (file://?) → INVALID_URL or BLOCKED_SCHEME', () => {
    const r = validateUrlForFetch('http:///');
    expect(r.ok).toBe(false);
  });
});

describe('assertUrlSafe — throws SsrfBlockedError', () => {
  it('throws SsrfBlockedError on private IP', () => {
    expect(() => assertUrlSafe('http://127.0.0.1')).toThrow(SsrfBlockedError);
  });

  it('throws con reason corretto', () => {
    try {
      assertUrlSafe('http://169.254.169.254');
      throw new Error('should not reach');
    } catch (e) {
      expect(e).toBeInstanceOf(SsrfBlockedError);
      const err = e as SsrfBlockedError;
      expect(err.reason).toBe('BLOCKED_LINK_LOCAL');
    }
  });

  it('non throw su public URL', () => {
    expect(() => assertUrlSafe('https://example.com')).not.toThrow();
  });
});

describe('validateIpForFetch — IP risolto (difesa DNS-rebinding)', () => {
  it('IP pubblico v4 → ok', () => {
    expect(validateIpForFetch('8.8.8.8').ok).toBe(true);
    expect(validateIpForFetch('1.1.1.1').ok).toBe(true);
  });

  it.each([
    ['127.0.0.1', 'BLOCKED_LOOPBACK'],
    ['10.0.0.5', 'BLOCKED_PRIVATE_IP'],
    ['172.16.3.4', 'BLOCKED_PRIVATE_IP'],
    ['192.168.1.10', 'BLOCKED_PRIVATE_IP'],
    ['169.254.169.254', 'BLOCKED_LINK_LOCAL'], // cloud metadata IMDS
    ['100.64.0.1', 'BLOCKED_PRIVATE_IP'],      // CGNAT RFC6598
    ['0.0.0.0', 'BLOCKED_RESERVED'],
  ])('blocca IPv4 interno %s con reason %s', (ip, reason) => {
    const r = validateIpForFetch(ip);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(reason);
  });

  it.each([
    ['::1', 'BLOCKED_LOOPBACK'],
    ['fe80::1', 'BLOCKED_LINK_LOCAL'],
    ['fc00::1', 'BLOCKED_PRIVATE_IP'],
    ['fd12:3456::1', 'BLOCKED_PRIVATE_IP'],
  ])('blocca IPv6 interno %s con reason %s', (ip, reason) => {
    const r = validateIpForFetch(ip);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(reason);
  });

  it('IPv6 pubblico → ok', () => {
    expect(validateIpForFetch('2606:4700:4700::1111').ok).toBe(true); // Cloudflare DNS
  });

  it('IPv4-mapped IPv6 verso loopback → bloccato (no bypass)', () => {
    expect(validateIpForFetch('::ffff:127.0.0.1').ok).toBe(false);
  });

  it('stringa NON-IP → INVALID_URL (difensivo: deve ricevere IP risolti)', () => {
    const r = validateIpForFetch('example.com');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INVALID_URL');
  });

  it('coerenza con validateUrlForFetch: stesso verdetto private/public', () => {
    // L'IP risolto e l'IP letterale nell'URL devono dare lo stesso esito.
    for (const ip of ['8.8.8.8', '10.0.0.1', '127.0.0.1', '169.254.169.254']) {
      const viaIp = validateIpForFetch(ip).ok;
      const viaUrl = validateUrlForFetch(`http://${ip.includes(':') ? `[${ip}]` : ip}`).ok;
      expect(viaIp).toBe(viaUrl);
    }
  });
});

describe('allowedHosts — esenzione host:porta fidati (gateway interno di sistema)', () => {
  it('🚨 esenta l\'IP privato per host:porta ESATTO (gateway interno 172.20.0.1:3006)', () => {
    const r = validateUrlForFetch('http://172.20.0.1:3006/v1/chat/completions', { allowedHosts: ['172.20.0.1:3006'] });
    expect(r.ok).toBe(true);
  });

  it('🚨 SENZA allowedHosts lo STESSO IP privato resta bloccato (default sicuro)', () => {
    const r = validateUrlForFetch('http://172.20.0.1:3006/v1/chat/completions');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('BLOCKED_PRIVATE_IP');
  });

  it('🚨 MUTATION: allowedHosts NON apre un IP privato DIVERSO (porta diversa → bloccato)', () => {
    const r = validateUrlForFetch('http://172.20.0.1:9999/x', { allowedHosts: ['172.20.0.1:3006'] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('BLOCKED_PRIVATE_IP');
  });

  it('🚨 MUTATION: allowedHosts NON apre un host privato non in lista (10.0.0.5 con lista diversa)', () => {
    const r = validateUrlForFetch('http://10.0.0.5/x', { allowedHosts: ['172.20.0.1:3006'] });
    expect(r.ok).toBe(false);
  });

  it('🚨 allowedHosts NON bypassa il blocco scheme (gopher:// bloccato anche se host in lista)', () => {
    const r = validateUrlForFetch('gopher://172.20.0.1:3006/x', { allowedHosts: ['172.20.0.1:3006'] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('BLOCKED_SCHEME'); // lo scheme è validato PRIMA dell'esenzione host
  });

  it('allowedHosts vuoto/assente → nessuna esenzione (comportamento invariato)', () => {
    expect(validateUrlForFetch('http://172.20.0.1:3006/x', { allowedHosts: [] }).ok).toBe(false);
  });
});

describe('allowedHosts — esenta anche loopback (runtime interno 127.0.0.1:3100, ollama localhost)', () => {
  it('🚨 127.0.0.1:3100 (runtime interno) esente con allowedHosts (allowDockerNet NON bastava)', () => {
    expect(validateUrlForFetch('http://127.0.0.1:3100/api/v1/vector/x/search', { allowedHosts: ['127.0.0.1:3100'] }).ok).toBe(true);
  });
  it('🚨 localhost:11434 (ollama) esente con allowedHosts', () => {
    expect(validateUrlForFetch('http://localhost:11434/api/embeddings', { allowedHosts: ['localhost:11434'] }).ok).toBe(true);
  });
  it('🚨 MUTATION: allowDockerNet da solo NON esenta il loopback (perché serviva allowedHosts)', () => {
    expect(validateUrlForFetch('http://127.0.0.1:3100/x', { allowDockerNet: true }).ok).toBe(false);
    expect(validateUrlForFetch('http://localhost:11434/x', { allowDockerNet: true }).ok).toBe(false);
  });
  it('🚨 MUTATION: loopback NON in lista → ancora bloccato', () => {
    expect(validateUrlForFetch('http://127.0.0.1:9999/x', { allowedHosts: ['127.0.0.1:3100'] }).ok).toBe(false);
  });
});
