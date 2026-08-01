/**
 * security-audit executor — DNS/SSL/HTTP audit deterministico.
 *
 * No LLM. No flaky output. Tutto verificabile da terzi (dig/openssl/curl).
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@flowforge/nodes-stdlib';
import { resolveTxt, resolve4 } from 'node:dns/promises';
import { connect as tlsConnect, type TLSSocket, type PeerCertificate } from 'node:tls';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
import { isPrivateOrReserved } from '@zeliai/shared';

interface Finding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  framework: 'spf' | 'dkim' | 'dmarc' | 'ssl' | 'redirect' | 'headers';
  title: string;
  remediation: string;
}

interface SpfResult { found: boolean; raw?: string; mechanisms?: string[]; allMode?: string | undefined }
interface DkimResult { selectorsFound: string[]; selectorsTried: string[] }
interface DmarcResult { found: boolean; raw?: string; policy?: string; pct?: number; rua?: string }
interface SslResult { issuer?: string | undefined; subject?: string | undefined; notAfter?: string; daysUntilExpiry?: number; san?: string[]; protocol?: string | undefined; sanMatches?: boolean }
interface RedirectHop { from: string; to: string; status: number }
interface HeadersResult { hsts: boolean; csp: boolean; xfo: boolean; xcto: boolean; referrer: boolean }

function clampTimeout(raw: unknown): number {
  const n = Number(raw ?? 5000);
  if (!Number.isFinite(n)) return 5000;
  return Math.min(Math.max(Math.floor(n), 1000), 30_000);
}

function domainIsValid(d: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(d);
}

/**
 * SSRF guard: il dominio NON deve risolvere a IP privati/reserved.
 * Senza questo guard, un tenant può passare `domain: "localhost"` o
 * `domain: "internal-host.local"` (che risolve a 10.0.0.x) e usare
 * il nodo come port-scanner :443 + cert-grabber su rete interna.
 *
 * Esegue resolve4 (IPv4) e verifica ogni A record contro isPrivateOrReserved.
 * Reject se ANCHE solo 1 A è privato (no partial-leak).
 *
 * NB: copre IPv4 reserved (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16,
 * 100.64/10, 0.0.0.0, link-local, multicast). IPv6 ULA fc00::/7 e link-local
 * fe80::/10 sono coperti da isPrivateOrReserved via @zeliai/shared.
 *
 * Hostname blocklist hardcoded (defense-in-depth, anche se risolutore restituisce pubblico):
 * localhost / *.local / *.internal / *.lan / Docker host-gateway / loopback names.
 */
const HOSTNAME_BLOCKLIST = /^(localhost|.*\.local|.*\.internal|.*\.lan|.*\.localdomain|host\.docker\.internal|metadata\.google\.internal|host\.containers\.internal)$/i;

/**
 * Risolve+valida gli A record e RITORNA gli IP pubblici validati. Il chiamante DEVE
 * usare uno di questi IP per ogni connessione raw (es. {@link inspectSsl}), MAI il
 * dominio: connettersi a `host: domain` ri-risolverebbe il DNS dopo questa validazione
 * (TOCTOU DNS-rebinding) → l'attaccante punta un dominio pubblico a un IP privato tra
 * la validazione e il connect. Pinnando l'IP validato il rebinding è impossibile.
 */
async function assertPublicDomain(domain: string): Promise<string[]> {
  if (HOSTNAME_BLOCKLIST.test(domain)) {
    throw new Error(`action_security_audit: dominio "${domain}" non auditabile (hostname interno/loopback bloccato per SSRF safety).`);
  }
  let ips: string[];
  try { ips = await resolve4(domain); }
  catch { throw new Error(`action_security_audit: dominio "${domain}" non risolvibile (no A record)`); }
  if (ips.length === 0) throw new Error(`action_security_audit: dominio "${domain}" risolve a 0 A record.`);
  for (const ip of ips) {
    if (isPrivateOrReserved(`${ip}/32`)) {
      throw new Error(`action_security_audit: dominio "${domain}" risolve a IP privato/reserved (${ip}) — SSRF bloccato.`);
    }
  }
  return ips;
}

