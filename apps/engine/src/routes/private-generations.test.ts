import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger.js');

// Stub del service (hoisted: accessibile dentro la factory del mock).
const stub = vi.hoisted(() => ({
  save: vi.fn(),
  rate: vi.fn(),
  list: vi.fn(),
}));
vi.mock('../services/private-generations/index.js', () => ({
  createPrivateGenerationsService: () => stub,
}));

const binaryStub = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../services/binary-store.service.js', () => ({
  getBinaryStore: () => binaryStub,
}));

import { createPrivateGenerationsRoutes } from './private-generations.js';
import { jsonBody } from '@/lib/test-json-body.js';

const TOKEN = 'test-internal-token';
const app = createPrivateGenerationsRoutes();

function req(path: string, init: RequestInit & { token?: string | null } = {}) {
  const headers = new Headers(init.headers);
  if (init.token !== null) headers.set('x-internal-token', init.token ?? TOKEN);
  if (init.body) headers.set('content-type', 'application/json');
  return app.request(path, { ...init, headers });
}

beforeEach(() => {
  process.env.MEDEA_INTERNAL_TOKEN = TOKEN;
  stub.save.mockReset().mockResolvedValue({ id: 'g1', mediaRef: 'b'.repeat(64), size: 8 });
  stub.rate.mockReset().mockResolvedValue(undefined);
  stub.list.mockReset().mockResolvedValue([{ id: 'g1', rating: 'up' }]);
  binaryStub.read.mockReset();
});

const validSave = JSON.stringify({
  kind: 'image',
  prompt: 'a cat',
  mime: 'image/png',
  dataBase64: Buffer.from('PNG-DATA').toString('base64'),
});

describe('gate internal-token (fail-closed)', () => {
  it('senza header → 401, service NON chiamato', async () => {
    const res = await req('/internal/private-gen/save', {
      method: 'POST',
      body: validSave,
      token: null,
    });
    expect(res.status).toBe(401);
    expect(stub.save).not.toHaveBeenCalled();
  });
  it('token errato → 401', async () => {
    const res = await req('/internal/private-gen/save', {
      method: 'POST',
      body: validSave,
      token: 'wrong',
    });
    expect(res.status).toBe(401);
  });
});

describe('POST save', () => {
  it('happy → 201 + decodifica i byte base64 e li passa al service', async () => {
    const res = await req('/internal/private-gen/save', { method: 'POST', body: validSave });
    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body).toMatchObject({ ok: true, id: 'g1' });
    const arg = stub.save.mock.calls[0]![0] as { bytes: Buffer; kind: string };
    expect(arg.bytes.toString()).toBe('PNG-DATA');
    expect(arg.kind).toBe('image');
  });

  it('base64 che decodifica a 0 byte → 400, service NON chiamato', async () => {
    const body = JSON.stringify({ kind: 'image', prompt: 'x', mime: 'image/png', dataBase64: '=' });
    const res = await req('/internal/private-gen/save', { method: 'POST', body });
    expect(res.status).toBe(400);
    expect(stub.save).not.toHaveBeenCalled();
  });

  it('prompt mancante → 400 (zod)', async () => {
    const body = JSON.stringify({ kind: 'image', mime: 'image/png', dataBase64: 'QQ==' });
    const res = await req('/internal/private-gen/save', { method: 'POST', body });
    expect(res.status).toBe(400);
  });

  it('kind non valido → 400 (zod)', async () => {
    const body = JSON.stringify({ kind: 'audio', prompt: 'x', mime: 'a/b', dataBase64: 'QQ==' });
    const res = await req('/internal/private-gen/save', { method: 'POST', body });
    expect(res.status).toBe(400);
  });

  it('errore del service → 500 (non leak)', async () => {
    stub.save.mockRejectedValueOnce(new Error('db down'));
    const res = await req('/internal/private-gen/save', { method: 'POST', body: validSave });
    expect(res.status).toBe(500);
    expect((await jsonBody(res)).error).not.toContain('db down');
  });
});

describe('POST rate', () => {
  it('rating valido → 200', async () => {
    const res = await req('/internal/private-gen/rate', {
      method: 'POST',
      body: JSON.stringify({ id: 'g1', rating: 'up' }),
    });
    expect(res.status).toBe(200);
    expect(stub.rate).toHaveBeenCalledWith('g1', 'up');
  });
  it('rating null → 200 (azzera voto)', async () => {
    const res = await req('/internal/private-gen/rate', {
      method: 'POST',
      body: JSON.stringify({ id: 'g1', rating: null }),
    });
    expect(res.status).toBe(200);
    expect(stub.rate).toHaveBeenCalledWith('g1', null);
  });
  it('rating arbitrario → 400 (zod), service NON chiamato', async () => {
    const res = await req('/internal/private-gen/rate', {
      method: 'POST',
      body: JSON.stringify({ id: 'g1', rating: 'love' }),
    });
    expect(res.status).toBe(400);
    expect(stub.rate).not.toHaveBeenCalled();
  });
});

describe('GET list / media', () => {
  it('list → 200 con items', async () => {
    const res = await req('/internal/private-gen/list?limit=10', { method: 'GET' });
    expect(res.status).toBe(200);
    expect((await jsonBody(res)).items).toHaveLength(1);
  });
  it('media ref valido → byte + content-type', async () => {
    binaryStub.read.mockResolvedValueOnce(Buffer.from('IMG'));
    const res = await req('/internal/private-gen/media/' + 'a'.repeat(64) + '?mime=image/png', {
      method: 'GET',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('IMG');
  });
  it('media ref invalido (store throw) → 404', async () => {
    binaryStub.read.mockRejectedValueOnce(new Error('bad ref'));
    const res = await req('/internal/private-gen/media/not-a-ref', { method: 'GET' });
    expect(res.status).toBe(404);
  });
});
