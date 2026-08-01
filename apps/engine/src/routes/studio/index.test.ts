import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger.js');

const TOKEN = 'a'.repeat(32);
const fsMock = vi.hoisted(() => ({ readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn() }));
vi.mock('node:fs/promises', () => fsMock);

const svc = vi.hoisted(() => ({ save: vi.fn(), rate: vi.fn(), list: vi.fn(), conversations: vi.fn(), getForExtend: vi.fn() }));
vi.mock('../../services/private-generations/index.js', () => ({ createPrivateGenerationsService: () => svc }));

import { createStudioRoutes } from './index.js';

const app = createStudioRoutes();

function req(path: string, init: RequestInit & { cookie?: boolean } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('cookie', `gs_studio=${TOKEN}`);
  if (init.body) headers.set('content-type', 'application/json');
  return app.request(path, { ...init, headers });
}

beforeEach(() => {
  fsMock.readFile.mockReset().mockResolvedValue(TOKEN);
  fsMock.writeFile.mockReset().mockResolvedValue(undefined);
  fsMock.mkdir.mockReset().mockResolvedValue(undefined);
  svc.rate.mockReset().mockResolvedValue(undefined);
  svc.conversations.mockReset().mockResolvedValue([]);
  svc.getForExtend.mockReset().mockResolvedValue(null);
});

describe('gate token-nell-URL (come webhook, niente login)', () => {
  it('GET /studio/<token-errato> → 404 (stealth)', async () => {
    const r = await req('/studio/' + 'b'.repeat(32));
    expect(r.status).toBe(404);
  });
  it('GET /studio/<token-giusto> → 200 html + Set-Cookie', async () => {
    const r = await req('/studio/' + TOKEN);
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toContain('gs_studio=');
    expect(r.headers.get('set-cookie')).toContain('HttpOnly');
    expect(await r.text()).toContain('<title>Studio</title>');
  });
  it('POST /studio/generate senza cookie → 401', async () => {
    const r = await req('/studio/generate', { method: 'POST', body: '{}' });
    expect(r.status).toBe(401);
  });
});

describe('validazione generate (prima di ComfyUI)', () => {
  it('sdxl senza prompt → 400', async () => {
    const r = await req('/studio/generate', { method: 'POST', cookie: true, body: JSON.stringify({ mode: 'sdxl', checkpoint: 'm' }) });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/prompt/);
  });
  it('sdxl senza checkpoint → 400', async () => {
    const r = await req('/studio/generate', { method: 'POST', cookie: true, body: JSON.stringify({ mode: 'sdxl', prompt: 'cat' }) });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/checkpoint/);
  });
  it('custom con grafo JSON invalido → 400', async () => {
    const r = await req('/studio/generate', { method: 'POST', cookie: true, body: JSON.stringify({ mode: 'custom', graphJson: '{bad' }) });
    expect(r.status).toBe(400);
  });
});

describe('rate', () => {
  it('rating valido → service.rate', async () => {
    const r = await req('/studio/rate', { method: 'POST', cookie: true, body: JSON.stringify({ id: 'g1', rating: 'up' }) });
    expect(r.status).toBe(200);
    expect(svc.rate).toHaveBeenCalledWith('g1', 'up');
  });
  it('rating arbitrario → 400, service NON chiamato', async () => {
    const r = await req('/studio/rate', { method: 'POST', cookie: true, body: JSON.stringify({ id: 'g1', rating: 'love' }) });
    expect(r.status).toBe(400);
    expect(svc.rate).not.toHaveBeenCalled();
  });
  it('senza cookie → 401', async () => {
    const r = await req('/studio/rate', { method: 'POST', body: JSON.stringify({ id: 'g1', rating: 'up' }) });
    expect(r.status).toBe(401);
  });
});

describe('media gate', () => {
  it('senza cookie → 401', async () => {
    const r = await req('/studio/media/' + 'a'.repeat(64));
    expect(r.status).toBe(401);
  });
});