async function lookupSpf(domain: string, signal: AbortSignal): Promise<SpfResult> {
  try {
    const records = await Promise.race([
      resolveTxt(domain),
      new Promise<never>((_, rej) => signal.addEventListener('abort', () => rej(new Error('timeout')))),
    ]);
    const flat = records.map((r) => r.join(''));
    const spf = flat.find((s) => s.toLowerCase().startsWith('v=spf1'));
    if (!spf) return { found: false };
    const tokens = spf.split(/\s+/).slice(1);
    const allTok = tokens.find((t) => t.endsWith('all'));
    return {
      found: true,
      raw: spf,
      mechanisms: tokens.filter((t) => !t.endsWith('all')),
      allMode: allTok,
    };
  } catch {
    return { found: false };
  }
}

async function lookupDkim(domain: string, selectors: string[], signal: AbortSignal): Promise<DkimResult> {
  const found: string[] = [];
  for (const sel of selectors) {
    if (signal.aborted) break;
    try {
      const records = await resolveTxt(`${sel}._domainkey.${domain}`);
      const flat = records.map((r) => r.join('')).find((s) => s.includes('v=DKIM1'));
      if (flat) found.push(sel);
    } catch { /* selector not present, normal */ }
  }
  return { selectorsFound: found, selectorsTried: selectors };
}

async function lookupDmarc(domain: string): Promise<DmarcResult> {
  try {
    const records = await resolveTxt(`_dmarc.${domain}`);
    const flat = records.map((r) => r.join(''));
    const dmarc = flat.find((s) => s.toLowerCase().startsWith('v=dmarc1'));
    if (!dmarc) return { found: false };
    const out: DmarcResult = { found: true, raw: dmarc };
    const policyMatch = /p=([a-z]+)/i.exec(dmarc);
    if (policyMatch?.[1]) out.policy = policyMatch[1].toLowerCase();
    const pctMatch = /pct=(\d+)/.exec(dmarc);
    if (pctMatch?.[1]) out.pct = Number(pctMatch[1]);
    const ruaMatch = /rua=([^;\s]+)/.exec(dmarc);
    if (ruaMatch?.[1]) out.rua = ruaMatch[1];
    return out;
  } catch {
    return { found: false };
  }
}

async function inspectSsl(domain: string, pinnedIp: string, timeoutMs: number): Promise<SslResult | null> {
  return await new Promise<SslResult | null>((resolve) => {
    let settled = false;
    const finish = (v: SslResult | null): void => { if (!settled) { settled = true; resolve(v); } };
    try {
      // ANTI DNS-REBINDING (TOCTOU): connetti all'IP GIÀ validato da assertPublicDomain,
      // NON a `host: domain` (che ri-risolverebbe il DNS qui). `servername` resta il
      // dominio → SNI corretto + validazione SAN del certificato invariata.
      const sock: TLSSocket = tlsConnect({
        host: pinnedIp,
        port: 443,
        servername: domain,
        rejectUnauthorized: false,
        timeout: timeoutMs,
      }, () => {
        const cert: PeerCertificate = sock.getPeerCertificate(true);
        if (!cert || Object.keys(cert).length === 0) { sock.destroy(); finish(null); return; }
        const notAfterMs = new Date(cert.valid_to).getTime();
        const daysUntilExpiry = Math.floor((notAfterMs - Date.now()) / 86_400_000);
        const sanRaw: string = cert.subjectaltname ?? '';
        const san = sanRaw.split(',').map((s) => s.trim().replace(/^DNS:/, '')).filter(Boolean);
        const sanMatches = san.some((d) => d === domain || (d.startsWith('*.') && domain.endsWith(d.slice(1))));
        sock.destroy();
        const issuerRaw: string | string[] | undefined = cert.issuer?.O ?? cert.issuer?.CN;
        const subjectRaw: string | string[] | undefined = cert.subject?.CN;
        const toStr = (v: string | string[] | undefined): string | undefined =>
          Array.isArray(v) ? v[0] : v;
        finish({
          issuer: toStr(issuerRaw),
          subject: toStr(subjectRaw),
          notAfter: cert.valid_to,
          daysUntilExpiry,
          san,
          protocol: sock.getProtocol() ?? undefined,
          sanMatches,
        });
      });
      sock.once('error', () => finish(null));
      sock.once('timeout', () => { sock.destroy(); finish(null); });
    } catch { finish(null); }
  });
}

