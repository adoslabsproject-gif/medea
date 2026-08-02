/**
 * Bug-bounty test — fetch_url NON deve passare a Liara la pagina di WAKE del
 * tenant ("Avvio del workspace…").
 *
 * Incidente owner 2026-06-13: nel chatter del workflow, dare a Liara un URL
 * `*.app.automazionezeli.com` di un container in pausa faceva sì che fetch_url
 * scaricasse la pagina di wake e la passasse come "contenuto del sito" → Liara
 * leggeva spazzatura e l'utente vedeva l'errore di wake nella chat.
 *
 * NIENTE greensmoke: usiamo la WAKE HTML REALE (servita da nginx @waking) e
 * verifichiamo che fetchUrl lanci WorkspaceWakingError — e che una pagina NORMALE
 * continui a funzionare (anti-regressione) e che l'SSRF guard resti intatta.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const safeFetchMock = vi.hoisted(() => ({
  validateUrlForFetch: vi.fn((_url: string) => ({ ok: true })),
}));
vi.mock('@medea/engine-safe-fetch', async (importOriginal) => ({ ...(await importOriginal<typeof import('@medea/engine-safe-fetch')>()), ...safeFetchMock }));
vi.mock('@/lib/logger.js');

import { fetchUrl, isWorkspaceWakePage, WorkspaceWakingError } from './web-tools.service.js';
import { clearBreakerRegistry } from '@medea/engine-nodes-stdlib';

/** La pagina di wake REALE servita da nginx @waking (copiata 1:1 dall'incidente). */
const WAKE_HTML = `<!doctype html> <html lang="it"><head> <meta charset="utf-8"> <meta http-equiv="refresh" content="1"> <meta name="viewport" content="width=device-width, initial-scale=1"> <meta name="robots" content="noindex, nofollow"> <title>Avvio del workspace…</title> <style> html,body{margin:0;height:100%;background:#0b0b0d;color:#f4f4f5} </style></head> <body><div class="wrap"> <div class="spinner" aria-hidden="true"></div> <p>Avvio del workspace in corso…</p> <p class="sub">Il tuo ambiente si era messo in pausa. Riparte in pochi secondi — questa pagina si aggiorna da sola.</p> </div></body></html>`;

/** Testo COME estratto dopo cheerio/jina (solo il body, niente tag). */
const WAKE_EXTRACTED = 'Avvio del workspace in corso… Il tuo ambiente si era messo in pausa. Riparte in pochi secondi — questa pagina si aggiorna da sola.';

function mockFetchResponse(opts: { status?: number; contentType?: string; body?: string }): Response {
  return new Response(opts.body ?? '', {
    status: opts.status ?? 200,
    headers: new Headers({ 'content-type': opts.contentType ?? 'text/html' }),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  clearBreakerRegistry();
  safeFetchMock.validateUrlForFetch.mockReset();
  safeFetchMock.validateUrlForFetch.mockImplementation(() => ({ ok: true }));
  for (const k of ['FIRECRAWL_API_KEY', 'JINA_READER_KEY']) delete process.env[k];
});
afterEach(() => { vi.restoreAllMocks(); });

describe('isWorkspaceWakePage', () => {
  it('🎯 HTML di wake REALE → true', () => {
    expect(isWorkspaceWakePage(WAKE_HTML)).toBe(true);
  });
  it('🎯 testo ESTRATTO dalla wake → true (è il caso che arriva a Liara)', () => {
    expect(isWorkspaceWakePage(WAKE_EXTRACTED)).toBe(true);
  });
  it('titolo wake + status 503 @waking (senza il testo forte) → true', () => {
    expect(isWorkspaceWakePage('<title>Avvio del workspace…</title>', 503)).toBe(true);
  });
  it('🎯 SOLO il marker forte "messo in pausa" (niente titolo, niente Riparte, status 200) → true', () => {
    // isola la condizione `hasStrong`: niente "Avvio del workspace", niente "Riparte".
    expect(isWorkspaceWakePage('Nota: il tuo ambiente si era messo in pausa.', 200)).toBe(true);
  });
  it('🔒 NO falso positivo: articolo che cita "avvio del workspace" senza pausa, status 200 → false', () => {
    expect(isWorkspaceWakePage('Guida: avvio del workspace su Linux, passo per passo.', 200)).toBe(false);
  });
  it('🔒 NO falso positivo: contenuto normale di un sito → false', () => {
    expect(isWorkspaceWakePage('Benvenuto nel nostro e-commerce di scarpe. Spedizione gratuita.')).toBe(false);
  });
});

describe('fetchUrl — wake page detection (end-to-end via mock fetch)', () => {
  it('🚨 URL che torna la wake page (200 text/html) → WorkspaceWakingError, NON la passa', async () => {
    global.fetch = vi.fn().mockResolvedValue(mockFetchResponse({ body: WAKE_HTML, contentType: 'text/html' })) as never;
    await expect(fetchUrl('https://nicola-cucurachi.app.automazionezeli.com/x')).rejects.toThrow(WorkspaceWakingError);
  });

  it('🚨 wake servita con 503 @waking → WorkspaceWakingError', async () => {
    global.fetch = vi.fn().mockResolvedValue(mockFetchResponse({ status: 503, body: WAKE_HTML, contentType: 'text/html' })) as never;
    await expect(fetchUrl('https://slug.app.automazionezeli.com/y')).rejects.toThrow(/wake|in pausa/i);
  });

  it('✅ ANTI-REGRESSIONE: una pagina NORMALE NON viene scambiata per wake → ritorna il contenuto', async () => {
    const html = '<html><body><article><h1>Ricette</h1><p>' + 'Pasta al pomodoro: ingredienti e preparazione passo per passo. '.repeat(5) + '</p></article></body></html>';
    global.fetch = vi.fn().mockResolvedValue(mockFetchResponse({ body: html, contentType: 'text/html' })) as never;
    const res = await fetchUrl('https://ricette.example.com/pasta');
    expect(res.content).toContain('Pasta al pomodoro');
  });

  it('🔒 ANTI-REGRESSIONE: SSRF guard resta intatta (host interno → throw SSRF, non wake)', async () => {
    await expect(fetchUrl('http://127.0.0.1/admin')).rejects.toThrow(/SSRF/);
  });
});
