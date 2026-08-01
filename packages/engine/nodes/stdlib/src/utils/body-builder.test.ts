import { describe, it, expect } from 'vitest';
import { buildBody, applyQueryParams } from './body-builder.js';

describe('buildBody', () => {
  describe('GET/HEAD/...', () => {
    it('returns empty for GET regardless of bodyType', () => {
      expect(buildBody({ bodyType: 'json', body: '{}' }, 'GET')).toEqual({});
    });

    it('returns empty for HEAD', () => {
      expect(buildBody({ bodyType: 'json', body: '{}' }, 'HEAD')).toEqual({});
    });

    it('case-insensitive method matching', () => {
      expect(buildBody({ bodyType: 'json', body: '{}' }, 'get')).toEqual({});
    });
  });

  describe('json', () => {
    it('passes body through with json Content-Type', () => {
      const r = buildBody({ bodyType: 'json', body: '{"a":1}' }, 'POST');
      expect(r.body).toBe('{"a":1}');
      expect(r.contentType).toBe('application/json');
    });

    it('stringifies non-string body', () => {
      const r = buildBody({ bodyType: 'json', body: { a: 1 } }, 'POST');
      expect(r.body).toBe('{"a":1}');
    });
  });

  describe('raw-text', () => {
    it('text/plain with utf-8 charset', () => {
      const r = buildBody({ bodyType: 'raw-text', body: 'hello' }, 'POST');
      expect(r.body).toBe('hello');
      expect(r.contentType).toBe('text/plain; charset=utf-8');
    });
  });

  describe('raw-binary-base64', () => {
    it('decodes base64 to Buffer with default octet-stream Content-Type', () => {
      const b64 = Buffer.from('Hello').toString('base64');
      const r = buildBody({ bodyType: 'raw-binary-base64', body: b64 }, 'POST');
      expect(Buffer.isBuffer(r.body)).toBe(true);
      expect((r.body as Buffer).toString()).toBe('Hello');
      expect(r.contentType).toBe('application/octet-stream');
    });

    it('honors custom rawBinaryContentType', () => {
      const r = buildBody({
        bodyType: 'raw-binary-base64',
        body: Buffer.from('PDF').toString('base64'),
        rawBinaryContentType: 'application/pdf',
      }, 'POST');
      expect(r.contentType).toBe('application/pdf');
    });
  });

  describe('form-urlencoded', () => {
    it('builds query-string body + form Content-Type', () => {
      const r = buildBody({
        bodyType: 'form-urlencoded',
        formFields: JSON.stringify({ a: '1', b: 'hello world' }),
      }, 'POST');
      expect(r.contentType).toBe('application/x-www-form-urlencoded');
      expect(r.body).toBe('a=1&b=hello+world');
    });

    it('empty formFields → empty body string', () => {
      const r = buildBody({ bodyType: 'form-urlencoded' }, 'POST');
      expect(r.body).toBe('');
    });
  });

  describe('multipart', () => {
    it('builds FormData (no contentType — fetch sets boundary)', () => {
      const r = buildBody({
        bodyType: 'multipart',
        formFields: JSON.stringify({ name: 'a', file: 'b' }),
      }, 'POST');
      expect(r.body).toBeInstanceOf(FormData);
      expect(r.contentType).toBeUndefined();
    });
  });

  describe('none', () => {
    it('returns empty', () => {
      expect(buildBody({ bodyType: 'none', body: 'ignored' }, 'POST')).toEqual({});
    });
  });
});

describe('applyQueryParams', () => {
  it('returns URL unchanged when no params', () => {
    expect(applyQueryParams('https://x.com/p', '')).toBe('https://x.com/p');
    expect(applyQueryParams('https://x.com/p', null)).toBe('https://x.com/p');
  });

  it('appends kv params', () => {
    const r = applyQueryParams('https://x.com/p', JSON.stringify({ a: '1', b: '2' }));
    const u = new URL(r);
    expect(u.searchParams.get('a')).toBe('1');
    expect(u.searchParams.get('b')).toBe('2');
  });

  it('preserves existing query params', () => {
    const r = applyQueryParams('https://x.com/p?existing=1', JSON.stringify({ new: '2' }));
    const u = new URL(r);
    expect(u.searchParams.get('existing')).toBe('1');
    expect(u.searchParams.get('new')).toBe('2');
  });

  it('URL-encodes values', () => {
    const r = applyQueryParams('https://x.com/p', JSON.stringify({ q: 'hello world & friends' }));
    expect(r).toContain('q=hello+world+%26+friends');
  });
});
