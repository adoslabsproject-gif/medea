/**
 * Stream Proxy Native — unit test del path matching + HMAC verify + rewrite M3U8.
 *
 * Test reali (no mock fetch): verifico la logica pura. I test E2E pipe upstream
 * sono nello smoke test prod (curl real su URL signed).
 */
import { describe, it, expect } from 'vitest';
import { __testExports, verifyProxySignature } from './stream-proxy-native.js';

const {
  base64UrlDecode,
  base64UrlEncode,
  computeSig,
  safeStringEqual,
  rewriteM3u,
  looksLikeM3u8,
  findProxyConfig,
  STREAM_PROXY_RE,
} = __testExports;

describe('stream-proxy-native — path matching', () => {
  const cases: [string, boolean, string?, string?][] = [
    ['/webhooks/c/stream/proxy.m3u8/abc123', true, 'm3u8', 'abc123'],
    ['/webhooks/c/stream/proxy.ts/xyz789', true, 'ts', 'xyz789'],
    ['/webhooks/c/stream/proxy.vtt/ff00', true, 'vtt', 'ff00'],
    ['/webhooks/c/stream/proxy.key/abc', true, 'key', 'abc'],
    ['/webhooks/c/stream/proxy.mp4/abc', true, 'mp4', 'abc'],
    ['/webhooks/c/stream/proxy.m4s/abc', true, 'm4s', 'abc'],
    ['/webhooks/c/stream/proxy.aac/abc', true, 'aac', 'abc'],
    ['/webhooks/c/stream/proxy.webvtt/abc', true, 'webvtt', 'abc'],
    ['/webhooks/c/stream/proxy.m3u/abc', true, 'm3u', 'abc'],
    ['/webhooks/c/stream/proxy.exe/abc', false],
    ['/webhooks/c/orders/abc', false],
    ['/webhooks/123/abc', false],
    ['/webhooks/c/stream/proxy.m3u8/', false], // missing token
    ['/webhooks/c/stream/proxy.m3u8/abc?u=1&e=2&sig=3', false], // query string makes pathname not match (qs separato)
  ];
  for (const [path, expected, expectedExt, expectedToken] of cases) {
    it(`match ${path} → ${String(expected)}`, () => {
      const m = STREAM_PROXY_RE.exec(path);
      if (expected) {
        expect(m).not.toBeNull();
        expect(m![1]).toBe(expectedExt);
        expect(m![2]).toBe(expectedToken);
      } else {
        expect(m).toBeNull();
      }
    });
  }
});

describe('stream-proxy-native — base64url encode/decode', () => {
  it('roundtrip URL', () => {
    const url = 'https://vixcloud.co/playlist/740398?b=1&token=abc&expires=1786196749';
    const enc = base64UrlEncode(url);
    expect(enc).not.toContain('=');
    expect(enc).not.toContain('+');
    expect(enc).not.toContain('/');
    expect(base64UrlDecode(enc)).toBe(url);
  });
  it('decode handles missing padding', () => {
    const enc = base64UrlEncode('hello');
    expect(base64UrlDecode(enc)).toBe('hello');
  });
  it('decode invalid → null OR garbage (not throw)', () => {
    expect(() => base64UrlDecode('@@@')).not.toThrow();
  });
});

