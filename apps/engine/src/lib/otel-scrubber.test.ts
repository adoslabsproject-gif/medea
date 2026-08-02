import { describe, it, expect, vi } from 'vitest';
import { SecretScrubbingSpanProcessor, scrubUrl } from './otel-scrubber.js';

describe('scrubUrl', () => {
  it('strip query string da URL assoluto', () => {
    expect(scrubUrl('https://api.stripe.com/v1/charges?api_key=sk_live_X&customer=cus_1')).toBe(
      'https://api.stripe.com/v1/charges',
    );
  });

  it('strip userInfo (user:pass@)', () => {
    expect(scrubUrl('https://alice:hunter2@api.x.com/u')).toBe('https://api.x.com/u');
  });

  it('strip combinato — userInfo + query + fragment', () => {
    expect(scrubUrl('https://u:p@api.x.com:8443/v1/data?token=SECRET&debug=1#section')).toBe(
      'https://api.x.com:8443/v1/data',
    );
  });

  it('strip query da PATH relativo (non-URL absoluto)', () => {
    expect(scrubUrl('/v1/users/123?api_key=secret&page=2')).toBe('/v1/users/123');
  });

  it('strip fragment da path relativo', () => {
    expect(scrubUrl('/dashboard#secret=abc')).toBe('/dashboard');
  });

  it('preserva URL senza query/userInfo', () => {
    expect(scrubUrl('https://api.example.com/v2/data')).toBe('https://api.example.com/v2/data');
    expect(scrubUrl('/api/health')).toBe('/api/health');
  });

  it('empty string passthrough', () => {
    expect(scrubUrl('')).toBe('');
  });
});

describe('SecretScrubbingSpanProcessor', () => {
  function makeMockSpan(attrs: Record<string, unknown>) {
    return { attributes: attrs };
  }

  function makeNextProcessor() {
    return {
      onStart: vi.fn(),
      onEnd: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      forceFlush: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('scrubba http.url contenente api_key', () => {
    const next = makeNextProcessor();
    const proc = new SecretScrubbingSpanProcessor(next as never);
    const span = makeMockSpan({
      'http.url': 'https://api.stripe.com/v1/charges?api_key=sk_live_SECRET',
      'http.method': 'POST',
    });
    proc.onEnd(span as never);
    expect(span.attributes['http.url']).toBe('https://api.stripe.com/v1/charges');
    expect(span.attributes['http.method']).toBe('POST'); // non toccato
    expect(next.onEnd).toHaveBeenCalledWith(span);
  });

  it('scrubba url.full (OTel 1.20+ semantic conventions)', () => {
    const next = makeNextProcessor();
    const proc = new SecretScrubbingSpanProcessor(next as never);
    const span = makeMockSpan({
      'url.full': 'https://gmail.googleapis.com/v1/users/me/messages?access_token=ya29.TOKEN',
    });
    proc.onEnd(span as never);
    expect(String(span.attributes['url.full'])).not.toContain('TOKEN');
    expect(String(span.attributes['url.full'])).not.toContain('access_token');
  });

  it('scrubba TUTTI gli url-like attrs (multi-conv simultanea)', () => {
    const next = makeNextProcessor();
    const proc = new SecretScrubbingSpanProcessor(next as never);
    const span = makeMockSpan({
      'http.url': 'https://api.x.com/u?token=A',
      'url.full': 'https://api.x.com/u?token=A',
      'http.target': '/u?token=A',
      'url.query': 'token=A&other=B',
    });
    proc.onEnd(span as never);
    expect(span.attributes['http.url']).toBe('https://api.x.com/u');
    expect(span.attributes['url.full']).toBe('https://api.x.com/u');
    expect(span.attributes['http.target']).toBe('/u');
    // url.query = sempre placeholder per non leak nemmeno key names
    expect(span.attributes['url.query']).toBe('<scrubbed>');
  });

  it('url.query vuoto NON sostituito con <scrubbed> (no false-positive)', () => {
    const next = makeNextProcessor();
    const proc = new SecretScrubbingSpanProcessor(next as never);
    const span = makeMockSpan({ 'url.query': '' });
    proc.onEnd(span as never);
    expect(span.attributes['url.query']).toBe('');
  });

  it('attrs non-URL passano invariati', () => {
    const next = makeNextProcessor();
    const proc = new SecretScrubbingSpanProcessor(next as never);
    const span = makeMockSpan({
      'http.method': 'GET',
      'http.status_code': 200,
      'service.name': 'my-svc',
      'custom.attr': 'value',
    });
    proc.onEnd(span as never);
    expect(span.attributes).toEqual({
      'http.method': 'GET',
      'http.status_code': 200,
      'service.name': 'my-svc',
      'custom.attr': 'value',
    });
  });

  it('delega onStart al next processor', () => {
    const next = makeNextProcessor();
    const proc = new SecretScrubbingSpanProcessor(next as never);
    const span = { spanContext: () => ({}) };
    const ctx = {};
    proc.onStart(span as never, ctx as never);
    expect(next.onStart).toHaveBeenCalledWith(span, ctx);
  });

  it('delega shutdown + forceFlush al next', async () => {
    const next = makeNextProcessor();
    const proc = new SecretScrubbingSpanProcessor(next as never);
    await proc.shutdown();
    await proc.forceFlush();
    expect(next.shutdown).toHaveBeenCalled();
    expect(next.forceFlush).toHaveBeenCalled();
  });

  it('non-string http.url (es. null) NON crasha', () => {
    const next = makeNextProcessor();
    const proc = new SecretScrubbingSpanProcessor(next as never);
    const span = makeMockSpan({ 'http.url': null });
    expect(() => proc.onEnd(span as never)).not.toThrow();
  });

  it('caso real-world Gmail OAuth token leak', () => {
    const next = makeNextProcessor();
    const proc = new SecretScrubbingSpanProcessor(next as never);
    const span = makeMockSpan({
      'url.full':
        'https://oauth2.googleapis.com/token?client_secret=GOCSPX-mysecret&grant_type=refresh_token&refresh_token=1//ABCdef',
    });
    proc.onEnd(span as never);
    const cleaned = String(span.attributes['url.full']);
    expect(cleaned).not.toContain('GOCSPX');
    expect(cleaned).not.toContain('refresh_token');
    expect(cleaned).not.toContain('client_secret');
    expect(cleaned).toBe('https://oauth2.googleapis.com/token');
  });
});
