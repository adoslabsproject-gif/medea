/**
 * action_link_audit — analisi link di una pagina (broken/internal/external).
 *
 * Estrae tutti gli <a href> dall'HTML, classifica per scope (internal/external)
 * e opzionalmente esegue HEAD check parallelo per identificare broken (status
 * >= 400 o network error).
 *
 * Controlli safety:
 *  - SSRF block (safeFetchWithRedirects per ogni check)
 *  - Concorrenza limitata (default 5, hard cap 20)
 *  - Timeout per request (default 8s)
 *  - Hard cap totale link verificati (default 200)
 */

import { load as cheerioLoad } from 'cheerio';
import { safeFetchWithRedirects, SsrfBlockedError } from '@medea/engine-safe-fetch';
import type { NodeModule, NodeExecutor } from '../types.js';

type LinkSeverity = 'critical' | 'warning' | 'info';

interface LinkInfo {
  href: string;
  resolved: string | null;
  text: string;
  rel: string | null;
  scope: 'internal' | 'external' | 'anchor' | 'mailto' | 'tel' | 'data' | 'unknown';
  /** rel="nofollow" — Google non passa link-juice. */
  nofollow: boolean;
  /** rel="sponsored" — link a pagamento (Google Ads policy). */
  sponsored: boolean;
  /** rel="ugc" — user-generated content. */
  ugc: boolean;
  /** target="_blank". */
  targetBlank: boolean;
  /** rel="noopener" o "noreferrer" presente. */
  noopener: boolean;
  /** target="_blank" SENZA noopener → reverse tabnabbing (CWE-1022). */
  tabnabbingRisk: boolean;
  status?: number;
  ok?: boolean;
  error?: string;
  severity?: LinkSeverity;
  durationMs?: number;
}

interface LinkAuditResult {
  baseUrl: string | null;
  totalLinks: number;
  uniqueLinks: number;
  checked: number;
  skipped: number;
  byScope: Record<string, number>;
  /** Conteggi sintetici pronti per un report/email. */
  summary: {
    total: number;
    internal: number;
    external: number;
    nofollow: number;
    sponsored: number;
    ugc: number;
    broken: number;
    tabnabbingRisks: number;
  };
  broken: LinkInfo[];
  brokenCount: number;
  /** Link con target="_blank" privi di rel="noopener" (rischio reverse tabnabbing). */
  tabnabbingRisks: LinkInfo[];
  redirects: LinkInfo[];
  links: LinkInfo[];
}

/** Severity di un link rotto in ottica SEO/UX: 404 = critico, 5xx = warning, 3xx = info. */
function severityFor(status: number | undefined, ok: boolean): LinkSeverity | undefined {
  if (ok) return undefined;
  if (status === undefined) return 'warning'; // errore di rete/timeout/DNS
  if (status === 404 || status === 410) return 'critical';
  if (status >= 500) return 'warning';
  if (status >= 400) return 'warning';
  if (status >= 300) return 'info';
  return undefined;
}

/** Estrae i token rel + il flag target da un <a>. */
function relFlags(rel: string | null, target: string | null): Pick<LinkInfo, 'nofollow' | 'sponsored' | 'ugc' | 'targetBlank' | 'noopener' | 'tabnabbingRisk'> {
  const tokens = (rel ?? '').toLowerCase().split(/\s+/u).filter(Boolean);
  const has = (t: string): boolean => tokens.includes(t);
  const targetBlank = (target ?? '').toLowerCase() === '_blank';
  const noopener = has('noopener') || has('noreferrer');
  return {
    nofollow: has('nofollow'),
    sponsored: has('sponsored'),
    ugc: has('ugc'),
    targetBlank,
    noopener,
    tabnabbingRisk: targetBlank && !noopener,
  };
}

function getHtmlAndUrl(config: Record<string, unknown>, input: unknown): { html: string; baseUrl: string | null } {
  const explicitRaw = config.baseUrl;
  const explicitUrl: string | null = typeof explicitRaw === 'string' && explicitRaw.trim() !== '' ? explicitRaw.trim() : null;
  if (typeof input === 'string') return { html: input, baseUrl: explicitUrl };
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const fromInput: string | null = typeof obj.url === 'string' ? obj.url : typeof obj.finalUrl === 'string' ? obj.finalUrl : null;
    if (typeof obj.body === 'string') return { html: obj.body, baseUrl: explicitUrl ?? fromInput };
    if (typeof obj.html === 'string') return { html: obj.html, baseUrl: explicitUrl ?? fromInput };
  }
  return { html: String(config.htmlExplicit ?? ''), baseUrl: explicitUrl };
}

