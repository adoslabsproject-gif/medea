/**
 * Test OAuth2 client_credentials (acquireOAuth2Token) — bug-bounty + anti-regressione.
 *
 * fetchToken e clock INIETTATI → zero rete, determinismo totale. Copre: stile header
 * vs body, scope, cache hit/miss, scadenza, margine di refresh, e gli input ROTTI del
 * token endpoint (non-2xx, no access_token, non-JSON, expires_in mancante/negativo/NaN).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { acquireOAuth2Token, clearOAuth2TokenCache, type TokenFetcher } from './oauth2.js';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const baseParams = {
  tokenUrl: 'https://login.example.com/oauth2/token',
  clientId: 'cid',
  clientSecret: 'csecret',
  authStyle: 'header' as const,
};

beforeEach(() => {
  clearOAuth2TokenCache();
});

describe('acquireOAuth2Token — request shaping', () => {
  it('🚨 authStyle=header → HTTP Basic + grant_type nel body, ritorna access_token', async () => {
    const fetchToken: TokenFetcher = vi.fn(async (_url, init) => {
      const headers = init.headers as Headers;
      expect(headers.get('Authorization')).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
      expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
      expect(String(init.body)).toContain('grant_type=client_credentials');
      // header style: le credenziali NON sono nel body
      expect(String(init.body)).not.toContain('client_secret');
      return jsonRes({ access_token: 'AT-1', expires_in: 3600 });
    });
    const t = await acquireOAuth2Token({ ...baseParams, fetchToken });
    expect(t).toBe('AT-1');
    expect(fetchToken).toHaveBeenCalledWith('https://login.example.com/oauth2/token', expect.objectContaining({ method: 'POST' }));
  });

  it('🚨 authStyle=body → client_id/client_secret nel form, niente Authorization', async () => {
    const fetchToken: TokenFetcher = vi.fn(async (_url, init) => {
      const headers = init.headers as Headers;
      expect(headers.get('Authorization')).toBeNull();
      const body = String(init.body);
      expect(body).toContain('client_id=cid');
      expect(body).toContain('client_secret=csecret');
      return jsonRes({ access_token: 'AT-body', expires_in: 100 });
    });
    const t = await acquireOAuth2Token({ ...baseParams, authStyle: 'body', fetchToken });
    expect(t).toBe('AT-body');
  });

  it('scope incluso nel body solo se valorizzato (trim)', async () => {
    const seen: string[] = [];
    const fetchToken: TokenFetcher = async (_url, init) => { seen.push(String(init.body)); return jsonRes({ access_token: 'x', expires_in: 99 }); };
    await acquireOAuth2Token({ ...baseParams, scope: '  read write  ', fetchToken });
    expect(seen[0]).toContain('scope=read+write');
    clearOAuth2TokenCache();
    await acquireOAuth2Token({ ...baseParams, scope: '   ', fetchToken });
    expect(seen[1]).not.toContain('scope=');
  });
});

describe('acquireOAuth2Token — caching & scadenza', () => {
  it('🚨 token valido in cache → NON richiama il token endpoint', async () => {
    const fetchToken = vi.fn<TokenFetcher>(async () => jsonRes({ access_token: 'AT', expires_in: 3600 }));
    let clock = 1_000_000;
    const now = () => clock;
    const t1 = await acquireOAuth2Token({ ...baseParams, fetchToken, now });
    clock += 60_000; // +1 min, ben dentro la validità (1h)
    const t2 = await acquireOAuth2Token({ ...baseParams, fetchToken, now });
    expect(t1).toBe('AT');
    expect(t2).toBe('AT');
    expect(fetchToken).toHaveBeenCalledTimes(1); // cache hit
  });

  it('🚨 token scaduto → refetch', async () => {
    const fetchToken = vi.fn<TokenFetcher>()
      .mockResolvedValueOnce(jsonRes({ access_token: 'OLD', expires_in: 100 }))
      .mockResolvedValueOnce(jsonRes({ access_token: 'NEW', expires_in: 100 }));
    let clock = 0;
    const now = () => clock;
    expect(await acquireOAuth2Token({ ...baseParams, fetchToken, now })).toBe('OLD');
    clock += 200_000; // oltre i 100s di validità
    expect(await acquireOAuth2Token({ ...baseParams, fetchToken, now })).toBe('NEW');
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it('🚨 margine refresh: token ENTRO 30s dalla scadenza → refetch anticipato', async () => {
    const fetchToken = vi.fn<TokenFetcher>()
      .mockResolvedValueOnce(jsonRes({ access_token: 'A', expires_in: 100 }))
      .mockResolvedValueOnce(jsonRes({ access_token: 'B', expires_in: 100 }));
    let clock = 0;
    const now = () => clock;
    await acquireOAuth2Token({ ...baseParams, fetchToken, now });
    clock = 80_000; // scade a 100s, margine 30s → soglia 70s superata
    expect(await acquireOAuth2Token({ ...baseParams, fetchToken, now })).toBe('B');
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it('chiavi cache distinte per scope diverso (no leak di token tra scope)', async () => {
    const fetchToken = vi.fn<TokenFetcher>()
      .mockResolvedValueOnce(jsonRes({ access_token: 'SCOPE-A', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonRes({ access_token: 'SCOPE-B', expires_in: 3600 }));
    const a = await acquireOAuth2Token({ ...baseParams, scope: 'a', fetchToken });
    const b = await acquireOAuth2Token({ ...baseParams, scope: 'b', fetchToken });
    expect(a).toBe('SCOPE-A');
    expect(b).toBe('SCOPE-B');
  });
});

describe('acquireOAuth2Token — input ROTTI del token endpoint (bug-bounty)', () => {
  it('🚨 non-2xx → throw con status + body troncato', async () => {
    const fetchToken: TokenFetcher = async () => new Response('invalid_client', { status: 401, statusText: 'Unauthorized' });
    await expect(acquireOAuth2Token({ ...baseParams, fetchToken })).rejects.toThrow(/401.*invalid_client/s);
  });

  it('🚨 2xx ma senza access_token → throw chiaro', async () => {
    const fetchToken: TokenFetcher = async () => jsonRes({ token_type: 'Bearer', expires_in: 3600 });
    await expect(acquireOAuth2Token({ ...baseParams, fetchToken })).rejects.toThrow(/nessun access_token/i);
  });

  it('🚨 access_token non-stringa (number) → trattato come assente → throw', async () => {
    const fetchToken: TokenFetcher = async () => jsonRes({ access_token: 12345, expires_in: 3600 });
    await expect(acquireOAuth2Token({ ...baseParams, fetchToken })).rejects.toThrow(/nessun access_token/i);
  });

  it('🚨 risposta non-JSON → throw chiaro', async () => {
    const fetchToken: TokenFetcher = async () => new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    await expect(acquireOAuth2Token({ ...baseParams, fetchToken })).rejects.toThrow(/non-JSON/i);
  });

  it('🚨 expires_in mancante → default 3600 (cache valida, non refetch immediato)', async () => {
    const fetchToken = vi.fn<TokenFetcher>(async () => jsonRes({ access_token: 'NOEXP' }));
    let clock = 0; const now = () => clock;
    await acquireOAuth2Token({ ...baseParams, fetchToken, now });
    clock = 1000_000; // ~16 min, < 1h → ancora valido
    await acquireOAuth2Token({ ...baseParams, fetchToken, now });
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it('🚨 expires_in negativo/NaN → default 3600 (no cache già-scaduta = no refetch loop)', async () => {
    for (const bad of [-5, NaN, 0]) {
      clearOAuth2TokenCache();
      const fetchToken = vi.fn<TokenFetcher>(async () => jsonRes({ access_token: 'T', expires_in: bad }));
      let clock = 0; const now = () => clock;
      await acquireOAuth2Token({ ...baseParams, fetchToken, now });
      clock = 60_000; // 1 min: col default 3600s è ancora valido
      await acquireOAuth2Token({ ...baseParams, fetchToken, now });
      expect(fetchToken, `expires_in=${String(bad)}`).toHaveBeenCalledTimes(1);
    }
  });
});
