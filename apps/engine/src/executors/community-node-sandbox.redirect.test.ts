/**
 * Bug-bounty test — hostFetch segue i redirect RI-VALIDANDO ogni hop (SSRF-safe).
 *
 * Incidente owner 2026-06-14: il workflow Streammy falliva con
 * "SSRF blocked: redirect non permesso (status=301)" — il sandbox bloccava
 * QUALSIASI redirect. I 301/302 sono normali sul web. Ora li seguiamo, ma ogni
 * Location passa per validateUrlForFetch: un 302 verso 127.0.0.1 resta bloccato.
 *
 * Test diretto su hostFetch (mock safeOutboundFetch + validateUrlForFetch).
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';

beforeAll(() => { process.env.FLOWFORGE_SANDBOX_DISABLE_WORKER = 'true'; });

const m = vi.hoisted(() => ({ safeFetch: vi.fn(), validate: vi.fn() }));
vi.mock('@/lib/safe-outbound-fetch.js', () => ({ safeOutboundFetch: (...a: unknown[]) => m.safeFetch(...a) }));
vi.mock('@flowforge/safe-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@flowforge/safe-fetch')>()), validateUrlForFetch: (...a: unknown[]) => m.validate(...a) }));
vi.mock('@/lib/logger.js');

const { hostFetch } = await import('./community-node-sandbox.js');

function resp(status: number, opts: { location?: string; body?: string } = {}): unknown {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (k: string) => (opts.location && k.toLowerCase() === 'location' ? opts.location : null),
      forEach: (cb: (v: string, k: string) => void) => { cb('text/html', 'content-type'); },
    },
    arrayBuffer: async () => new TextEncoder().encode(opts.body ?? '').buffer,
  };
}

beforeEach(() => { vi.clearAllMocks(); m.validate.mockReturnValue({ ok: true }); });

describe('hostFetch — redirect SSRF-safe', () => {
  it('✅ 301 verso host SAFE → SEGUITO, ritorna il body finale (il bug Streammy)', async () => {
    m.safeFetch
      .mockResolvedValueOnce(resp(301, { location: 'https://new.example.com/x' }))
      .mockResolvedValueOnce(resp(200, { body: 'CONTENUTO' }));
    const r = await hostFetch('https://old.example.com/x');
    expect(r.status).toBe(200);
    expect(r.bodyText).toBe('CONTENUTO');
    expect(String(m.safeFetch.mock.calls[1]![0])).toBe('https://new.example.com/x'); // ha SEGUITO
  });

  it('🔒 redirect verso host PRIVATO → SSRF blocked (validateUrlForFetch ok=false)', async () => {
    m.safeFetch.mockResolvedValueOnce(resp(302, { location: 'http://127.0.0.1:6379' }));
    m.validate.mockReturnValue({ ok: false, reason: 'private_ip' });
    await expect(hostFetch('https://evil.example.com')).rejects.toThrow(/SSRF blocked/);
  });

  it('🔒 catena di redirect > 5 hop → throw (no loop infinito)', async () => {
    m.safeFetch.mockResolvedValue(resp(301, { location: 'https://loop.example.com' }));
    await expect(hostFetch('https://start.example.com')).rejects.toThrow(/troppi redirect/i);
  });

  it('200 diretto → ritorna subito (1 sola fetch, niente get(location))', async () => {
    m.safeFetch.mockResolvedValueOnce(resp(200, { body: 'OK' }));
    const r = await hostFetch('https://example.com');
    expect(r.bodyText).toBe('OK');
    expect(m.safeFetch).toHaveBeenCalledTimes(1);
  });

  it('3xx SENZA Location → trattato come risposta finale (no throw, no hop)', async () => {
    m.safeFetch.mockResolvedValueOnce(resp(304));
    const r = await hostFetch('https://example.com');
    expect(r.status).toBe(304);
    expect(m.safeFetch).toHaveBeenCalledTimes(1);
  });

  it('🔒 catena multi-hop safe (A→B→C) entro il limite → segue fino a 200', async () => {
    m.safeFetch
      .mockResolvedValueOnce(resp(301, { location: 'https://b.example.com' }))
      .mockResolvedValueOnce(resp(302, { location: 'https://c.example.com' }))
      .mockResolvedValueOnce(resp(200, { body: 'C' }));
    const r = await hostFetch('https://a.example.com');
    expect(r.bodyText).toBe('C');
    expect(m.safeFetch).toHaveBeenCalledTimes(3);
  });
});

// ── ANTI-DRIFT: il path WORKER (PRODUZIONE) deve comportarsi come l'inline ──────
// Il test sopra copre l'INLINE (hostFetch di community-node-sandbox.ts). Ma in
// PRODUZIONE gira il WORKER (community-node-sandbox.worker.ts), che era rimasto col
// hard-reject "redirect non permesso" anche dopo il fix inline del 14/6 → streammy
// continuava a dare NO_LIVE_HOST (5/6 domini rispondono con un 3xx al mirror). Il
// worker throwa su import fuori da un worker_thread, quindi non è unit-testabile:
// questo contract source-scan pretende la PARITÀ dell'algoritmo, così un fix su un
// solo path non passa più (la causa-radice è la DUPLICAZIONE worker↔inline).
describe('🔒 ANTI-DRIFT worker↔inline — redirect SSRF-safe in ENTRAMBI i path', () => {
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8');
  const workerSrc = read('./community-node-sandbox.worker.ts');
  const inlineSrc = read('./community-node-sandbox.ts');

  it('il WORKER NON rifiuta più ogni 3xx (no hard-reject "redirect non permesso")', () => {
    expect(workerSrc).not.toMatch(/redirect non permesso/u);
  });

  it('il WORKER segue i redirect RI-VALIDANDO ogni Location (validateUrlForFetch) + cap hop', () => {
    expect(workerSrc).toMatch(/validateUrlForFetch\(next\)/u);
    expect(workerSrc).toMatch(/MAX_REDIRECTS/u);
    expect(workerSrc).toMatch(/res\.status < 300 \|\| res\.status >= 400/u); // break su risposta finale
  });

  it("l'INLINE mantiene lo stesso algoritmo safe-follow (parità di riferimento)", () => {
    expect(inlineSrc).toMatch(/validateUrlForFetch\(next\)/u);
    expect(inlineSrc).toMatch(/MAX_REDIRECTS/u);
  });
});
