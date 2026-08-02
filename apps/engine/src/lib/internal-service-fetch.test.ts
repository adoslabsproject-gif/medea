/**
 * internal-service-fetch — test 2026-grade. Verifica il CONFINE DI FIDUCIA:
 *  - i servizi interni registrati ottengono il bypass SSRF (allowPrivateHost);
 *  - QUALSIASI altro IP privato (tentativo SSRF via endpoint user-overridable)
 *    NON lo ottiene → resta protetto da safeOutboundFetch.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock safeOutboundFetch per ispezionare le opzioni con cui viene chiamato.
const calls: { url: string; opts: { allowPrivateHost?: boolean } }[] = [];
vi.mock('@/lib/safe-outbound-fetch.js', () => ({
  safeOutboundFetch: vi.fn(async (url: string, opts: { allowPrivateHost?: boolean } = {}) => {
    calls.push({ url, opts });
    return new Response('ok', { status: 200 });
  }),
}));

import {
  isInternalServiceUrl,
  internalAwareFetch,
  internalServiceUrls,
  __resetInternalServiceCacheForTest,
} from './internal-service-fetch.js';

const ENV_KEYS = ['PORTAL_INTERNAL_URL', 'LIARA_URL', 'CODE_RUNNER_URL', 'WHISPER_URL', 'VISION_URL', 'MEDEA_RUNTIME_URL'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  calls.length = 0;
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  __resetInternalServiceCacheForTest();
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  __resetInternalServiceCacheForTest();
});

describe('isInternalServiceUrl — registro dei NOSTRI servizi', () => {
  it.each([
    'http://host.docker.internal:3006/api/v1/internal/x', // portal
    'http://host.docker.internal:3003/v1/complete',       // liara
    'http://host.docker.internal:5003/execute',           // code-runner
    'http://host.docker.internal:5005/transcribe',        // whisper
    'http://host.docker.internal:5004/analyze',           // vision
    'http://127.0.0.1:3100/api/v1/db/insert',             // runtime loopback
  ])('riconosce il servizio interno registrato: %s', (url) => {
    expect(isInternalServiceUrl(url)).toBe(true);
  });

  it.each([
    'https://api.github.com/zen',          // esterno pubblico
    'http://10.0.0.5/secret',              // IP privato ARBITRARIO (non nostro)
    'http://169.254.169.254/latest/meta',  // cloud metadata
    'http://host.docker.internal:9999/x',  // host.docker.internal ma PORTA non-nostra
    'http://127.0.0.1:6379/',              // loopback ma porta Redis, non registrata
    'not a url',
  ])('NON è interno (resta protetto): %s', (url) => {
    expect(isInternalServiceUrl(url)).toBe(false);
  });
});

describe('internalAwareFetch — concede il bypass SOLO ai servizi registrati', () => {
  it('servizio interno (Liara) → safeOutboundFetch con allowPrivateHost:true', async () => {
    await internalAwareFetch('http://host.docker.internal:3003/v1/complete', { method: 'POST' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts.allowPrivateHost).toBe(true);
  });

  it('host esterno pubblico → safeOutboundFetch SENZA allowPrivateHost (protetto normale)', async () => {
    await internalAwareFetch('https://api.openai.com/v1/x', { method: 'POST' });
    expect(calls[0]!.opts.allowPrivateHost).toBeUndefined();
  });

  it('🔒 SICUREZZA: endpoint user→IP privato ARBITRARIO NON ottiene il bypass (SSRF resta bloccato)', async () => {
    // Scenario reale: video_summarizer cfg.whisperEndpoint = "http://10.0.0.5/".
    // Se ottenesse allowPrivateHost sarebbe un buco SSRF. Deve restare protetto.
    await internalAwareFetch('http://10.0.0.5/internal-secret', { method: 'POST' });
    expect(calls[0]!.opts.allowPrivateHost).toBeUndefined();
  });

  it('🔒 SICUREZZA: host.docker.internal su PORTA non registrata NON ottiene il bypass', async () => {
    // Un attacker non può raggiungere una porta arbitraria del gateway Docker.
    await internalAwareFetch('http://host.docker.internal:6379/', {});
    expect(calls[0]!.opts.allowPrivateHost).toBeUndefined();
  });
});

describe('internalAwareFetch — scope per-callsite (allowlist minima)', () => {
  it('scope corretto (whisper→whisper) → bypass concesso', async () => {
    await internalAwareFetch('http://host.docker.internal:5005/transcribe', {}, { allow: 'whisper' });
    expect(calls[0]!.opts.allowPrivateHost).toBe(true);
  });

  it('🔒 SICUREZZA: endpoint user DEVIATO su un ALTRO nostro servizio (whisper→Liara) → NIENTE bypass', async () => {
    // cfg.whisperEndpoint = "http://host.docker.internal:3003" (Liara, non whisper).
    // Lo scope 'whisper' NON concede il bypass per l'origin Liara.
    await internalAwareFetch('http://host.docker.internal:3003/transcribe', {}, { allow: 'whisper' });
    expect(calls[0]!.opts.allowPrivateHost).toBeUndefined();
  });

  it('scope + endpoint esterno pubblico → safeOutboundFetch normale (no bypass, ma funziona)', async () => {
    await internalAwareFetch('https://whisper.mio.com/transcribe', {}, { allow: 'whisper' });
    expect(calls[0]!.opts.allowPrivateHost).toBeUndefined();
  });

  it('scope + IP privato arbitrario → niente bypass (SSRF bloccato)', async () => {
    await internalAwareFetch('http://10.0.0.5/transcribe', {}, { allow: 'whisper' });
    expect(calls[0]!.opts.allowPrivateHost).toBeUndefined();
  });
});

describe('registro — env override + memoizzazione', () => {
  it('LIARA_URL via env entra nel registro', () => {
    process.env.LIARA_URL = 'http://liara-prod.internal:8080';
    __resetInternalServiceCacheForTest();
    expect(isInternalServiceUrl('http://liara-prod.internal:8080/v1/complete')).toBe(true);
    // Il default vecchio non è più registrato.
    expect(isInternalServiceUrl('http://host.docker.internal:3003/v1/complete')).toBe(false);
  });

  it('internalServiceUrls() espone i 6 servizi noti', () => {
    const u = internalServiceUrls();
    expect(Object.keys(u).sort()).toEqual(['codeRunner', 'liara', 'portal', 'runtime', 'vision', 'whisper']);
  });

  it('i default dei servizi sono coerenti col registro (no drift)', () => {
    __resetInternalServiceCacheForTest();
    for (const url of Object.values(internalServiceUrls())) {
      expect(isInternalServiceUrl(url), url).toBe(true);
    }
  });
});

describe('🛡 anti-regressione: i callsite interni usano internalAwareFetch (no raw safeOutboundFetch)', () => {
  // Guard source-inspection: se un domani qualcuno rimette safeOutboundFetch raw
  // su un servizio host.docker.internal, la difesa DNS-rebinding lo ri-rompe in
  // silenzio. Questo test lo becca a build-time.
  const ROOT = join(__dirname, '..'); // .../src

  it.each([
    'executors/db-write.ts',
    'executors/run-python.ts',
    'executors/video-summarizer.ts',
    'lib/telemetry-emitter.ts',
  ])('%s usa internalAwareFetch e NON importa safeOutboundFetch', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    expect(src, `${rel} deve usare internalAwareFetch`).toMatch(/internalAwareFetch/);
    expect(src, `${rel} non deve chiamare safeOutboundFetch raw`).not.toMatch(/\bsafeOutboundFetch\s*\(/);
  });

  // Fase 2 (#14): legal-compliance e debug-run-failure NON fanno più fetch
  // diretti verso servizi interni — la chiamata AI passa da dispatchLLMChat
  // (gateway metered). Il guard qui impedisce la REINTRODUZIONE del percorso
  // morto (`LIARA_URL/v1/complete`: route inesistente + 401 internalAuth) e
  // di qualsiasi fetch raw.
  it.each([
    'executors/legal-compliance.ts',
    'executors/debug-run-failure.ts',
  ])('%s usa dispatchLLMChat e NON reintroduce /v1/complete né fetch raw', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    expect(src, `${rel} deve usare dispatchLLMChat (gateway metered)`).toMatch(/dispatchLLMChat/);
    expect(src, `${rel} non deve tornare al percorso morto /v1/complete`).not.toMatch(/v1\/complete/);
    expect(src, `${rel} non deve chiamare safeOutboundFetch raw`).not.toMatch(/\bsafeOutboundFetch\s*\(/);
  });
});
