/**
 * Test 2026-grade — AI Scaffold redactSensitive (anti secret leak).
 *
 * SECURITY: l'agente NON deve mai vedere apiKey/password/token/cookie/auth.
 * DEPTH: cap a 6 livelli annidati (no infinite recursion).
 * ANTI-LEAK: strip /var/lib/flowforge e /opt/flowforge paths (FS layout disclosure).
 */
import { describe, it, expect } from 'vitest';
import { redactSensitive, SENSITIVE_KEYS } from './redact.js';

describe('🚨 sensitive keys', () => {
  it.each([
    'apiKey', 'api_key', 'password', 'secret', 'token',
    'authorization', 'auth', 'cookie', 'session', 'pw', 'pwd',
  ])('🚨 key "%s" → [redacted]', (key) => {
    const out = redactSensitive({ [key]: 'super-secret-value-AAA', other: 'ok' });
    expect((out as any)[key]).toBe('[redacted]');
    expect((out as any).other).toBe('ok');
  });

  it('🚨 case-insensitive (ApiKey, APIKEY, PASSWORD)', () => {
    const out = redactSensitive({ ApiKey: 'x', PASSWORD: 'y', Token: 'z' });
    expect((out as any).ApiKey).toBe('[redacted]');
    expect((out as any).PASSWORD).toBe('[redacted]');
    expect((out as any).Token).toBe('[redacted]');
  });

  it('🚨 SENSITIVE_KEYS exported set (lowercase)', () => {
    expect(SENSITIVE_KEYS.has('apikey')).toBe(true);
    expect(SENSITIVE_KEYS.has('password')).toBe(true);
    expect(SENSITIVE_KEYS.has('foo')).toBe(false);
  });
});

describe('🚨 path leak prevention', () => {
  it('🚨 /var/lib/flowforge/* → [redacted]', () => {
    expect(redactSensitive('Error reading /var/lib/flowforge/secrets/master.key'))
      .toBe('Error reading /var/lib/flowforge/[redacted]');
  });

  it('🚨 /opt/flowforge/* → [redacted]', () => {
    expect(redactSensitive('cd /opt/flowforge/dist/server.js'))
      .toBe('cd /opt/flowforge/[redacted]');
  });

  it('🚨 path normali (no flowforge) preservati', () => {
    expect(redactSensitive('/usr/bin/node')).toBe('/usr/bin/node');
  });
});

describe('🚨 long string truncation', () => {
  it('🚨 string > 2000 char → tronca + suffix [+N chars redacted]', () => {
    const big = 'a'.repeat(3000);
    const out = redactSensitive(big);
    expect(typeof out).toBe('string');
    expect((out as string).length).toBeLessThan(big.length);
    expect(out).toMatch(/chars redacted/u);
  });

  it('🚨 string < 2000 → invariata', () => {
    const s = 'normal string';
    expect(redactSensitive(s)).toBe(s);
  });

  it('🚨 base64-like > 500 char → tronca a 80', () => {
    const b64 = 'A'.repeat(800); // 800 char alfa = base64-like
    const out = redactSensitive(b64) as string;
    expect(out.length).toBeLessThan(200);
    expect(out).toMatch(/base64-like/u);
  });

  it('🚨 long stringa NON base64-like (con spazi) → tronca solo se > 2000', () => {
    const s = 'this is a long text with spaces '.repeat(20); // ~640 char con spazi
    expect(redactSensitive(s)).toBe(s); // < 2000 e ha spazi → no truncation
  });
});

describe('🚨 recursive depth cap', () => {
  it('🚨 depth > 6 → "[…redacted: depth limit]"', () => {
    let nested: any = 'leaf';
    for (let i = 0; i < 8; i++) nested = { k: nested };
    const out = redactSensitive(nested);
    const s = JSON.stringify(out);
    expect(s).toContain('depth limit');
  });

  it('🚨 walk dentro arrays', () => {
    const out = redactSensitive({
      items: [{ apiKey: 'leaked' }, { name: 'ok' }],
    });
    expect((out as any).items[0].apiKey).toBe('[redacted]');
    expect((out as any).items[1].name).toBe('ok');
  });

  it('🚨 array > 50 elementi → slice (anti-DoS)', () => {
    const big = Array.from({ length: 100 }, (_, i) => `item-${i}`);
    expect((redactSensitive(big) as unknown[]).length).toBe(50);
  });
});

describe('🚨 primitives passthrough', () => {
  it('🚨 null → null', () => {
    expect(redactSensitive(null)).toBeNull();
  });

  it('🚨 number, boolean preserved', () => {
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(true)).toBe(true);
  });

  it('🚨 undefined → undefined', () => {
    expect(redactSensitive(undefined)).toBeUndefined();
  });
});

describe('🚨 real-world tool_result redaction', () => {
  it('🚨 connector config object → secrets redacted, struttura preserved', () => {
    const tool_result = {
      ok: true,
      provider: 'gmail',
      config: {
        apiKey: 'sk-secret-12345',
        access_token: 'tok-aaa',
        client_id: 'public-info',
        baseUrl: 'https://api.gmail.com',
      },
    };
    const out = redactSensitive(tool_result) as any;
    expect(out.ok).toBe(true);
    expect(out.provider).toBe('gmail');
    expect(out.config.apiKey).toBe('[redacted]');
    expect(out.config.client_id).toBe('public-info'); // non sensibile
    expect(out.config.baseUrl).toBe('https://api.gmail.com');
  });
});