describe('🔒 ordine route: /studio/conversations NON oscurata da /studio/:token (bug 2026-06-18)', () => {
  it('GET /studio/conversations senza cookie → 401 (route raggiunta, NON 404)', async () => {
    const r = await req('/studio/conversations');
    expect(r.status).toBe(401); // se fosse oscurata da :token → 404
    expect(r.status).not.toBe(404);
  });

  it('GET /studio/conversations con cookie → 200 + lista (handler raggiunto, non il catch-all token)', async () => {
    svc.conversations.mockResolvedValueOnce([{ id: 'c1', count: 2, lastAt: 't', title: 'x' }]);
    const r = await req('/studio/conversations', { cookie: true });
    expect(r.status).toBe(200);
    const j = await r.json() as { ok: boolean; items: unknown[] };
    expect(j.ok).toBe(true);
    expect(j.items).toHaveLength(1);
    expect(svc.conversations).toHaveBeenCalled();
  });
});

describe('extend (estendi video)', () => {
  it('senza cookie → 401', async () => {
    const r = await req('/studio/extend/gen-1', { method: 'POST', body: '{}' });
    expect(r.status).toBe(401);
  });
  it('generazione non trovata → 404', async () => {
    svc.getForExtend.mockResolvedValue(null);
    const r = await req('/studio/extend/gen-1', { method: 'POST', cookie: true, body: '{}' });
    expect(r.status).toBe(404);
  });
  it('non è un video (immagine) → 400, niente submit', async () => {
    svc.getForExtend.mockResolvedValue({ prompt: 'p', mime: 'image/png', kind: 'image', params: {}, bytes: Buffer.from('x') });
    const r = await req('/studio/extend/gen-1', { method: 'POST', cookie: true, body: '{}' });
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toMatch(/video/);
  });
  it('prompt di continuazione troppo lungo (>2000) → 400 (validazione)', async () => {
    svc.getForExtend.mockResolvedValue({ prompt: 'p', mime: 'video/mp4', kind: 'video', params: {}, bytes: Buffer.from('x') });
    const r = await req('/studio/extend/gen-1', { method: 'POST', cookie: true, body: JSON.stringify({ prompt: 'x'.repeat(2001) }) });
    expect(r.status).toBe(400);
  });
});

describe('extend-upload (continua un mp4 caricato)', () => {
  it('senza cookie → 401', async () => {
    const r = await req('/studio/extend-upload', { method: 'POST', body: JSON.stringify({ videoB64: 'data:video/mp4;base64,AAAA' }) });
    expect(r.status).toBe(401);
  });
  it('senza videoB64 → 400 (validazione)', async () => {
    const r = await req('/studio/extend-upload', { method: 'POST', cookie: true, body: JSON.stringify({ prompt: 'continua' }) });
    expect(r.status).toBe(400);
  });
  it('videoB64 troppo corto (non un mp4) → 400, niente submit', async () => {
    const r = await req('/studio/extend-upload', { method: 'POST', cookie: true, body: JSON.stringify({ videoB64: 'data:video/mp4;base64,AAAA' }) });
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toMatch(/video/);
  });
});

describe('cancel (tasto Stop)', () => {
  it('senza cookie → 401', async () => {
    const r = await req('/studio/cancel/job-1', { method: 'POST' });
    expect(r.status).toBe(401);
  });

  it('con cookie → 200 + interrompe ComfyUI (queue delete + interrupt)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const r = await req('/studio/cancel/job-123', { method: 'POST', cookie: true });
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith('/queue'))).toBe(true);
    expect(urls.some((u) => u.endsWith('/interrupt'))).toBe(true);
    vi.unstubAllGlobals();
  });

  it('ComfyUI irraggiungibile → comunque 200 (best-effort: libera la UI)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const r = await req('/studio/cancel/job-x', { method: 'POST', cookie: true });
    expect(r.status).toBe(200);
    vi.unstubAllGlobals();
  });
});
