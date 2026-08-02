/**
 * Bug-bounty test — registry-secret (la fonte UNICA del secret che firma i
 * custom node).
 *
 * Incidente owner 2026-06-12 (Streammy): il secret derivava da
 * MEDEA_INTERNAL_TOKEN, che onboarding.ts rigenera (`randomBytes(32)`) a
 * ogni recreate del container → ogni recreate cambiava il secret → tutte le
 * firme dei custom node diventavano `signature_mismatch` → nodi bloccati.
 *
 * Le proprietà che questi test inchiodano:
 *   1. STABILITÀ: a parità di SSO_SECRET + tenantId il secret è IDENTICO, anche
 *      se INTERNAL_TOKEN cambia (è la regressione che ha rotto Streammy).
 *   2. ISOLAMENTO per-tenant: tenant diversi → secret diversi (un tenant non
 *      può forgiare la firma di un altro nemmeno conoscendo il proprio).
 *   3. OVERRIDE ops esplicito vince (rotation controllata).
 *   4. Fallback dev/test senza SSO.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registrySecret } from './registry-secret.js';

const ENV_KEYS = [
  'MEDEA_REGISTRY_SECRET',
  'MEDEA_SSO_SECRET',
  'MEDEA_TENANT_ID',
  'MEDEA_INTERNAL_TOKEN',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] !== undefined) process.env[k] = saved[k];
    else delete process.env[k];
  }
});

const SSO = 'a'.repeat(64); // MEDEA_SSO_SECRET in prod è lungo (≥16)
const TENANT = 'd43e6f82-b056-4481-8284-8b812f499b77';

describe('registrySecret — derivazione STABILE da SSO_SECRET', () => {
  it('🔒 REGRESSIONE STREAMMY: cambiare INTERNAL_TOKEN NON cambia il secret', () => {
    process.env.MEDEA_SSO_SECRET = SSO;
    process.env.MEDEA_TENANT_ID = TENANT;

    process.env.MEDEA_INTERNAL_TOKEN = 'token-prima-del-recreate';
    const before = registrySecret();
    // recreate del container: onboarding rigenera randomBytes(32)
    process.env.MEDEA_INTERNAL_TOKEN = 'token-DOPO-il-recreate-completamente-diverso';
    const after = registrySecret();

    expect(after).toBe(before); // <- il bug era qui: prima cambiava
  });

  it('deterministico: stessi SSO+tenant → stesso secret (HMAC stabile)', () => {
    process.env.MEDEA_SSO_SECRET = SSO;
    process.env.MEDEA_TENANT_ID = TENANT;
    expect(registrySecret()).toBe(registrySecret());
  });

  it('formato: hex sha256 (64 char) — è un HMAC-SHA256', () => {
    process.env.MEDEA_SSO_SECRET = SSO;
    process.env.MEDEA_TENANT_ID = TENANT;
    expect(registrySecret()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('🔒 ISOLAMENTO: tenant diversi (stesso SSO) → secret DIVERSI', () => {
    process.env.MEDEA_SSO_SECRET = SSO;
    process.env.MEDEA_TENANT_ID = 'tenant-A';
    const a = registrySecret();
    process.env.MEDEA_TENANT_ID = 'tenant-B';
    const b = registrySecret();
    expect(a).not.toBe(b);
  });

  it('🔒 SSO diversi (stesso tenant) → secret DIVERSI (non si forgia senza SSO_SECRET)', () => {
    process.env.MEDEA_TENANT_ID = TENANT;
    process.env.MEDEA_SSO_SECRET = 'b'.repeat(64);
    const a = registrySecret();
    process.env.MEDEA_SSO_SECRET = 'c'.repeat(64);
    const b = registrySecret();
    expect(a).not.toBe(b);
  });

  it('override esplicito MEDEA_REGISTRY_SECRET vince su tutto (rotation ops)', () => {
    process.env.MEDEA_REGISTRY_SECRET = 'rotazione-controllata-ops';
    process.env.MEDEA_SSO_SECRET = SSO;
    process.env.MEDEA_TENANT_ID = TENANT;
    process.env.MEDEA_INTERNAL_TOKEN = 'qualsiasi';
    expect(registrySecret()).toBe('rotazione-controllata-ops');
  });

  it('SSO troppo corto (<16) → NON deriva, fallback a INTERNAL_TOKEN', () => {
    process.env.MEDEA_SSO_SECRET = 'corto'; // <16
    process.env.MEDEA_TENANT_ID = TENANT;
    process.env.MEDEA_INTERNAL_TOKEN = 'fallback-token';
    expect(registrySecret()).toBe('fallback-token');
  });

  it('SSO presente ma tenantId mancante → fallback a INTERNAL_TOKEN', () => {
    process.env.MEDEA_SSO_SECRET = SSO;
    process.env.MEDEA_INTERNAL_TOKEN = 'fallback-token';
    expect(registrySecret()).toBe('fallback-token');
  });

  it('niente SSO né token → stringa vuota (loader fail-closed gestisce il caso)', () => {
    expect(registrySecret()).toBe('');
  });

  it('soglia esatta: SSO di 16 char (≥16) → deriva, non fa fallback', () => {
    process.env.MEDEA_SSO_SECRET = 'x'.repeat(16);
    process.env.MEDEA_TENANT_ID = TENANT;
    process.env.MEDEA_INTERNAL_TOKEN = 'NON-deve-uscire-questo';
    const out = registrySecret();
    expect(out).toMatch(/^[0-9a-f]{64}$/);
    expect(out).not.toBe('NON-deve-uscire-questo');
  });
});
