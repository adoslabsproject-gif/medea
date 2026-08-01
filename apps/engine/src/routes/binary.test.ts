/**
 * Binary download route — bug-bounty (gap #6 masterplan).
 *
 * Focus sicurezza:
 *   • ref non-sha256 → 400 (anti path-traversal, delega al BinaryStore)
 *   • blob assente → 404
 *   • Content-Length = size REALE dal server (mai dal client)
 *   • Anti-XSS: inline SOLO per immagini raster allowlisted; svg/html/pdf →
 *     octet-stream + attachment; nosniff sempre
 *   • fileName sanitizzato (no CRLF injection nell'header)
 */
import type * as BinaryStoreServiceNS from './../services/binary-store.service.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

const storeMock = vi.hoisted(() => ({
  size: vi.fn(),
  readStream: vi.fn(),
}));

vi.mock('@/services/binary-store.service.js', async () => {
  const actual = await vi.importActual<typeof BinaryStoreServiceNS>(
    './../services/binary-store.service.js',
  );
  return {
    ...actual,
    getBinaryStore: () => storeMock,
  };
});

vi.mock('@/lib/logger.js');

import { createBinaryRoutes } from './binary.js';
import { InvalidBinaryRefError, BinaryNotFoundError } from './../services/binary-store.service.js';

const VALID_REF = 'a'.repeat(64);
const PAYLOAD = Buffer.from('hello-binary-bytes');

beforeEach(() => {
  storeMock.size.mockReset();
  storeMock.readStream.mockReset();
  storeMock.size.mockResolvedValue(PAYLOAD.byteLength);
  storeMock.readStream.mockReturnValue(Readable.from([PAYLOAD]));
});

function app(): ReturnType<typeof createBinaryRoutes> {
  return createBinaryRoutes();
}

describe('GET /binary/:ref — validazione + errori', () => {
  it('ref non-sha256 → 400 (anti-traversal, lo store lo rifiuta)', async () => {
    storeMock.size.mockRejectedValue(new InvalidBinaryRefError('../../etc/passwd'));
    const res = await app().request('/binary/..%2F..%2Fetc%2Fpasswd');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid binary ref' });
    // Non deve nemmeno provare a leggere
    expect(storeMock.readStream).not.toHaveBeenCalled();
  });

  it('blob assente → 404', async () => {
    storeMock.size.mockRejectedValue(new BinaryNotFoundError(VALID_REF));
    const res = await app().request(`/binary/${VALID_REF}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Binary not found' });
  });

  it('errore generico dello store → 500', async () => {
    storeMock.size.mockRejectedValue(new Error('disk on fire'));
    const res = await app().request(`/binary/${VALID_REF}`);
    expect(res.status).toBe(500);
  });
});

describe('GET /binary/:ref — headers sicuri + streaming', () => {
  it('default: octet-stream + attachment + nosniff + Content-Length reale', async () => {
    const res = await app().request(`/binary/${VALID_REF}?name=report.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-length')).toBe(String(PAYLOAD.byteLength));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-disposition')).toContain('report.pdf');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(PAYLOAD)).toBe(true);
  });

  it('🚨 Content-Length NON è falsificabile dal client (size dal server)', async () => {
    storeMock.size.mockResolvedValue(PAYLOAD.byteLength);
    // Il client non ha modo di passare size: l'header viene dallo store.
    const res = await app().request(`/binary/${VALID_REF}?name=x&mime=image/png`);
    expect(res.headers.get('content-length')).toBe(String(PAYLOAD.byteLength));
  });

  it('immagine raster + inline=1 → servita inline col mime reale', async () => {
    const res = await app().request(`/binary/${VALID_REF}?inline=1&mime=image/png&name=foto.png`);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toContain('inline');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('🚨 svg + inline=1 → NON inline (octet-stream + attachment): anti-XSS', async () => {
    const res = await app().request(`/binary/${VALID_REF}?inline=1&mime=image/svg+xml&name=evil.svg`);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toContain('attachment');
  });

  it('🚨 text/html + inline=1 → NON inline (anti-XSS)', async () => {
    const res = await app().request(`/binary/${VALID_REF}?inline=1&mime=text/html&name=x.html`);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toContain('attachment');
  });

  it('🚨 application/pdf + inline=1 → NON inline (solo immagini raster sono allowlisted)', async () => {
    const res = await app().request(`/binary/${VALID_REF}?inline=1&mime=application/pdf`);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toContain('attachment');
  });

  it('mime immagine ma SENZA inline=1 → resta attachment (download)', async () => {
    const res = await app().request(`/binary/${VALID_REF}?mime=image/png`);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toContain('attachment');
  });

  it('🚨 fileName con CRLF → sanitizzato (no header injection)', async () => {
    const evil = 'a\r\nSet-Cookie: x=1';
    const res = await app().request(`/binary/${VALID_REF}?name=${encodeURIComponent(evil)}`);
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).not.toContain('\r');
    expect(cd).not.toContain('\n');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('🚨 fileName con doppi apici → sanitizzato (non spezza filename="...")', async () => {
    // Senza sanitizzazione `"` chiuderebbe il fil="..." quoted-string e
    // permetterebbe di iniettare parametri arbitrari nell'header.
    const res = await app().request(`/binary/${VALID_REF}?name=${encodeURIComponent('a";evil="1')}`);
    const cd = res.headers.get('content-disposition') ?? '';
    // L'unico paio di apici deve essere quello del wrapper filename="..."
    const quoteCount = (cd.match(/"/gu) ?? []).length;
    expect(quoteCount).toBe(2);
    expect(cd).not.toContain('evil="1"');
  });

  it('fileName UTF-8 → filename* RFC 5987 presente', async () => {
    const res = await app().request(`/binary/${VALID_REF}?name=${encodeURIComponent('relazione-€.pdf')}`);
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toContain("filename*=UTF-8''");
  });
});
