/**
 * secure-dispatcher — test 2026-grade (unit + integrazione reale).
 *
 * Unit: `secureLookup` valida ogni IP risolto e fallisce su privati (dns mockato).
 * Integrazione: Agent undici REALE + server HTTP REALE su 127.0.0.1 + `fetch`
 * globale con `dispatcher` → prova che la connessione viene BLOCCATA a livello
 * socket quando un hostname risolve a loopback (zero TOCTOU, copre ogni hop).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

// Mock node:dns (callback form) — `secureLookup` lo usa internamente.
// `impl(host)` decide la risoluzione per ogni test (host-aware).
const dnsState = vi.hoisted(() => ({
  impl: ((_host: string): { address: string; family: number }[] => [{ address: '93.184.216.34', family: 4 }]),
}));
vi.mock('node:dns', () => ({
  lookup: (host: string, _opts: unknown, cb: (err: unknown, addrs: unknown) => void) => {
    try { cb(null, dnsState.impl(String(host))); }
    catch (e) { cb(e, undefined); }
  },
}));

import {
  secureLookup,
  getSecureDispatcher,
  getPermissiveDispatcher,
  installGlobalSecureDispatcher,
  __resetSecureDispatcherForTest,
  SsrfConnectBlockedError,
} from './secure-dispatcher.js';

beforeEach(() => {
  dnsState.impl = () => [{ address: '93.184.216.34', family: 4 }];
  __resetSecureDispatcherForTest();
});

/** Promisify del callback di secureLookup (forma all:true). */
function lookupAll(host: string): Promise<{ address: string; family: number }[]> {
  return new Promise((resolve, reject) => {
    secureLookup(host, { all: true }, (err, addrs) => {
      if (err) reject(err);
      else resolve(addrs as { address: string; family: number }[]);
    });
  });
}

describe('secureLookup — validazione IP risolti', () => {
  it('IP pubblico → passa, ritorna la lista validata (all:true)', async () => {
    dnsState.impl = () => [{ address: '93.184.216.34', family: 4 }];
    const addrs = await lookupAll('public.example.com');
    expect(addrs).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('risolve a 127.0.0.1 → SsrfConnectBlockedError (code ENETUNREACH)', async () => {
    dnsState.impl = () => [{ address: '127.0.0.1', family: 4 }];
    await expect(lookupAll('rebind.evil.test')).rejects.toBeInstanceOf(SsrfConnectBlockedError);
    await expect(lookupAll('rebind.evil.test')).rejects.toMatchObject({ code: 'ENETUNREACH' });
  });

  it('risolve a 169.254.169.254 (metadata) → bloccato', async () => {
    dnsState.impl = () => [{ address: '169.254.169.254', family: 4 }];
    await expect(lookupAll('metadata.evil.test')).rejects.toBeInstanceOf(SsrfConnectBlockedError);
  });

  it('multi-record con UN solo IP privato → bloccato (no pick fortunato)', async () => {
    dnsState.impl = () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ];
    await expect(lookupAll('mixed.evil.test')).rejects.toBeInstanceOf(SsrfConnectBlockedError);
  });

  it('messaggio errore contiene host + IP offending (diagnostica)', async () => {
    dnsState.impl = () => [{ address: '10.1.2.3', family: 4 }];
    await lookupAll('x.evil.test').catch((e: Error) => {
      expect(e.message).toContain('x.evil.test');
      expect(e.message).toContain('10.1.2.3');
    });
  });

  it('errore DNS (NXDOMAIN) → propagato verbatim (no falso "safe")', async () => {
    dnsState.impl = () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); };
    await expect(lookupAll('nope.invalid')).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });

  it('forma single (all:false) → ritorna (address, family) del primo validato', async () => {
    dnsState.impl = () => [{ address: '1.1.1.1', family: 4 }];
    const out = await new Promise<{ a: string; f: number }>((resolve, reject) => {
      secureLookup('one.example.com', { all: false }, (err, address, family) => {
        if (err) reject(err);
        else resolve({ a: address as string, f: family! });
      });
    });
    expect(out).toEqual({ a: '1.1.1.1', f: 4 });
  });
});