function classify(href: string, base: URL | null): { scope: LinkInfo['scope']; resolved: string | null } {
  const t = href.trim();
  if (!t) return { scope: 'unknown', resolved: null };
  if (t.startsWith('#')) return { scope: 'anchor', resolved: null };
  if (t.startsWith('mailto:')) return { scope: 'mailto', resolved: null };
  if (t.startsWith('tel:')) return { scope: 'tel', resolved: null };
  if (/^data:/iu.test(t)) return { scope: 'data', resolved: null };
  if (/^javascript:/iu.test(t)) return { scope: 'unknown', resolved: null };
  try {
    const resolvedUrl = new URL(t, base ?? 'https://example.invalid');
    if (!base) return { scope: 'unknown', resolved: resolvedUrl.toString() };
    return {
      scope: resolvedUrl.host === base.host ? 'internal' : 'external',
      resolved: resolvedUrl.toString(),
    };
  } catch { return { scope: 'unknown', resolved: null }; }
}

async function checkLink(url: string, userAgent: string, timeoutMs: number, signal: AbortSignal): Promise<{ status?: number; ok: boolean; error?: string; durationMs: number }> {
  const t0 = Date.now();
  try {
    const res = await safeFetchWithRedirects(url, {
      method: 'HEAD',
      headers: { 'user-agent': userAgent, accept: '*/*' },
      redirect: 'follow',
      signal,
      maxRedirects: 5,
      timeoutMs,
    } as never);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
    try { void res.body?.cancel?.(); } catch { /* ignore */ }
    return { status: res.status, ok: res.ok, durationMs: Date.now() - t0 };
  } catch (e) {
    if (e instanceof SsrfBlockedError) return { error: 'SSRF blocked', ok: false, durationMs: Date.now() - t0 };
    // Fallback to GET (some servers reject HEAD with 405)
    try {
      const res = await safeFetchWithRedirects(url, {
        method: 'GET',
        headers: { 'user-agent': userAgent, accept: '*/*' },
        redirect: 'follow',
        signal,
        maxRedirects: 5,
        timeoutMs,
      } as never);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
      try { void res.body?.cancel?.(); } catch { /* ignore */ }
      return { status: res.status, ok: res.ok, durationMs: Date.now() - t0 };
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : String(e2);
      return { ok: false, error: msg, durationMs: Date.now() - t0 };
    }
  }
}

