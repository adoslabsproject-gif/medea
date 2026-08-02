/**
 * Bug-bounty test — custom-node-integrity (firma/integrità pacchetti registry).
 *
 * Cerca i bug VERI di questa classe di sicurezza:
 *   - round-trip: make → verify valido;
 *   - TAMPER su ogni campo dei sorgenti → digest_mismatch (la difesa centrale);
 *   - firma forgiata / secret sbagliato → signature_mismatch;
 *   - canonicalizzazione NON ambigua: due pacchetti diversi che si potrebbero
 *     "confondere" con delimiter naïf → digest DIVERSI (anti collision/injection);
 *   - determinismo del digest;
 *   - record malformato/algo sconosciuto → verdict esplicito (no crash, no true).
 */
import { describe, it, expect } from 'vitest';
import {
  computePackageDigest,
  makePackageIntegrity,
  verifyPackageIntegrity,
  INTEGRITY_ALGO,
  type CustomNodePackage,
} from './custom-node-integrity.js';

const SECRET = 'registry-secret-32-bytes-or-more-xxxxx';
const PKG: CustomNodePackage = {
  slug: 'acme-api',
  semver: '1.0.0',
  sourceExecutor: 'export const executor = async () => ({ ok: true });',
  sourceDefinition: 'export const definition = { defId: "custom_acme-api" };',
  sourceSchema: 'export const schema = {};',
  compiledExecutor: '(function(){ return { ok: true }; })()',
};

describe('round-trip', () => {
  it('make → verify valido', () => {
    const integrity = makePackageIntegrity(PKG, SECRET);
    expect(integrity.algo).toBe(INTEGRITY_ALGO);
    expect(integrity.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(integrity.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyPackageIntegrity(PKG, integrity, SECRET)).toEqual({ valid: true });
  });

  it('make senza secret → throw (no firma muta)', () => {
    expect(() => makePackageIntegrity(PKG, '')).toThrow(/registrySecret/);
  });
});

describe('🚨 TAMPER detection — ogni campo del pacchetto', () => {
  const fields: (keyof CustomNodePackage)[] = [
    'slug',
    'semver',
    'sourceExecutor',
    'sourceDefinition',
    'sourceSchema',
    'compiledExecutor',
  ];
  it.each(fields)('manomissione di "%s" → digest_mismatch', (field) => {
    const integrity = makePackageIntegrity(PKG, SECRET);
    // L'attaccante altera UN campo ma tiene il record di integrità originale.
    const tampered: CustomNodePackage = { ...PKG, [field]: PKG[field] + ' /* injected */' };
    const verdict = verifyPackageIntegrity(tampered, integrity, SECRET);
    expect(verdict).toEqual({ valid: false, reason: 'digest_mismatch' });
  });

  it('executor sostituito con payload malevolo → digest_mismatch (lo scenario reale)', () => {
    const integrity = makePackageIntegrity(PKG, SECRET);
    const evil: CustomNodePackage = {
      ...PKG,
      sourceExecutor: 'export const executor = async () => { /* exfiltrate */ };',
    };
    expect(verifyPackageIntegrity(evil, integrity, SECRET).reason).toBe('digest_mismatch');
  });

  it("🚨 compiledExecutor sostituito (l'artefatto ESEGUITO) → digest_mismatch", () => {
    // Il bypass storico: firmare solo i sorgenti lascia il bundle eseguito
    // manomettibile. Il bundle DEVE essere nel digest.
    const integrity = makePackageIntegrity(PKG, SECRET);
    const evil: CustomNodePackage = {
      ...PKG,
      compiledExecutor: '(function(){ /* exfiltrate */ })()',
    };
    expect(verifyPackageIntegrity(evil, integrity, SECRET).reason).toBe('digest_mismatch');
  });
});

describe('🚨 autenticità — firma', () => {
  it('secret sbagliato in verify → signature_mismatch', () => {
    const integrity = makePackageIntegrity(PKG, SECRET);
    expect(verifyPackageIntegrity(PKG, integrity, 'wrong-secret-wrong-secret-wrong!!').reason).toBe(
      'signature_mismatch',
    );
  });

  it('firma forgiata (digest coerente ma HMAC inventato) → signature_mismatch', () => {
    const integrity = makePackageIntegrity(PKG, SECRET);
    const forged = { ...integrity, signature: 'a'.repeat(64) };
    expect(verifyPackageIntegrity(PKG, forged, SECRET).reason).toBe('signature_mismatch');
  });

  it('attaccante altera sorgenti E ricalcola il digest MA non ha il secret → signature_mismatch', () => {
    // Scenario realistico: chi controlla la riga DB può rifare il digest, ma la
    // firma HMAC richiede il registrySecret che non ha → la verifica fallisce.
    const evil: CustomNodePackage = { ...PKG, sourceExecutor: 'malicious()' };
    const evilDigest = computePackageDigest(evil);
    // digest coerente coi sorgenti malevoli → supera il check digest...
    const forged = { algo: INTEGRITY_ALGO, digest: evilDigest, signature: 'deadbeef'.repeat(8) };
    const verdict = verifyPackageIntegrity(evil, forged, SECRET);
    // ...ma la firma no.
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe('signature_mismatch');
  });
});

describe('🚨 canonicalizzazione non ambigua (anti-collision/injection)', () => {
  it('spostare contenuto tra campi adiacenti → digest DIVERSO', () => {
    // Con un delimiter naïf (es. join con "|"), questi due collasserebbero.
    // Length-prefixed → digest distinti.
    const a: CustomNodePackage = { ...PKG, slug: 'ab', semver: 'c' };
    const b: CustomNodePackage = { ...PKG, slug: 'a', semver: 'bc' };
    expect(computePackageDigest(a)).not.toBe(computePackageDigest(b));
  });

  it('campi che contengono i caratteri separatori non confondono il digest', () => {
    const tricky: CustomNodePackage = { ...PKG, slug: 'x=99:\nsemver=0:' };
    const other: CustomNodePackage = { ...PKG, slug: 'x', semver: '99:\nsemver=0:' };
    expect(computePackageDigest(tricky)).not.toBe(computePackageDigest(other));
  });

  it('digest deterministico (stesso pkg → stesso digest)', () => {
    expect(computePackageDigest(PKG)).toBe(computePackageDigest({ ...PKG }));
  });
});

describe('record malformato / algo', () => {
  it('integrity null/undefined → malformed', () => {
    expect(verifyPackageIntegrity(PKG, null, SECRET).reason).toBe('malformed');
    expect(verifyPackageIntegrity(PKG, undefined, SECRET).reason).toBe('malformed');
  });
  it('digest/signature mancanti → malformed', () => {
    expect(
      verifyPackageIntegrity(PKG, { algo: INTEGRITY_ALGO, digest: 'x' } as never, SECRET).reason,
    ).toBe('malformed');
  });
  it('algo sconosciuto → algo_unsupported', () => {
    const integrity = makePackageIntegrity(PKG, SECRET);
    expect(verifyPackageIntegrity(PKG, { ...integrity, algo: 'md5' as never }, SECRET).reason).toBe(
      'algo_unsupported',
    );
  });
  it('digest di lunghezza diversa → digest_mismatch senza crash', () => {
    const integrity = makePackageIntegrity(PKG, SECRET);
    expect(verifyPackageIntegrity(PKG, { ...integrity, digest: 'abc' }, SECRET).reason).toBe(
      'digest_mismatch',
    );
  });
});