describe('stream-proxy-native — HMAC sign + verify', () => {
  const SECRET = '4be069f9fa033333abcdef0123456789';
  const URL = 'https://example.com/segment.ts?token=xyz';
  it('computeSig deterministic', () => {
    const u = base64UrlEncode(URL);
    const e = 1786200000;
    const s1 = computeSig(SECRET, u, e);
    const s2 = computeSig(SECRET, u, e);
    expect(s1).toBe(s2);
    expect(s1).toMatch(/^[a-f0-9]{64}$/u);
  });
  it('verifyProxySignature accepts valid sig', () => {
    const u = base64UrlEncode(URL);
    const e = Math.floor(Date.now() / 1000) + 3600;
    const sig = computeSig(SECRET, u, e);
    const r = verifyProxySignature(u, String(e), sig, SECRET);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe(URL);
  });
  it('verifyProxySignature rejects expired', () => {
    const u = base64UrlEncode(URL);
    const e = Math.floor(Date.now() / 1000) - 60;
    const sig = computeSig(SECRET, u, e);
    const r = verifyProxySignature(u, String(e), sig, SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('expired');
  });
  it('verifyProxySignature rejects sig mismatch (tampered url)', () => {
    const u1 = base64UrlEncode(URL);
    const e = Math.floor(Date.now() / 1000) + 3600;
    const sig = computeSig(SECRET, u1, e);
    const u2 = base64UrlEncode('https://evil.com/leak');
    const r = verifyProxySignature(u2, String(e), sig, SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('sig-mismatch');
  });
  it('verifyProxySignature rejects bad-exp (NaN)', () => {
    const r = verifyProxySignature('abc', 'not-a-number', 'sig', SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad-exp');
  });
  it('verifyProxySignature rejects bad-url (non-http)', () => {
    const u = base64UrlEncode('javascript:alert(1)');
    const e = Math.floor(Date.now() / 1000) + 3600;
    const sig = computeSig(SECRET, u, e);
    const r = verifyProxySignature(u, String(e), sig, SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad-url');
  });
  it('safeStringEqual uses timing-safe compare', () => {
    expect(safeStringEqual('abc', 'abc')).toBe(true);
    expect(safeStringEqual('abc', 'abd')).toBe(false);
    expect(safeStringEqual('abc', 'abcd')).toBe(false); // length mismatch
  });
});

describe('stream-proxy-native — M3U8 detection + rewrite', () => {
  it('looksLikeM3u8 by content-type', () => {
    expect(looksLikeM3u8('', 'application/vnd.apple.mpegurl')).toBe(true);
    expect(looksLikeM3u8('', 'application/x-mpegurl')).toBe(true);
    expect(looksLikeM3u8('', 'text/html')).toBe(false);
  });
  it('looksLikeM3u8 by body header', () => {
    expect(looksLikeM3u8('#EXTM3U\n#EXTINF...', 'text/plain')).toBe(true);
    expect(looksLikeM3u8('<html>', 'text/plain')).toBe(false);
  });

  const SECRET = 'secret-test-32-bytes-min-required';
  const PROXY_BASE = 'https://my.host.com/webhooks/c/stream/proxy.m3u8/tok123';

  it('rewrite EXT-X-MEDIA URI quoted', () => {
    const body = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="ita",URI="https://upstream.com/audio.m3u8"',
      '',
    ].join('\n');
    const out = rewriteM3u(body, {
      baseUrl: 'https://upstream.com/master.m3u8',
      proxyBase: PROXY_BASE,
      secret: SECRET,
      ttlSec: 3600,
    });
    expect(out).toContain('URI="https://my.host.com/webhooks/c/stream/proxy.m3u8/tok123?u=');
    expect(out).toContain('&e=');
    expect(out).toContain('&sig=');
    expect(out).not.toContain('https://upstream.com/audio.m3u8'); // sostituita
  });

  it('rewrite plain URL line (stream variant)', () => {
    const body = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=4500000',
      'https://upstream.com/video-1080p.m3u8',
      '',
    ].join('\n');
    const out = rewriteM3u(body, {
      baseUrl: 'https://upstream.com/master.m3u8',
      proxyBase: PROXY_BASE,
      secret: SECRET,
      ttlSec: 3600,
    });
    expect(out).toContain('my.host.com/webhooks/c/stream/proxy.m3u8/tok123?u=');
    expect(out).not.toMatch(/^https:\/\/upstream\.com\/video-1080p\.m3u8/mu);
  });

  it('preserve comment lines + relative URL via baseUrl', () => {
    const body = ['#EXTM3U', '#EXTINF:6.0,', 'segment-001.ts', ''].join('\n');
    const out = rewriteM3u(body, {
      baseUrl: 'https://upstream.com/dir/playlist.m3u8',
      proxyBase: PROXY_BASE,
      secret: SECRET,
      ttlSec: 3600,
    });
    expect(out).toContain('#EXTM3U');
    expect(out).toContain('#EXTINF:6.0,');
    // segment-001.ts → risolvuto contro baseUrl → signed proxy URL
    expect(out).toContain('my.host.com/webhooks/c/stream/proxy.m3u8/tok123?u=');
    expect(out).not.toMatch(/^segment-001\.ts$/mu);
  });
});

describe('stream-proxy-native — findProxyConfig', () => {
  it('estrae signSecret/referer/userAgent/timeoutMs dal nodo custom_action_stream_proxy', () => {
    const nodes = JSON.stringify([
      { id: 'trigger_webhook_1', defId: 'trigger_webhook', config: {} },
      {
        id: 'sp1',
        defId: 'custom_action_stream_proxy',
        config: {
          signSecret: '4be069f9fa0333334abcdef0123',
          referer: 'https://streamingcommunityz.eu/',
          userAgent: 'Mozilla/5.0',
          timeoutMs: 45000,
          mode: 'serve',
        },
      },
    ]);
    const cfg = findProxyConfig(nodes);
    expect(cfg).not.toBeNull();
    expect(cfg!.signSecret).toBe('4be069f9fa0333334abcdef0123');
    expect(cfg!.referer).toBe('https://streamingcommunityz.eu/');
    expect(cfg!.userAgent).toBe('Mozilla/5.0');
    expect(cfg!.timeoutMs).toBe(45000);
  });

  it('ritorna null se nessun nodo proxy', () => {
    const nodes = JSON.stringify([{ id: 't1', defId: 'trigger_webhook', config: {} }]);
    expect(findProxyConfig(nodes)).toBeNull();
  });

  it('ritorna null se signSecret troppo corto (<16)', () => {
    const nodes = JSON.stringify([
      { id: 'sp1', defId: 'custom_action_stream_proxy', config: { signSecret: 'short' } },
    ]);
    expect(findProxyConfig(nodes)).toBeNull();
  });

  it('ritorna null su JSON malformato', () => {
    expect(findProxyConfig('not-json{')).toBeNull();
  });
});