async function runWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Zod-parsed payload → safe per design
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) {
    workers.push((async () => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
      while (true) {
        const idx = cursor;
        cursor += 1;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx] as T);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

const executor: NodeExecutor = async (config, input, context) => {
  const start = Date.now();
  const { html, baseUrl } = getHtmlAndUrl(config, input);
  if (!html.trim()) {
    return { output: { warnings: ['Empty HTML input'] }, durationMs: Date.now() - start, warnings: ['Empty HTML input'] };
  }

  const $ = cheerioLoad(html);
  const base = baseUrl ? (() => { try { return new URL(baseUrl); } catch { return null; } })() : null;

  // Collect all <a href> + classify
  const rawLinks: LinkInfo[] = [];
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href) return;
    const text = $(el).text().trim().slice(0, 120);
    const rel = $(el).attr('rel') ?? null;
    const target = $(el).attr('target') ?? null;
    const { scope, resolved } = classify(href, base);
    rawLinks.push({ href, resolved, text, rel, scope, ...relFlags(rel, target) });
  });

  // Dedup by resolved URL (or href for anchors)
  const seen = new Set<string>();
  const unique: LinkInfo[] = [];
  for (const l of rawLinks) {
    const key = l.resolved ?? l.href;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(l);
  }

  const byScope: Record<string, number> = { internal: 0, external: 0, anchor: 0, mailto: 0, tel: 0, data: 0, unknown: 0 };
  for (const l of unique) byScope[l.scope] = (byScope[l.scope] ?? 0) + 1;

  const checkBroken = config.checkBroken !== false;
  const maxChecks = Math.max(0, Math.min(Number(config.maxChecks ?? 200), 1000));
  const concurrency = Math.max(1, Math.min(Number(config.concurrency ?? 5), 20));
  const timeoutMs = Math.max(1_000, Math.min(Number(config.timeoutMs ?? 8_000), 30_000));
  const userAgent = String(config.userAgent ?? 'FlowForge-LinkAudit/1.0 (+https://flowforge.io)');
  const scopeFilter = String(config.scope ?? 'all'); // 'all' | 'internal' | 'external'

  const checkable = unique.filter((l) => {
    if (l.scope === 'anchor' || l.scope === 'mailto' || l.scope === 'tel' || l.scope === 'unknown') return false;
    if (!l.resolved) return false;
    if (scopeFilter === 'internal' && l.scope !== 'internal') return false;
    if (scopeFilter === 'external' && l.scope !== 'external') return false;
    return true;
  });
  const targets = checkBroken ? checkable.slice(0, maxChecks) : [];

  const signal = context.abortSignal ?? new AbortController().signal;
  const checked: LinkInfo[] = [];
  if (targets.length > 0) {
    const results = await runWithConcurrency(targets, concurrency, async (link) => {
      const r = await checkLink(link.resolved!, userAgent, timeoutMs, signal);
      const ret: LinkInfo = { ...link, ok: r.ok, durationMs: r.durationMs };
      if (r.status !== undefined) ret.status = r.status;
      if (r.error !== undefined) ret.error = r.error;
      const sev = severityFor(r.status, r.ok);
      if (sev !== undefined) ret.severity = sev;
      return ret;
    });
    for (const r of results) checked.push(r); // no spread-args (RangeError su batch grandi)
  }

  // Merge: for unique links not checked, keep original; for checked use new
  const checkedKey = new Set(checked.map((l) => l.resolved ?? l.href));
  const merged = unique.map((l) => {
    const key = l.resolved ?? l.href;
    return checkedKey.has(key) ? (checked.find((c) => (c.resolved ?? c.href) === key) ?? l) : l;
  });

  const broken = merged.filter((l) => l.ok === false);
  const redirects = merged.filter((l) => typeof l.status === 'number' && l.status >= 300 && l.status < 400);
  const tabnabbingRisks = merged.filter((l) => l.tabnabbingRisk);

  const result: LinkAuditResult = {
    baseUrl: base?.toString() ?? null,
    totalLinks: rawLinks.length,
    uniqueLinks: unique.length,
    checked: checked.length,
    skipped: checkBroken ? Math.max(0, checkable.length - targets.length) : checkable.length,
    byScope,
    summary: {
      total: unique.length,
      internal: byScope.internal ?? 0,
      external: byScope.external ?? 0,
      nofollow: merged.filter((l) => l.nofollow).length,
      sponsored: merged.filter((l) => l.sponsored).length,
      ugc: merged.filter((l) => l.ugc).length,
      broken: broken.length,
      tabnabbingRisks: tabnabbingRisks.length,
    },
    broken,
    brokenCount: broken.length,
    tabnabbingRisks,
    redirects,
    links: merged,
  };

  const warnings: string[] = [];
  if (broken.length > 0) warnings.push(`${broken.length} broken links`);
  if (tabnabbingRisks.length > 0) warnings.push(`${tabnabbingRisks.length} target="_blank" senza rel="noopener" (reverse tabnabbing)`);
  if (!base) warnings.push('No baseUrl: internal/external classification skipped');

  return {
    output: result,
    durationMs: Date.now() - start,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
};

