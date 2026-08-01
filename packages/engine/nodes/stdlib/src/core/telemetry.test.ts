import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withSpan, registerTracer, unregisterTracer, httpSpanAttrs } from './telemetry.js';

describe('telemetry', () => {
  afterEach(() => {
    unregisterTracer();
  });

  describe('withSpan — no tracer registered', () => {
    it('executes body directly, returns its value', async () => {
      const r = await withSpan('x', {}, () => 42);
      expect(r).toBe(42);
    });

    it('passes through async body', async () => {
      const r = await withSpan('x', { 'a': 1 }, async () => Promise.resolve('hi'));
      expect(r).toBe('hi');
    });

    it('re-throws body errors transparently', async () => {
      await expect(withSpan('x', {}, () => { throw new Error('boom'); })).rejects.toThrow('boom');
    });
  });

  describe('withSpan — with tracer', () => {
    let mockSpan: ReturnType<typeof makeMockSpan>;
    let mockTracer: { startActiveSpan: ReturnType<typeof vi.fn> };

    function makeMockSpan() {
      return {
        setAttribute: vi.fn(),
        setAttributes: vi.fn(),
        setStatus: vi.fn(),
        recordException: vi.fn(),
        end: vi.fn(),
      };
    }

    beforeEach(() => {
      mockSpan = makeMockSpan();
      mockTracer = {
        startActiveSpan: vi.fn((_name, fn) => fn(mockSpan)),
      };
      registerTracer(mockTracer);
    });

    it('opens a span with the given name', async () => {
      await withSpan('node.test', {}, () => 1);
      expect(mockTracer.startActiveSpan).toHaveBeenCalledWith('node.test', expect.any(Function));
    });

    it('sets attributes (filtering undefined)', async () => {
      await withSpan('x', { a: 'v', b: undefined, c: 5 }, () => 1);
      expect(mockSpan.setAttributes).toHaveBeenCalledWith({ a: 'v', c: 5 });
    });

    it('skips setAttributes call if all attributes undefined', async () => {
      await withSpan('x', { a: undefined, b: undefined }, () => 1);
      expect(mockSpan.setAttributes).not.toHaveBeenCalled();
    });

    it('marks span OK on success', async () => {
      await withSpan('x', {}, () => 1);
      expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: 1 });
      expect(mockSpan.end).toHaveBeenCalled();
    });

    it('records exception + marks ERROR on throw, re-throws', async () => {
      await expect(withSpan('x', {}, () => { throw new Error('boom'); })).rejects.toThrow('boom');
      expect(mockSpan.recordException).toHaveBeenCalled();
      expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: 2, message: 'boom' });
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('error.type', 'Error');
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('error.message', 'boom');
      expect(mockSpan.end).toHaveBeenCalled();
    });

    it('wraps non-Error throws into Error before recordException', async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- Legacy throw pattern compatibile API esistente
      await expect(withSpan('x', {}, () => { throw 'str'; })).rejects.toBe('str');
      expect(mockSpan.recordException).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('httpSpanAttrs', () => {
    it('extracts host from URL', () => {
      const a = httpSpanAttrs('get', 'https://api.example.com/users');
      expect(a['http.method']).toBe('GET');
      expect(a['http.url']).toBe('https://api.example.com/users');
      expect(a['http.host']).toBe('api.example.com');
    });

    it('handles invalid URL gracefully', () => {
      const a = httpSpanAttrs('GET', 'not a url');
      expect(a['http.host']).toBe('unknown');
    });

    it('includes optional status + ua', () => {
      const a = httpSpanAttrs('POST', 'https://x.com', { status: 200, userAgent: 'agent/1' });
      expect(a['http.status_code']).toBe(200);
      expect(a['http.user_agent']).toBe('agent/1');
    });

    it('SCRUB query string da http.url (anti secret leak)', () => {
      const a = httpSpanAttrs('GET', 'https://api.stripe.com/v1/charges?api_key=sk_live_SECRET&customer=cus_123');
      expect(a['http.url']).toBe('https://api.stripe.com/v1/charges');
      expect(String(a['http.url'])).not.toContain('SECRET');
      expect(String(a['http.url'])).not.toContain('api_key');
    });

    it('SCRUB userInfo (user:pass@host) da http.url', () => {
      const a = httpSpanAttrs('GET', 'https://alice:hunter2@api.x.com/u');
      expect(a['http.url']).toBe('https://api.x.com/u');
      expect(String(a['http.url'])).not.toContain('hunter2');
      expect(String(a['http.url'])).not.toContain('alice');
    });

    it('SCRUB combinato — userInfo + query + fragment', () => {
      const a = httpSpanAttrs('POST', 'https://u:p@api.x.com:8443/v1/data?token=SECRET&debug=1#section');
      expect(a['http.url']).toBe('https://api.x.com:8443/v1/data');
      expect(a['http.host']).toBe('api.x.com:8443');
    });

    it('SCRUB preserva path completo (no over-stripping)', () => {
      const a = httpSpanAttrs('GET', 'https://api.example.com/v2/users/12345/orders/abc-def?expand=line_items');
      expect(a['http.url']).toBe('https://api.example.com/v2/users/12345/orders/abc-def');
    });

    it('URL malformato → placeholder, no leak input grezzo', () => {
      const a = httpSpanAttrs('GET', 'not-a-url?secret=leak');
      expect(a['http.url']).toBe('<unparseable>');
      expect(String(a['http.url'])).not.toContain('leak');
    });
  });

  describe('scrubUrl direct', () => {
    it('strip query string', async () => {
      const { scrubUrl } = await import('./telemetry.js');
      expect(scrubUrl('https://x.com/a?b=1&c=2')).toBe('https://x.com/a');
    });

    it('strip userInfo + query + hash', async () => {
      const { scrubUrl } = await import('./telemetry.js');
      expect(scrubUrl('https://user:pwd@x.com/a?b=1#z')).toBe('https://x.com/a');
    });

    it('preserva URL without sensitive parts', async () => {
      const { scrubUrl } = await import('./telemetry.js');
      expect(scrubUrl('https://x.com/path')).toBe('https://x.com/path');
    });

    it('malformed → <unparseable>', async () => {
      const { scrubUrl } = await import('./telemetry.js');
      expect(scrubUrl('::not::url::')).toBe('<unparseable>');
    });
  });
});
