/**
 * Test dei rilievi del revisore su oauth2.ts — anti-regressione mirata.
 *   R2 — eviction REALE (cap hard + LRU recency), non un trigger di GC.
 *   R4 — clientSecret NON in chiaro nella chiave (hash sha256).
 *   R5 — risposta del token endpoint cappata (anti-OOM).
 *   NF1 — coalescing delle richieste concorrenti in volo.
 * Ogni test FALLISCE sul codice pre-fix (mutation-verify).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  acquireOAuth2Token,
  cacheKey,
  clearOAuth2TokenCache,
  type TokenFetcher,
  type OAuth2Params,
} from './oauth2.js';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
const base = {
  tokenUrl: 'https://id.example.com/token',
  clientId: 'cid',
  clientSecret: 'S3CR3T-RAW',
  authStyle: 'header' as const,
};

beforeEach(() => {
  clearOAuth2TokenCache();
});

describe('R4 — clientSecret non in chiaro nella chiave cache', () => {
  it('🚨 cacheKey è un digest hex (64 char) e NON contiene il secret raw', async () => {
    const key = await cacheKey(base as OAuth2Params);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('S3CR3T-RAW');
    expect(key).not.toContain('cid');
  });

  it('secret diverso → chiave diversa (la rotation invalida il token, invariato)', async () => {
    const k1 = await cacheKey(base as OAuth2Params);
    const k2 = await cacheKey({ ...base, clientSecret: 'ALTRO' } as OAuth2Params);
    expect(k1).not.toBe(k2);
  });
});

describe('R5 — risposta token endpoint cappata (anti-OOM)', () => {
  it('🚨 body oltre il cap (1 MB) → throw "troppo grande", niente OOM', async () => {
    const huge = 'x'.repeat(2 * 1024 * 1024); // 2 MB > cap
    const fetchToken: TokenFetcher = async () =>
      new Response(huge, { status: 200, headers: { 'content-type': 'application/json' } });
    await expect(acquireOAuth2Token({ ...base, fetchToken })).rejects.toThrow(/troppo grande/i);
  });

  it('body piccolo valido → passa normalmente', async () => {
    const fetchToken: TokenFetcher = async () => jsonRes({ access_token: 'AT', expires_in: 3600 });
    expect(await acquireOAuth2Token({ ...base, fetchToken })).toBe('AT');
  });
});

describe('R2 — eviction reale (cap hard + LRU recency)', () => {
  // Inserisce N>MAX token TUTTI validi (mai scaduti): senza eviction reale la cache
  // crescerebbe illimitata. Metrica osservabile = n. di chiamate a fetchToken (un
  // cache-miss = una chiamata in più).
  it('🚨 cap HARD: con 250 credenziali tutte valide, le più VECCHIE sono evictate', async () => {
    let calls = 0;
    const fetchToken: TokenFetcher = async () => {
      calls += 1;
      return jsonRes({ access_token: 'AT', expires_in: 99_999 });
    };
    const now = () => 1_000_000; // clock fisso → niente scadenze
    for (let i = 0; i < 250; i += 1) {
      await acquireOAuth2Token({ ...base, clientId: `c${i.toString()}`, fetchToken, now });
    }
    expect(calls).toBe(250);
    // Il più RECENTE (c249) è in cache → hit (nessuna nuova chiamata).
    await acquireOAuth2Token({ ...base, clientId: 'c249', fetchToken, now });
    expect(calls).toBe(250);
    // Il più VECCHIO (c0) è stato evictato (cap 200) → miss → refetch.
    await acquireOAuth2Token({ ...base, clientId: 'c0', fetchToken, now });
    expect(calls).toBe(251);
  });

  it('🚨 LRU recency: una entry RIUSATA non viene droppata per prima', async () => {
    let calls = 0;
    const fetchToken: TokenFetcher = async () => {
      calls += 1;
      return jsonRes({ access_token: 'AT', expires_in: 99_999 });
    };
    const now = () => 1_000_000;
    // Riempi la cache fino al cap (200 entry: c0..c199).
    for (let i = 0; i < 200; i += 1) {
      await acquireOAuth2Token({ ...base, clientId: `c${i.toString()}`, fetchToken, now });
    }
    expect(calls).toBe(200);
    // Riusa c0 → LRU bump (va in coda, non è più il più vecchio).
    await acquireOAuth2Token({ ...base, clientId: 'c0', fetchToken, now });
    expect(calls).toBe(200); // hit
    // Inserisci 2 nuovi → evict 2 oldest. Con LRU, i più vecchi sono c1,c2 (NON c0).
    await acquireOAuth2Token({ ...base, clientId: 'c200', fetchToken, now });
    await acquireOAuth2Token({ ...base, clientId: 'c201', fetchToken, now });
    expect(calls).toBe(202);
    // c0 è ancora in cache (salvato dal bump LRU) → hit, niente refetch.
    await acquireOAuth2Token({ ...base, clientId: 'c0', fetchToken, now });
    expect(calls).toBe(202);
  });
});

describe('NF1 — coalescing delle richieste in volo', () => {
  it('🚨 N chiamate CONCORRENTI con stesse credenziali → 1 sola fetch al token endpoint', async () => {
    let calls = 0;
    let release!: (r: Response) => void;
    const gate = new Promise<Response>((res) => {
      release = res;
    });
    // fetchToken resta "appeso" finché non rilasciamo → le 3 chiamate si sovrappongono.
    const fetchToken: TokenFetcher = () => {
      calls += 1;
      return gate;
    };
    const params = { ...base, fetchToken };

    const a = acquireOAuth2Token(params);
    const b = acquireOAuth2Token(params);
    const c = acquireOAuth2Token(params);
    // Lascia girare i microtask (await cacheKey + registrazione inFlight) prima di rilasciare.
    await Promise.resolve();
    release(jsonRes({ access_token: 'AT', expires_in: 3600 }));

    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect([ra, rb, rc]).toEqual(['AT', 'AT', 'AT']);
    expect(calls).toBe(1); // coalescing: 1 sola richiesta, non 3
  });

  it('🚨 dopo il completamento la entry in-flight è liberata → la nuova ondata fa cache-hit', async () => {
    let calls = 0;
    const fetchToken: TokenFetcher = () => {
      calls += 1;
      return Promise.resolve(jsonRes({ access_token: 'AT', expires_in: 99_999 }));
    };
    const now = () => 1_000_000;
    await acquireOAuth2Token({ ...base, fetchToken, now }); // 1 fetch, popola cache
    await acquireOAuth2Token({ ...base, fetchToken, now }); // cache-hit (in-flight già liberata)
    expect(calls).toBe(1);
  });

  it('🚨 credenziali DIVERSE in concorrenza → richieste separate (no coalescing errato)', async () => {
    let calls = 0;
    const fetchToken: TokenFetcher = async () => {
      calls += 1;
      return jsonRes({ access_token: 'AT', expires_in: 3600 });
    };
    await Promise.all([
      acquireOAuth2Token({ ...base, clientId: 'A', fetchToken }),
      acquireOAuth2Token({ ...base, clientId: 'B', fetchToken }),
    ]);
    expect(calls).toBe(2); // key diverse → niente coalescing
  });
});
