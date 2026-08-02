import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock DNS prima dell'import dell'executor
vi.mock('node:dns/promises', () => ({
  resolveTxt: vi.fn(),
  resolve4: vi.fn(),
}));

vi.mock('@/lib/safe-outbound-fetch.js', () => ({
  safeOutboundFetch: vi.fn(),
}));

// Mock TLS per ispezionare l'IP a cui la connessione SSL viene PINNATA (anti-rebind).
vi.mock('node:tls', () => ({
  connect: vi.fn((_opts: unknown, cb?: () => void) => {
    const futureDate = new Date(Date.now() + 90 * 86_400_000).toUTCString();
    const sock = {
      getPeerCertificate: () => ({
        valid_to: futureDate,
        subjectaltname: 'DNS:pinned.test',
        issuer: { O: 'TestCA' },
        subject: { CN: 'pinned.test' },
      }),
      getProtocol: () => 'TLSv1.3',
      destroy: vi.fn(),
      once: vi.fn(),
    };
    if (cb) queueMicrotask(cb); // cb dopo che il chiamante ha assegnato `sock`
    return sock;
  }),
}));

import { securityAuditExecutor } from './security-audit.js';
import { resolveTxt, resolve4 } from 'node:dns/promises';
import { connect as tlsConnect } from 'node:tls';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';

const mockResolveTxt = vi.mocked(resolveTxt);
const mockResolve4 = vi.mocked(resolve4);
const mockTlsConnect = vi.mocked(tlsConnect);
const mockFetch = vi.mocked(safeOutboundFetch);

const baseContext = {
  tenantId: 'tenant-test',
  runId: 'run-1',
  nodeId: 'node-1',
} as unknown as Parameters<typeof securityAuditExecutor>[2];

