/**
 * Test bug-bounty — action_link_audit (network mockato).
 * Copre: classificazione scope (incl. data:), rel nofollow/sponsored/ugc,
 * target=_blank → tabnabbing, severity dei broken, summary, dedup, SSRF.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { safeFetchWithRedirects, SsrfBlockedError } from '@flowforge/safe-fetch';
import { linkAuditNode } from './link-audit.js';

vi.mock('@flowforge/safe-fetch', () => {
  class SsrfBlockedError extends Error {}
  return { SsrfBlockedError, safeFetchWithRedirects: vi.fn() };
});

const CTX = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} } as never;
const mockFetch = vi.mocked(safeFetchWithRedirects);
const exec = linkAuditNode.executor!;

function fakeRes(status: number): Response {
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: () => null },
    body: { cancel: () => undefined },
  } as unknown as Response;
}

beforeEach(() => { mockFetch.mockReset(); });

describe('link_audit — classificazione (no probe)', () => {
  const html = `<html><body>
    <a href="/interna">i</a>
    <a href="https://altro.com/x">e</a>
    <a href="#sezione">anchor</a>
    <a href="mailto:a@b.c">mail</a>
    <a href="tel:+39000">tel</a>
    <a href="data:text/plain,ciao">data</a>
  </body></html>`;

  it('scope: internal/external/anchor/mailto/tel/data classificati', async () => {
    const r = await exec({ checkBroken: false }, { body: html, url: 'https://mio.com/' }, CTX);
    const out = r.output as { byScope: Record<string, number>; summary: { internal: number; external: number } };
    expect(out.byScope.internal).toBe(1);
    expect(out.byScope.external).toBe(1);
    expect(out.byScope.anchor).toBe(1);
    expect(out.byScope.mailto).toBe(1);
    expect(out.byScope.tel).toBe(1);
    expect(out.byScope.data).toBe(1);
  });
});

describe('link_audit — rel + target (SEO/security)', () => {
  it('🚨 rel nofollow/sponsored/ugc rilevati per ogni link', async () => {
    const html = `<html><body>
      <a href="https://x.com/a" rel="nofollow">a</a>
      <a href="https://x.com/b" rel="sponsored noopener">b</a>
      <a href="https://x.com/c" rel="ugc">c</a>
    </body></html>`;
    const r = await exec({ checkBroken: false }, { body: html, url: 'https://mio.com/' }, CTX);
    const out = r.output as { summary: { nofollow: number; sponsored: number; ugc: number } };
    expect(out.summary.nofollow).toBe(1);
    expect(out.summary.sponsored).toBe(1);
    expect(out.summary.ugc).toBe(1);
  });

  it('🚨 target="_blank" SENZA noopener → tabnabbingRisk; CON noopener → no', async () => {
    const html = `<html><body>
      <a href="https://x.com/unsafe" target="_blank">unsafe</a>
      <a href="https://x.com/safe" target="_blank" rel="noopener">safe</a>
      <a href="https://x.com/safe2" target="_blank" rel="noreferrer">safe2</a>
    </body></html>`;
    const r = await exec({ checkBroken: false }, { body: html, url: 'https://mio.com/' }, CTX);
    const out = r.output as { tabnabbingRisks: { href: string }[]; summary: { tabnabbingRisks: number } };
    // MUTATION: senza il flag tabnabbingRisk la lista sarebbe vuota.
    expect(out.summary.tabnabbingRisks).toBe(1);
    expect(out.tabnabbingRisks[0]?.href).toBe('https://x.com/unsafe');
  });
});

describe('link_audit — probe + severity', () => {
  it('🚨 severity: 404 critical, 500 warning, 301 info', async () => {
    const html = `<html><body>
      <a href="https://x.com/404">a</a>
      <a href="https://x.com/500">b</a>
      <a href="https://x.com/301">c</a>
      <a href="https://x.com/ok">d</a>
    </body></html>`;
    mockFetch.mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.endsWith('/404')) return Promise.resolve(fakeRes(404));
      if (u.endsWith('/500')) return Promise.resolve(fakeRes(500));
      if (u.endsWith('/301')) return Promise.resolve(fakeRes(301));
      return Promise.resolve(fakeRes(200));
    });
    const r = await exec({ checkBroken: true }, { body: html, url: 'https://mio.com/' }, CTX);
    const out = r.output as { links: { href: string; severity?: string; status?: number }[]; broken: unknown[] };
    const byHref = (h: string): { severity?: string } | undefined => out.links.find((l) => l.href === h);
    expect(byHref('https://x.com/404')?.severity).toBe('critical');
    expect(byHref('https://x.com/500')?.severity).toBe('warning');
    // 301 con redirect:follow nel mock ritorna 301 → ok=false → severity info
    expect(byHref('https://x.com/301')?.severity).toBe('info');
    expect(byHref('https://x.com/ok')?.severity).toBeUndefined();
  });

  it('SSRF su un link → marcato non-ok, niente crash', async () => {
    const html = `<a href="https://169.254.169.254/meta">x</a>`;
    mockFetch.mockImplementation(() => Promise.reject(new SsrfBlockedError('blocked')));
    const r = await exec({ checkBroken: true }, { body: html, url: 'https://mio.com/' }, CTX);
    const out = r.output as { broken: { error?: string }[]; brokenCount: number };
    expect(out.brokenCount).toBe(1);
    expect(out.broken[0]?.error).toBe('SSRF blocked');
  });

  it('checkBroken=false → nessuna fetch', async () => {
    const html = `<a href="https://x.com/a">a</a>`;
    await exec({ checkBroken: false }, { body: html, url: 'https://mio.com/' }, CTX);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('dedup per URL risolto: lo stesso link 2× contato 1', async () => {
    const html = `<a href="/p">1</a><a href="/p">2</a>`;
    const r = await exec({ checkBroken: false }, { body: html, url: 'https://mio.com/' }, CTX);
    const out = r.output as { totalLinks: number; uniqueLinks: number };
    expect(out.totalLinks).toBe(2);
    expect(out.uniqueLinks).toBe(1);
  });

  it('input HTML vuoto → warning, no crash', async () => {
    const r = await exec({ checkBroken: false }, '', CTX);
    expect((r.output as { warnings: string[] }).warnings).toContain('Empty HTML input');
  });
});
