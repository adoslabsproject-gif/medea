/**
 * Tests session-cookie runtime helper — mirror del portal helper.
 *
 * Invarianti come da apps/portal/src/lib/session-cookie.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  sessionCookieName,
  parseSessionFromCookieHeader,
  SESSION_COOKIE_HOST,
  SESSION_COOKIE_LEGACY,
} from './session-cookie';

const origNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  process.env.NODE_ENV = 'production';
});

afterEach(() => {
  if (origNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = origNodeEnv;
});

describe('sessionCookieName() — runtime', () => {
  it('production → __Host-ff_session', () => {
    process.env.NODE_ENV = 'production';
    expect(sessionCookieName()).toBe('__Host-ff_session');
  });

  it('non-production → ff_session', () => {
    process.env.NODE_ENV = 'development';
    expect(sessionCookieName()).toBe('ff_session');
    process.env.NODE_ENV = 'test';
    expect(sessionCookieName()).toBe('ff_session');
  });

  it('NODE_ENV undefined → ff_session', () => {
    delete process.env.NODE_ENV;
    expect(sessionCookieName()).toBe('ff_session');
  });
});

describe('parseSessionFromCookieHeader() — runtime', () => {
  it('undefined → undefined', () => {
    expect(parseSessionFromCookieHeader(undefined)).toBeUndefined();
  });

  it('empty → undefined', () => {
    expect(parseSessionFromCookieHeader('')).toBeUndefined();
  });

  it('estrae __Host-ff_session preferito su ff_session', () => {
    expect(parseSessionFromCookieHeader('ff_session=OLD; __Host-ff_session=NEW')).toBe('NEW');
  });

  it('fallback a ff_session legacy se primary assente', () => {
    expect(parseSessionFromCookieHeader('ff_session=legacy-tok')).toBe('legacy-tok');
  });

  it('URL-decode value', () => {
    expect(parseSessionFromCookieHeader('__Host-ff_session=a%2Bb')).toBe('a+b');
  });

  it('non match `_ff_session` (substring spurious)', () => {
    expect(parseSessionFromCookieHeader('_ff_session=tricky')).toBeUndefined();
  });

  it('non match `prefix_ff_session`', () => {
    expect(parseSessionFromCookieHeader('prefix_ff_session=tricky')).toBeUndefined();
  });

  it('WS use case: header con altri cookie', () => {
    // Simulazione WebSocket request.headers.cookie reale
    const header = '_ga=GA1.2; visitor=abc; __Host-ff_session=ws-tok; lang=it';
    expect(parseSessionFromCookieHeader(header)).toBe('ws-tok');
  });
});

describe('constants exposed', () => {
  it('SESSION_COOKIE_HOST = __Host-ff_session', () => {
    expect(SESSION_COOKIE_HOST).toBe('__Host-ff_session');
  });

  it('SESSION_COOKIE_LEGACY = ff_session', () => {
    expect(SESSION_COOKIE_LEGACY).toBe('ff_session');
  });
});
