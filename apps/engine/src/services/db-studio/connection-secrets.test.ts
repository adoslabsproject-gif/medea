/**
 * connection-secrets — encryption-at-rest dei secret DB Studio (fix 2026-06-15).
 * Bug-bounty: roundtrip, no-plaintext-nel-blob, salt per-tenant, idempotenza
 * (no doppia cifratura), vault:/vuoto invariati, no-mutation, malformato → throw.
 * Usa la crypto REALE (master password dev-sentinel in test) — niente mock.
 */
import { describe, it, expect } from 'vitest';
import type { Database } from '@medea/engine-db-studio-core';
import {
  sealSecret, unsealSecret, sealConnectionSecrets, unsealConnectionSecrets, isSealed, ENC_PREFIX,
} from './connection-secrets.js';

const T = 'tenant-A';
function conn(pw?: string): Database['connection'] {
  return { engine: 'postgres', embedded: false, ...(pw !== undefined ? { passwordSecretRef: pw } : {}) } as Database['connection'];
}
function pwOf(c: Database['connection']): unknown {
  return (c as Record<string, unknown>).passwordSecretRef;
}

describe('sealSecret / unsealSecret', () => {
  it('roundtrip e NESSUN plaintext nel blob', () => {
    const sealed = sealSecret('hunter2!', T);
    expect(sealed.startsWith(ENC_PREFIX)).toBe(true);
    expect(sealed).not.toContain('hunter2!');
    expect(unsealSecret(sealed, T)).toBe('hunter2!');
  });
  it('nonce random → due seal dello stesso valore differiscono (no ECB-like leak)', () => {
    expect(sealSecret('same', T)).not.toBe(sealSecret('same', T));
  });
  it('salt per-tenant: un tenant diverso NON decifra (auth-tag fail)', () => {
    const sealed = sealSecret('hunter2!', T);
    expect(() => unsealSecret(sealed, 'tenant-B')).toThrow();
  });
  it('unsealSecret su valore non-enc: → invariato (literal/vault backward-compat)', () => {
    expect(unsealSecret('plain-literal', T)).toBe('plain-literal');
    expect(unsealSecret('vault:secret/db#pw', T)).toBe('vault:secret/db#pw');
  });
  it('blob malformato → throw (no silent-empty)', () => {
    expect(() => unsealSecret(`${ENC_PREFIX}garbage-no-separator`, T)).toThrow();
  });
  it('isSealed', () => {
    expect(isSealed(sealSecret('x', T))).toBe(true);
    expect(isSealed('plain')).toBe(false);
    expect(isSealed('vault:x')).toBe(false);
    expect(isSealed(undefined)).toBe(false);
  });
});

describe('sealConnectionSecrets', () => {
  it('cifra il passwordSecretRef letterale (a riposo niente plaintext)', () => {
    const out = sealConnectionSecrets(conn('plain-pw'), T);
    expect(String(pwOf(out)).startsWith(ENC_PREFIX)).toBe(true);
    expect(unsealSecret(String(pwOf(out)), T)).toBe('plain-pw');
  });
  it('vault: invariato (risolto altrove)', () => {
    expect(pwOf(sealConnectionSecrets(conn('vault:x'), T))).toBe('vault:x');
  });
  it('idempotente: un enc: non viene ri-cifrato', () => {
    const once = sealConnectionSecrets(conn('plain'), T);
    const twice = sealConnectionSecrets(once, T);
    expect(pwOf(twice)).toBe(pwOf(once));
  });
  it('vuoto/assente → invariato', () => {
    expect(pwOf(sealConnectionSecrets(conn(''), T))).toBe('');
    expect(pwOf(sealConnectionSecrets(conn(), T))).toBeUndefined();
  });
  it('NON muta l\'input', () => {
    const c = conn('plain');
    sealConnectionSecrets(c, T);
    expect(pwOf(c)).toBe('plain');
  });
});

describe('unsealConnectionSecrets', () => {
  it('enc: → plaintext; literal/vault invariati', () => {
    const sealed = sealConnectionSecrets(conn('p'), T);
    expect(pwOf(unsealConnectionSecrets(sealed, T))).toBe('p');
    expect(pwOf(unsealConnectionSecrets(conn('lit'), T))).toBe('lit');
    expect(pwOf(unsealConnectionSecrets(conn('vault:y'), T))).toBe('vault:y');
  });
});