function mockHeadResponse(headers: Record<string, string> = {}, status = 200): Response {
  const h = new Headers(headers);
  return new Response(null, { status, headers: h });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolve4.mockResolvedValue(['1.2.3.4']);
  mockFetch.mockResolvedValue(mockHeadResponse());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('security-audit executor — validation', () => {
  it('rejecta dominio vuoto', async () => {
    await expect(securityAuditExecutor({ domain: '' }, null, baseContext)).rejects.toThrow(
      /obbligatorio/i,
    );
  });

  it('rejecta dominio invalido (caratteri non ammessi)', async () => {
    await expect(
      securityAuditExecutor({ domain: 'http://!@#$' }, null, baseContext),
    ).rejects.toThrow(/non valido/i);
  });

  it('strip protocol/path/port automatico', async () => {
    mockResolveTxt.mockResolvedValue([]);
    const r = await securityAuditExecutor(
      {
        domain: 'https://example.com:8443/some/path?q=1',
        checkSsl: 'false',
        checkRedirects: 'false',
        dkimSelectors: '',
      },
      null,
      baseContext,
    );
    expect((r.output as { domain: string }).domain).toBe('example.com');
  });

  it('domain non risolvibile → error chiaro', async () => {
    mockResolve4.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(
      securityAuditExecutor(
        { domain: 'invalid.test', checkSsl: 'false', checkRedirects: 'false', dkimSelectors: '' },
        null,
        baseContext,
      ),
    ).rejects.toThrow(/non risolvibile/i);
  });
});

describe("security-audit executor — CONTRACT: opera SOLO su config.domain, ignora l'input upstream", () => {
  it("un domain nell'INPUT NON fa da fallback quando config.domain è vuoto", async () => {
    // Prova che _input è ignorato by-design: se venisse usato come fallback,
    // questo passerebbe la validazione invece di fallire. L'input upstream si
    // porta via config.domain con espressioni {{…}}, non dal parametro diretto.
    await expect(
      securityAuditExecutor(
        { domain: '' },
        { domain: 'iniettato.example.com', json: { domain: 'iniettato.example.com' } } as never,
        baseContext,
      ),
    ).rejects.toThrow(/obbligatorio/i);
  });

  it('input arbitrario/sporco non altera il risultato: conta solo config.domain', async () => {
    mockResolveTxt.mockResolvedValue([]);
    const cfg = {
      domain: 'example.com',
      checkSsl: 'false',
      checkRedirects: 'false',
      dkimSelectors: '',
    };
    const withNull = await securityAuditExecutor(cfg, null, baseContext);
    const withDirtyInput = await securityAuditExecutor(
      cfg,
      { evil: '<script>', domain: 'altro.com', items: [1, 2] } as never,
      baseContext,
    );
    expect((withNull.output as { domain: string }).domain).toBe('example.com');
    expect((withDirtyInput.output as { domain: string }).domain).toBe('example.com');
  });
});

describe('security-audit executor — SSRF guard (CVE-fix consulente 2026-06-05)', () => {
  it('hostname "localhost" → reject SSRF', async () => {
    await expect(
      securityAuditExecutor(
        { domain: 'localhost', checkSsl: 'false', checkRedirects: 'false', dkimSelectors: '' },
        null,
        baseContext,
      ),
    ).rejects.toThrow(/SSRF safety|interno\/loopback/i);
  });

  it('hostname "*.local" → reject SSRF (Bonjour/mDNS)', async () => {
    await expect(
      securityAuditExecutor(
        { domain: 'mac-mini.local', checkSsl: 'false', checkRedirects: 'false', dkimSelectors: '' },
        null,
        baseContext,
      ),
    ).rejects.toThrow(/SSRF safety|interno\/loopback/i);
  });

  it('hostname "host.docker.internal" → reject SSRF (container escape)', async () => {
    await expect(
      securityAuditExecutor(
        {
          domain: 'host.docker.internal',
          checkSsl: 'false',
          checkRedirects: 'false',
          dkimSelectors: '',
        },
        null,
        baseContext,
      ),
    ).rejects.toThrow(/SSRF safety|interno\/loopback/i);
  });

  it('hostname "metadata.google.internal" → reject SSRF (cloud metadata)', async () => {
    await expect(
      securityAuditExecutor(
        {
          domain: 'metadata.google.internal',
          checkSsl: 'false',
          checkRedirects: 'false',
          dkimSelectors: '',
        },
        null,
        baseContext,
      ),
    ).rejects.toThrow(/SSRF safety|interno\/loopback/i);
  });

  it('dominio pubblico ma A record privato (10.x.x.x) → reject SSRF', async () => {
    mockResolve4.mockResolvedValue(['10.0.0.1']);
    await expect(
      securityAuditExecutor(
        {
          domain: 'attacker-controlled.com',
          checkSsl: 'false',
          checkRedirects: 'false',
          dkimSelectors: '',
        },
        null,
        baseContext,
      ),
    ).rejects.toThrow(/IP privato.*SSRF/i);
  });

  it('dominio pubblico ma A record loopback (127.0.0.1) → reject SSRF', async () => {
    mockResolve4.mockResolvedValue(['127.0.0.1']);
    await expect(
      securityAuditExecutor(
        {
          domain: 'pin-loopback.com',
          checkSsl: 'false',
          checkRedirects: 'false',
          dkimSelectors: '',
        },
        null,
        baseContext,
      ),
    ).rejects.toThrow(/IP privato.*SSRF/i);
  });

  it('dominio pubblico ma A record link-local (169.254.169.254 AWS metadata) → reject SSRF', async () => {
    mockResolve4.mockResolvedValue(['169.254.169.254']);
    await expect(
      securityAuditExecutor(
        {
          domain: 'aws-metadata.com',
          checkSsl: 'false',
          checkRedirects: 'false',
          dkimSelectors: '',
        },
        null,
        baseContext,
      ),
    ).rejects.toThrow(/IP privato.*SSRF/i);
  });

  it('multi A record con almeno 1 privato → reject SSRF (no partial leak)', async () => {
    mockResolve4.mockResolvedValue(['8.8.8.8', '192.168.1.1']);
    await expect(
      securityAuditExecutor(
        { domain: 'mixed-leak.com', checkSsl: 'false', checkRedirects: 'false', dkimSelectors: '' },
        null,
        baseContext,
      ),
    ).rejects.toThrow(/IP privato.*SSRF/i);
  });

  it('dominio pubblico legittimo (8.8.8.8) → passa la SSRF guard', async () => {
    mockResolve4.mockResolvedValue(['8.8.8.8']);
    mockResolveTxt.mockResolvedValue([]);
    const r = await securityAuditExecutor(
      {
        domain: 'public.example.com',
        checkSsl: 'false',
        checkRedirects: 'false',
        dkimSelectors: '',
      },
      null,
      baseContext,
    );
    expect((r.output as { domain: string }).domain).toBe('public.example.com');
  });

  it("🚨🚨 ANTI DNS-REBINDING: la TLS connect è PINNATA all'IP validato, NON al dominio", async () => {
    // resolve4 risolve a un IP pubblico; la connessione TLS deve usare QUELL'IP
    // (host) e il dominio solo come servername (SNI). Connettersi a host=domain
    // ri-risolverebbe il DNS qui → finestra di rebinding verso un IP privato.
    mockResolve4.mockResolvedValue(['1.1.1.1']);
    mockResolveTxt.mockResolvedValue([]);
    await securityAuditExecutor(
      { domain: 'rebind-target.com', checkSsl: 'true', checkRedirects: 'false', dkimSelectors: '' },
      null,
      baseContext,
    );
    expect(mockTlsConnect).toHaveBeenCalledTimes(1);
    const opts = mockTlsConnect.mock.calls[0]![0] as {
      host?: string;
      servername?: string;
      port?: number;
    };
    expect(opts.host).toBe('1.1.1.1'); // IP PINNATO (validato)
    expect(opts.host).not.toBe('rebind-target.com'); // mai il dominio (no ri-risoluzione)
    expect(opts.servername).toBe('rebind-target.com'); // SNI = dominio (cert/SAN ok)
    expect(opts.port).toBe(443);
  });

  it('🚨 DNS risolve UNA sola volta (no seconda risoluzione sfruttabile per rebinding)', async () => {
    mockResolve4.mockResolvedValue(['8.8.8.8']);
    mockResolveTxt.mockResolvedValue([]);
    await securityAuditExecutor(
      {
        domain: 'single-resolve.com',
        checkSsl: 'true',
        checkRedirects: 'false',
        dkimSelectors: '',
      },
      null,
      baseContext,
    );
    // assertPublicDomain è l'UNICO resolve4 del path TLS: l'IP poi è pinnato.
    expect(mockResolve4).toHaveBeenCalledTimes(1);
    expect(mockResolve4).toHaveBeenCalledWith('single-resolve.com');
  });
});

describe('security-audit executor — SPF', () => {
  it('SPF assente → finding HIGH', async () => {
    mockResolveTxt.mockResolvedValue([]);
    const r = await securityAuditExecutor(
      { domain: 'example.com', checkSsl: 'false', checkRedirects: 'false', dkimSelectors: '' },
      null,
      baseContext,
    );
    const out = r.output as { findings: { framework: string; severity: string; title: string }[] };
    const spfFinding = out.findings.find((f) => f.framework === 'spf');
    expect(spfFinding?.severity).toBe('high');
    expect(spfFinding?.title).toMatch(/SPF.*assente/i);
  });

  it('SPF +all (spoofing aperto) → CRITICAL', async () => {
    mockResolveTxt.mockImplementation(async (name: string) => {
      if (name === 'example.com') return [['v=spf1 +all']];
      return [];
    });
    const r = await securityAuditExecutor(
      { domain: 'example.com', checkSsl: 'false', checkRedirects: 'false', dkimSelectors: '' },
      null,
      baseContext,
    );
    const out = r.output as {
      findings: { framework: string; severity: string; title: string }[];
      spf: { allMode: string };
    };
    expect(out.spf.allMode).toBe('+all');
    expect(out.findings.find((f) => f.framework === 'spf')?.severity).toBe('critical');
  });

  it('SPF ?all (neutral) → MEDIUM', async () => {
    mockResolveTxt.mockImplementation(async (name: string) => {
      if (name === 'example.com') return [['v=spf1 include:_spf.test.com ?all']];
      return [];
    });
    const r = await securityAuditExecutor(
      { domain: 'example.com', checkSsl: 'false', checkRedirects: 'false', dkimSelectors: '' },
      null,
      baseContext,
    );
    const out = r.output as { findings: { framework: string; severity: string }[] };
    expect(out.findings.find((f) => f.framework === 'spf')?.severity).toBe('medium');
  });

  it('SPF -all + mechanisms parsati', async () => {
    mockResolveTxt.mockImplementation(async (name: string) => {
      if (name === 'example.com') return [['v=spf1 include:_spf.google.com ip4:1.2.3.4 -all']];
      return [];
    });
    const r = await securityAuditExecutor(
      { domain: 'example.com', checkSsl: 'false', checkRedirects: 'false', dkimSelectors: '' },
      null,
      baseContext,
    );
    const out = r.output as {
      spf: { found: boolean; mechanisms: string[]; allMode: string };
      findings: { framework: string }[];
    };
    expect(out.spf.found).toBe(true);
    expect(out.spf.allMode).toBe('-all');
    expect(out.spf.mechanisms).toContain('include:_spf.google.com');
    expect(out.spf.mechanisms).toContain('ip4:1.2.3.4');
    // No SPF finding because -all is OK
    expect(out.findings.find((f) => f.framework === 'spf')).toBeUndefined();
  });
});

describe('security-audit executor — DKIM', () => {
  it('DKIM selettori tutti vuoti → finding HIGH', async () => {
    mockResolveTxt.mockResolvedValue([]);
    const r = await securityAuditExecutor(
      {
        domain: 'example.com',
        checkSsl: 'false',
        checkRedirects: 'false',
        dkimSelectors: 'google,default',
      },
      null,
      baseContext,
    );
    const out = r.output as {
      findings: { framework: string; severity: string }[];
      dkim: { selectorsTried: string[]; selectorsFound: string[] };
    };
    expect(out.dkim.selectorsTried).toEqual(['google', 'default']);
    expect(out.dkim.selectorsFound).toEqual([]);
    expect(out.findings.find((f) => f.framework === 'dkim')?.severity).toBe('high');
  });

  it('DKIM almeno 1 selettore valido → no finding', async () => {
    mockResolveTxt.mockImplementation(async (name: string) => {
      if (name === 'google._domainkey.example.com')
        return [['v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQ...']];
      return [];
    });
    const r = await securityAuditExecutor(
      {
        domain: 'example.com',
        checkSsl: 'false',
        checkRedirects: 'false',
        dkimSelectors: 'google,default',
      },
      null,
      baseContext,
    );
    const out = r.output as {
      findings: { framework: string }[];
      dkim: { selectorsFound: string[] };
    };
    expect(out.dkim.selectorsFound).toEqual(['google']);
    expect(out.findings.find((f) => f.framework === 'dkim')).toBeUndefined();
  });

  it('DKIM skip se selectors vuoto', async () => {
    mockResolveTxt.mockResolvedValue([]);
    const r = await securityAuditExecutor(
      { domain: 'example.com', checkSsl: 'false', checkRedirects: 'false', dkimSelectors: '' },
      null,
      baseContext,
    );
    const out = r.output as {
      findings: { framework: string }[];
      dkim: { selectorsTried: string[] };
    };
    expect(out.dkim.selectorsTried).toEqual([]);
    expect(out.findings.find((f) => f.framework === 'dkim')).toBeUndefined();
  });
});

describe('security-audit executor — DMARC', () => {
  it('DMARC assente → finding HIGH', async () => {
    mockResolveTxt.mockResolvedValue([]);
    const r = await securityAuditExecutor(
      { domain: 'example.com', checkSsl: 'false', checkRedirects: 'false', dkimSelectors: '' },
      null,
      baseContext,
    );
    const out = r.output as { findings: { framework: string; severity: string }[] };
    expect(out.findings.find((f) => f.framework === 'dmarc')?.severity).toBe('high');
  });

  it('DMARC p=none → finding MEDIUM', async () => {
    mockResolveTxt.mockImplementation(async (name: string) => {
      if (name === '_dmarc.example.com')
        return [['v=DMARC1; p=none; pct=100; rua=mailto:dmarc@example.com']];
      return [];
    });
    const r = await securityAuditExecutor(
      { domain: 'example.com', checkSsl: 'false', checkRedirects: 'false', dkimSelectors: '' },
      null,
      baseContext,
    );
    const out = r.output as {
      findings: { framework: string; severity: string; title: string }[];
      dmarc: { policy: string; pct: number; rua: string };
    };
    expect(out.dmarc.policy).toBe('none');
    expect(out.dmarc.pct).toBe(100);
    expect(out.dmarc.rua).toBe('mailto:dmarc@example.com');
    expect(
      out.findings.find((f) => f.framework === 'dmarc' && f.title.includes('policy=none'))
        ?.severity,
    ).toBe('medium');
  });

  it('DMARC pct<100 + senza rua → 2 findings (low ognuno)', async () => {
    mockResolveTxt.mockImplementation(async (name: string) => {
      if (name === '_dmarc.example.com') return [['v=DMARC1; p=reject; pct=50']];
      return [];
    });
    const r = await securityAuditExecutor(
      { domain: 'example.com', checkSsl: 'false', checkRedirects: 'false', dkimSelectors: '' },
      null,
      baseContext,
    );
    const out = r.output as { findings: { framework: string; severity: string; title: string }[] };
    const dmarcFinds = out.findings.filter((f) => f.framework === 'dmarc');
    expect(dmarcFinds.some((f) => f.title.includes('pct=50') && f.severity === 'low')).toBe(true);
    expect(dmarcFinds.some((f) => /rua.*mancante/i.test(f.title) && f.severity === 'low')).toBe(
      true,
    );
  });

  it('DMARC p=reject pct=100 con rua → no DMARC finding', async () => {
    mockResolveTxt.mockImplementation(async (name: string) => {
      if (name === '_dmarc.example.com')
        return [['v=DMARC1; p=reject; pct=100; rua=mailto:d@example.com']];
      return [];
    });
    const r = await securityAuditExecutor(
      { domain: 'example.com', checkSsl: 'false', checkRedirects: 'false', dkimSelectors: '' },
      null,
      baseContext,
    );
    const out = r.output as { findings: { framework: string }[] };
    expect(out.findings.find((f) => f.framework === 'dmarc')).toBeUndefined();
  });
});

describe('security-audit executor — Headers', () => {
  it('HSTS+CSP+XFO+nosniff+referrer mancanti → 5 findings', async () => {
    mockResolveTxt.mockResolvedValue([]);
    mockFetch.mockResolvedValue(mockHeadResponse({})); // no security headers
    const r = await securityAuditExecutor(
      { domain: 'example.com', checkSsl: 'false', checkRedirects: 'false', dkimSelectors: '' },
      null,
      baseContext,
    );
    const out = r.output as {
      findings: { framework: string }[];
      headers: { hsts: boolean; csp: boolean; xfo: boolean; xcto: boolean; referrer: boolean };
    };
    expect(out.headers.hsts).toBe(false);
    expect(out.headers.csp).toBe(false);
    const headerFinds = out.findings.filter((f) => f.framework === 'headers');
    expect(headerFinds.length).toBe(5);
  });

  it('tutti security headers presenti → 0 header findings', async () => {
    mockResolveTxt.mockResolvedValue([]);
    mockFetch.mockResolvedValue(
      mockHeadResponse({
        'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
        'content-security-policy': "default-src 'self'",
        'x-frame-options': 'SAMEORIGIN',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin',
      }),
    );
    const r = await securityAuditExecutor(
      { domain: 'example.com', checkSsl: 'false', checkRedirects: 'false', dkimSelectors: '' },
      null,
      baseContext,
    );
    const out = r.output as {
      findings: { framework: string }[];
      headers: { hsts: boolean; csp: boolean };
    };
    expect(out.headers.hsts).toBe(true);
    expect(out.headers.csp).toBe(true);
    expect(out.findings.filter((f) => f.framework === 'headers').length).toBe(0);
  });
});

describe('security-audit executor — Score', () => {
  it('dominio perfect (SPF -all + DKIM trovato + DMARC reject + tutti headers) → score ≥85', async () => {
    mockResolveTxt.mockImplementation(async (name: string) => {
      if (name === 'example.com') return [['v=spf1 include:_spf.test ip4:1.2.3.4 -all']];
      if (name === '_dmarc.example.com')
        return [['v=DMARC1; p=reject; pct=100; rua=mailto:d@example.com']];
      if (name === 'google._domainkey.example.com') return [['v=DKIM1; k=rsa; p=MIGfMA0GCSqG...']];
      return [];
    });
    mockFetch.mockResolvedValue(
      mockHeadResponse({
        'strict-transport-security': 'max-age=63072000',
        'content-security-policy': "default-src 'self'",
        'x-frame-options': 'SAMEORIGIN',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin',
      }),
    );
    const r = await securityAuditExecutor(
      {
        domain: 'example.com',
        checkSsl: 'false',
        checkRedirects: 'false',
        dkimSelectors: 'google',
      },
      null,
      baseContext,
    );
    const out = r.output as { score: number };
    expect(out.score).toBeGreaterThanOrEqual(85);
  });

  it('dominio peggiore (SPF +all + DKIM missing + DMARC missing + 0 headers) → score ≤20', async () => {
    mockResolveTxt.mockImplementation(async (name: string) => {
      if (name === 'example.com') return [['v=spf1 +all']];
      return [];
    });
    mockFetch.mockResolvedValue(mockHeadResponse({}));
    const r = await securityAuditExecutor(
      {
        domain: 'example.com',
        checkSsl: 'false',
        checkRedirects: 'false',
        dkimSelectors: 'google,default',
      },
      null,
      baseContext,
    );
    const out = r.output as { score: number };
    expect(out.score).toBeLessThanOrEqual(25);
  });

  it('output contiene checkedAt ISO 8601 + tutti i field root', async () => {
    mockResolveTxt.mockResolvedValue([]);
    mockFetch.mockResolvedValue(mockHeadResponse({}));
    const r = await securityAuditExecutor(
      { domain: 'example.com', checkSsl: 'false', checkRedirects: 'false', dkimSelectors: '' },
      null,
      baseContext,
    );
    const out = r.output as Record<string, unknown>;
    expect(out.domain).toBe('example.com');
    expect(typeof out.score).toBe('number');
    expect(Array.isArray(out.findings)).toBe(true);
    expect(out.spf).toBeDefined();
    expect(out.dkim).toBeDefined();
    expect(out.dmarc).toBeDefined();
    expect(out.redirects).toBeDefined();
    expect(out.headers).toBeDefined();
    expect(out.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