export const linkAuditNode: NodeModule = {
  def: {
    id: 'action_link_audit',
    type: 'action',
    label: 'Link Audit (broken + internal/external)',
    icon: 'link',
    color: '#dc2626',
    description:
      'Audit link su pagina HTML — classifica ogni link in internal (same-origin) / ' +
      'external (cross-domain) / anchor (#frag) / mailto: / tel: / javascript: / ' +
      'data: con dedup canonical URL. Opzionalmente esegue HEAD probe parallelo per ' +
      'identificare link rotti (status >= 400 / DNS fail / timeout / TLS error) con ' +
      'severity classification (404 critical / 5xx warning / 3xx info).\n\n' +
      'Differenza con i sibling: action_link_audit = inventory + probe link su pagina ' +
      '(HTML in → links classified + broken list). Per scoring SEO complessivo che ' +
      'incorpora link health usa action_seo_audit (link ratio nei criteri). Per ' +
      'redirect chain audit del singolo link (multi-hop) usa action_redirect_chain. ' +
      'Per estrazione plain text dei link senza probe usa action_html_select.\n\n' +
      'Probing intelligente: HEAD-first (zero bytes downloaded), fallback automatico ' +
      'a GET no-body se il server rifiuta lo HEAD. Concorrenza bounded (default 5, max ' +
      '20) per non DoS-are il server target. Cap link probati 200 default (config fino ' +
      'a 1000): i primi N link unici in ordine di pagina (campionamento deterministico).\n\n' +
      'Classification SEO-relevant: rel="nofollow" / "sponsored" / "ugc" rilevati per ' +
      'ogni link (Google li tratta diversamente per il link-juice). target="_blank" ' +
      'SENZA rel="noopener"/"noreferrer" → flag tabnabbingRisk (reverse tabnabbing, ' +
      'CWE-1022). Broken links classificati per severity (404/410 critical, 5xx/4xx ' +
      'warning, 3xx info). scope: internal / external / anchor / mailto / tel / data / unknown.\n\n' +
      'Output: `{ summary: { total, internal, external, nofollow, sponsored, ugc, ' +
      'broken, tabnabbingRisks }, byScope, links: [{ href, text, rel, scope, nofollow, ' +
      'sponsored, ugc, targetBlank, noopener, tabnabbingRisk, status?, ok?, severity?, ' +
      'durationMs? }], broken: [...], tabnabbingRisks: [...], redirects: [...], ' +
      'totalLinks, uniqueLinks, checked, skipped }`. broken/tabnabbingRisks pronti per ' +
      'un email digest al content manager.\n\n' +
      'Use case Cappella-Sistina-grade: (1) **audit settimanale broken links** ' +
      'su sito aziendale 100 pagine — cron loop fetch + link_audit con probe → ' +
      'aggregate broken list → email content team con responsabilita\\` per fix; ' +
      '(2) **post-migrazione check** — confronto link inventory pre vs post ' +
      'migration, alert su link che hanno cambiato URL senza redirect; (3) **monitor ' +
      'affiliate/sponsored link** — il partner advertiser cambia URL senza notifica, ' +
      'detect 404 → revenue impact; (4) **rel="noopener" security audit** — ' +
      'target="_blank" senza noopener = XS-Leaks vulnerability, fix automatico in ' +
      'CMS via webhook.\n\n' +
      'Safety budget: SSRF guard, concorrenza max 20, timeout 8s per probe, hard ' +
      'cap 200 link probati (config 1000), audit log con linksTotal + broken count ' +
      'per detect site degradation trends.',
    vendor: 'flowforge',
    version: '1.0.0',
    configFields: [
      {
        key: 'baseUrl',
        label: 'Base URL (per classificare internal/external)',
        type: 'text',
        required: false,
        placeholder: 'https://miosito.com — lascia vuoto se ricevi {url, body} dal nodo precedente',
        help: 'Origine di riferimento. Se il nodo precedente è web_fetch_advanced viene preso automaticamente dal payload.',
      },
      {
        key: 'checkBroken',
        label: 'Verifica link rotti (HEAD parallelo)',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help: 'Se ON fa una HEAD request per ogni link unique. Se OFF restituisce solo conteggi/classificazione (molto più veloce).',
      },
      {
        key: 'scope',
        label: 'Filtra scope da verificare',
        type: 'select',
        required: false,
        options: ['all', 'internal', 'external'],
        defaultValue: 'all',
        help: 'all = controlla TUTTI i link http(s). internal = solo stesso host. external = solo host diversi.',
      },
      {
        key: 'maxChecks',
        label: 'Max link verificati',
        type: 'number',
        required: false,
        defaultValue: '200',
        help: 'Hard cap default 200, massimo 1000. Limita carico di rete e tempo esecuzione.',
      },
      {
        key: 'concurrency',
        label: 'Concorrenza richieste',
        type: 'number',
        required: false,
        defaultValue: '5',
        help: 'Numero di richieste parallele. Default 5, max 20.',
      },
      {
        key: 'timeoutMs',
        label: 'Timeout per request (ms)',
        type: 'number',
        required: false,
        defaultValue: '8000',
        help: 'Default 8000 ms. Min 1000, max 30000.',
      },
      {
        key: 'userAgent',
        label: 'User-Agent',
        type: 'text',
        required: false,
        placeholder: 'FlowForge-LinkAudit/1.0',
        help: 'User-Agent identificativo. Default identifica FlowForge.',
      },
    ],
    outputs: ['baseUrl', 'totalLinks', 'uniqueLinks', 'checked', 'skipped', 'byScope', 'summary', 'broken', 'brokenCount', 'tabnabbingRisks', 'redirects', 'links'],
  },
  executor,
};