async function followRedirects(startUrl: string, timeoutMs: number, max = 10): Promise<RedirectHop[]> {
  const chain: RedirectHop[] = [];
  let url = startUrl;
  for (let i = 0; i < max; i++) {
    try {
      const res = await safeOutboundFetch(url, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) break;
        const next = new URL(loc, url).toString();
        chain.push({ from: url, to: next, status: res.status });
        url = next;
      } else {
        chain.push({ from: url, to: url, status: res.status });
        break;
      }
    } catch { break; }
  }
  return chain;
}

async function checkHeaders(domain: string, timeoutMs: number): Promise<HeadersResult> {
  const blank: HeadersResult = { hsts: false, csp: false, xfo: false, xcto: false, referrer: false };
  try {
    const res = await safeOutboundFetch(`https://${domain}/`, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      hsts: !!res.headers.get('strict-transport-security'),
      csp: !!res.headers.get('content-security-policy'),
      xfo: !!res.headers.get('x-frame-options'),
      xcto: (res.headers.get('x-content-type-options') ?? '').toLowerCase() === 'nosniff',
      referrer: !!res.headers.get('referrer-policy'),
    };
  } catch { return blank; }
}

function buildFindings(input: {
  domain: string;
  spf: SpfResult;
  dkim: DkimResult;
  dmarc: DmarcResult;
  ssl: SslResult | null;
  redirects: RedirectHop[];
  headers: HeadersResult;
  sslChecked: boolean;
  redirectsChecked: boolean;
}): { findings: Finding[]; score: number } {
  const f: Finding[] = [];

  // SPF
  if (!input.spf.found) {
    f.push({ severity: 'high', framework: 'spf', title: 'SPF record assente', remediation: `Aggiungi TXT a ${input.domain}: "v=spf1 include:_spf.tuoprovider.it ~all"` });
  } else if (input.spf.allMode === '+all') {
    f.push({ severity: 'critical', framework: 'spf', title: 'SPF +all = permissivo (spoofing aperto)', remediation: 'Cambia "+all" in "-all" (strict) o "~all" (softfail)' });
  } else if (input.spf.allMode === '?all') {
    f.push({ severity: 'medium', framework: 'spf', title: 'SPF ?all = neutral (anti-spoofing debole)', remediation: 'Cambia in "-all" o "~all"' });
  }

  // DKIM
  if (input.dkim.selectorsTried.length > 0 && input.dkim.selectorsFound.length === 0) {
    f.push({ severity: 'high', framework: 'dkim', title: 'DKIM nessun selettore valido trovato', remediation: `Configura DKIM dal tuo email provider e pubblica TXT <selector>._domainkey.${input.domain}` });
  }

  // DMARC
  if (!input.dmarc.found) {
    f.push({ severity: 'high', framework: 'dmarc', title: 'DMARC record assente', remediation: `Aggiungi TXT _dmarc.${input.domain}: "v=DMARC1; p=quarantine; rua=mailto:dmarc@${input.domain}; pct=100"` });
  } else {
    if (input.dmarc.policy === 'none') {
      f.push({ severity: 'medium', framework: 'dmarc', title: 'DMARC policy=none (monitoring only)', remediation: 'Dopo 30gg di monitoring sano passa a p=quarantine, poi p=reject' });
    }
    if (input.dmarc.pct !== undefined && input.dmarc.pct < 100) {
      f.push({ severity: 'low', framework: 'dmarc', title: `DMARC pct=${String(input.dmarc.pct)} (parziale)`, remediation: 'Quando il monitoring è clean, alza pct=100' });
    }
    if (!input.dmarc.rua) {
      f.push({ severity: 'low', framework: 'dmarc', title: 'DMARC rua= mancante (no aggregate report)', remediation: `Aggiungi rua=mailto:dmarc@${input.domain}` });
    }
  }

  // SSL
  if (input.sslChecked) {
    if (!input.ssl) {
      f.push({ severity: 'critical', framework: 'ssl', title: 'SSL/TLS connessione fallita su :443', remediation: 'Verifica firewall + cert installato. Usa Let\'s Encrypt o cert commerciale.' });
    } else {
      if (input.ssl.daysUntilExpiry !== undefined && input.ssl.daysUntilExpiry < 0) {
        f.push({ severity: 'critical', framework: 'ssl', title: 'Certificato SSL SCADUTO', remediation: `Renew immediato (cert expired ${String(-input.ssl.daysUntilExpiry)} giorni fa)` });
      } else if (input.ssl.daysUntilExpiry !== undefined && input.ssl.daysUntilExpiry < 30) {
        f.push({ severity: 'high', framework: 'ssl', title: `Certificato SSL scade in ${String(input.ssl.daysUntilExpiry)} giorni`, remediation: 'Schedule renewal o verifica certbot autorenew' });
      }
      if (input.ssl.sanMatches === false) {
        f.push({ severity: 'high', framework: 'ssl', title: 'Certificato SAN non matcha il dominio', remediation: `Reissue cert con ${input.domain} nei SAN` });
      }
      if (input.ssl.protocol && /^TLSv1(\.0|\.1)?$/.test(input.ssl.protocol)) {
        f.push({ severity: 'high', framework: 'ssl', title: `Protocollo SSL obsoleto: ${input.ssl.protocol}`, remediation: 'Disabilita TLS<1.2 nel webserver (nginx ssl_protocols TLSv1.2 TLSv1.3)' });
      }
    }
  }

  // Redirects
  if (input.redirectsChecked) {
    const startHost = (() => { try { return new URL(`http://${input.domain}`).host; } catch { return input.domain; } })();
    for (const hop of input.redirects) {
      try {
        const toHost = new URL(hop.to).host;
        if (toHost !== startHost && !toHost.endsWith(`.${startHost.replace(/^www\./, '')}`)) {
          f.push({ severity: 'medium', framework: 'redirect', title: `Redirect cross-domain: ${startHost} → ${toHost}`, remediation: 'Verifica intenzionale (no open-redirect / phishing risk)' });
          break;
        }
      } catch { /* ignore */ }
    }
    if (input.redirects.length >= 10) {
      f.push({ severity: 'medium', framework: 'redirect', title: 'Redirect chain ≥10 hop (loop probabile)', remediation: 'Refactor catena redirect, mantieni <=2 hop' });
    }
  }

  // Headers
  if (!input.headers.hsts) f.push({ severity: 'medium', framework: 'headers', title: 'HSTS header assente', remediation: 'Aggiungi "Strict-Transport-Security: max-age=63072000; includeSubDomains; preload"' });
  if (!input.headers.csp) f.push({ severity: 'medium', framework: 'headers', title: 'Content-Security-Policy assente', remediation: 'Definisci CSP restrittivo (default-src \'self\')' });
  if (!input.headers.xfo) f.push({ severity: 'low', framework: 'headers', title: 'X-Frame-Options assente (clickjacking)', remediation: 'Aggiungi "X-Frame-Options: SAMEORIGIN" o CSP frame-ancestors' });
  if (!input.headers.xcto) f.push({ severity: 'low', framework: 'headers', title: 'X-Content-Type-Options=nosniff assente', remediation: 'Aggiungi "X-Content-Type-Options: nosniff"' });
  if (!input.headers.referrer) f.push({ severity: 'low', framework: 'headers', title: 'Referrer-Policy assente', remediation: 'Aggiungi "Referrer-Policy: strict-origin-when-cross-origin"' });

  // Score 0-100: parte da 100, sottrae per severity
  let score = 100;
  for (const x of f) {
    score -= x.severity === 'critical' ? 25 : x.severity === 'high' ? 15 : x.severity === 'medium' ? 7 : 3;
  }
  score = Math.max(0, Math.min(100, score));

  return { findings: f, score };
}