describe('getSecureDispatcher — singleton', () => {
  it('ritorna la STESSA istanza Agent (pool riusato)', () => {
    const a = getSecureDispatcher();
    const b = getSecureDispatcher();
    expect(a).toBe(b);
  });
  it('dopo reset → nuova istanza', () => {
    const a = getSecureDispatcher();
    __resetSecureDispatcherForTest();
    const b = getSecureDispatcher();
    expect(a).not.toBe(b);
  });
  it('permissivo: singleton + DIVERSO dal sicuro (no lookup hook)', () => {
    const p1 = getPermissiveDispatcher();
    const p2 = getPermissiveDispatcher();
    expect(p1).toBe(p2);
    expect(p1).not.toBe(getSecureDispatcher());
  });
  it('🚨 insecureTls: singleton + DIVERSO da sicuro e permissivo; reset lo azzera', async () => {
    const { getInsecureTlsDispatcher } = await import('./secure-dispatcher.js');
    const i1 = getInsecureTlsDispatcher();
    expect(getInsecureTlsDispatcher()).toBe(i1);
    expect(i1).not.toBe(getSecureDispatcher());
    expect(i1).not.toBe(getPermissiveDispatcher());
    __resetSecureDispatcherForTest();
    expect(getInsecureTlsDispatcher()).not.toBe(i1);
  });
});

describe('installGlobalSecureDispatcher — protegge il fetch RAW (action_http & co.)', () => {
  it('installa il dispatcher sicuro come globale → fetch raw verso hostname→privato BLOCCATO', async () => {
    const { getGlobalDispatcher, setGlobalDispatcher } = await import('undici');
    const prev = getGlobalDispatcher();
    try {
      // Hostname che risolve a loopback (rebinding). Il dispatcher globale usa
      // secureLookup → blocca PRIMA della connessione (niente server necessario).
      dnsState.impl = () => [{ address: '127.0.0.1', family: 4 }];
      installGlobalSecureDispatcher();
      // fetch RAW (NESSUN dispatcher per-call) → usa il globale sicuro → bloccato.
      await expect(fetch('http://rebind.global.test/leak')).rejects.toThrow();
    } finally {
      setGlobalDispatcher(prev); // ripristina per non inquinare gli altri test
    }
  });
});

describe('INTEGRAZIONE: Agent undici reale + fetch globale + server localhost', () => {
  let server: Server;
  let port: number;
  let hits = 0;

  beforeEach(async () => {
    hits = 0;
    server = createServer((_req, res) => { hits += 1; res.statusCode = 200; res.end('REACHED'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('CONTROLLO: senza dispatcher, il server su 127.0.0.1 è raggiungibile', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('REACHED');
    expect(hits).toBe(1);
  });

  it('hostname che RISOLVE a 127.0.0.1 + secure dispatcher → CONNESSIONE BLOCCATA', async () => {
    // Simula rebinding: l'hostname "rebind.test" risolve a loopback. Il lookup
    // hook deve far fallire la connessione PRIMA che la socket raggiunga il
    // server. È la prova connection-time (zero TOCTOU).
    dnsState.impl = (host) => host === 'rebind.test'
      ? [{ address: '127.0.0.1', family: 4 }]
      : [{ address: '93.184.216.34', family: 4 }];
    const dispatcher = getSecureDispatcher();
    await expect(
      // `Agent` viene da undici; il `Dispatcher` che i tipi di Node dichiarano
      // dentro RequestInit viene da un'altra copia di undici-types. A runtime è
      // lo stesso oggetto, per il compilatore no — e con
      // `exactOptionalPropertyTypes` le due dichiarazioni non combaciano.
      fetch(`http://rebind.test:${port}/`, { dispatcher } as unknown as RequestInit),
    ).rejects.toThrow();
    // Il server NON deve aver ricevuto NULLA.
    expect(hits).toBe(0);
  });
});
