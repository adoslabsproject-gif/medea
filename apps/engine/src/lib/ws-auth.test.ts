/**
 * ws-auth — estrazione del session JWT dall'upgrade WebSocket.
 * Bug-bounty (fix 2026-06-15): il LSP era MORTO perché accettava SOLO ?token=
 * (mai impostato dal client cookie-based). Qui inchiodiamo: cookie HttpOnly
 * PRIMA, fallback ?token=, priorità __Host- su legacy, decode URI, null se nulla.
 */
import { describe, it, expect } from 'vitest';
import { readCookie, extractWsSessionToken } from './ws-auth.js';

function req(
  cookie?: string,
  url = '/api/v1/custom-nodes/lsp',
): { headers: { cookie?: string }; url: string } {
  return { headers: cookie === undefined ? {} : { cookie }, url };
}

describe('readCookie', () => {
  it('trova il cookie per nome', () => {
    expect(readCookie('a=1; ff_session=tok; b=2', 'ff_session')).toBe('tok');
  });
  it('null se assente o header vuoto', () => {
    expect(readCookie('a=1; b=2', 'ff_session')).toBeNull();
    expect(readCookie(undefined, 'ff_session')).toBeNull();
  });
  it('decodifica URI-encoded', () => {
    expect(readCookie('ff_session=a%2Bb%3Dc', 'ff_session')).toBe('a+b=c');
  });
  it('NON fa match parziale di prefisso (ff_session vs xff_session)', () => {
    expect(readCookie('xff_session=nope', 'ff_session')).toBeNull();
  });
});

describe('extractWsSessionToken', () => {
  it('cookie __Host-ff_session (prod) → preferito', () => {
    expect(extractWsSessionToken(req('__Host-ff_session=prodtok'))).toBe('prodtok');
  });
  it('cookie ff_session legacy/dev', () => {
    expect(extractWsSessionToken(req('ff_session=devtok'))).toBe('devtok');
  });
  it('__Host- ha priorità sul legacy ff_session', () => {
    expect(extractWsSessionToken(req('ff_session=legacy; __Host-ff_session=host'))).toBe('host');
  });
  it('COOKIE ha priorità su ?token= (no leak in URL)', () => {
    expect(
      extractWsSessionToken(req('ff_session=cook', '/api/v1/custom-nodes/lsp?token=urltok')),
    ).toBe('cook');
  });
  it('fallback a ?token= se nessun cookie (dev/non-browser)', () => {
    expect(extractWsSessionToken(req(undefined, '/api/v1/custom-nodes/lsp?token=urltok'))).toBe(
      'urltok',
    );
  });
  it('null se né cookie né token', () => {
    expect(extractWsSessionToken(req(undefined, '/api/v1/custom-nodes/lsp'))).toBeNull();
  });
  it('URL malformata → non lancia, ricade a null', () => {
    expect(extractWsSessionToken({ headers: {}, url: '://bad' })).toBeNull();
  });
});