// `_input` (output del nodo upstream) è inutilizzato BY DESIGN: questo nodo
// opera esclusivamente sul `domain` in config. L'input a monte resta comunque
// raggiungibile dall'utente tramite espressioni `{{…}}` in config.domain, già
// risolte dal choke-point interpolateConfig PRIMA di arrivare qui — quindi non
// serve consumare il parametro diretto. (Non è un TODO: è il contratto del nodo.)
export const securityAuditExecutor: NodeExecutor = async (rawConfig, _input, _context) => {
  const start = Date.now();
  const cfg = rawConfig;

  let domain = coerceString(cfg.domain ?? '').trim().toLowerCase();
  // Strip protocol + path se passati
  domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  if (!domain) throw new Error('action_security_audit: campo "domain" obbligatorio.');

  // SSRF guard PRIMA del check formato: hostname tipo "localhost" non hanno
  // dot ma vanno rifiutati come SSRF, non come "invalid format" (più chiaro
  // per audit trail + non leak info).
  if (HOSTNAME_BLOCKLIST.test(domain)) {
    throw new Error(`action_security_audit: dominio "${domain}" non auditabile (hostname interno/loopback bloccato per SSRF safety).`);
  }

  if (!domainIsValid(domain)) throw new Error(`action_security_audit: dominio non valido "${domain}".`);

  const timeoutMs = clampTimeout(cfg.timeoutMs);
  const dkimSelectors = coerceString(cfg.dkimSelectors ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const checkSsl = cfg.checkSsl !== false && coerceString(cfg.checkSsl ?? 'true') !== 'false';
  const checkRedirects = cfg.checkRedirects !== false && coerceString(cfg.checkRedirects ?? 'true') !== 'false';

  // Pre-flight: SSRF guard tier 2 (risoluzione DNS → verify IP pubblico).
  // Senza questo, tls.connect/DNS-lookup possono fare recon su rete interna
  // se attaccante registra dominio pubblico con A record privato. Gli IP validati
  // sono PINNATI per la connessione TLS raw → niente ri-risoluzione (anti-rebinding).
  const validatedIps = await assertPublicDomain(domain);
  const pinnedIp = validatedIps[0]!; // assertPublicDomain garantisce ≥1 IP pubblico

  const ctrl = new AbortController();
  const abortTimer = setTimeout(() => ctrl.abort(), timeoutMs * 4);

  try {
    const [spf, dkim, dmarc, ssl, redirects, headers] = await Promise.all([
      lookupSpf(domain, ctrl.signal),
      dkimSelectors.length > 0 ? lookupDkim(domain, dkimSelectors, ctrl.signal) : Promise.resolve({ selectorsFound: [], selectorsTried: [] }),
      lookupDmarc(domain),
      checkSsl ? inspectSsl(domain, pinnedIp, timeoutMs) : Promise.resolve(null),
      checkRedirects ? followRedirects(`http://${domain}`, timeoutMs) : Promise.resolve([]),
      checkHeaders(domain, timeoutMs),
    ]);

    const { findings, score } = buildFindings({
      domain, spf, dkim, dmarc, ssl, redirects, headers,
      sslChecked: checkSsl,
      redirectsChecked: checkRedirects,
    });

    return {
      output: {
        domain,
        score,
        findings,
        spf,
        dkim,
        dmarc,
        ssl,
        redirects,
        headers,
        checkedAt: new Date().toISOString(),
      },
      durationMs: Date.now() - start,
    };
  } finally {
    clearTimeout(abortTimer);
  }
};
