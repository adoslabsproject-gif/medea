/**
 * Test REALI dei crypto utility nodes — eseguono gli executor veri (node:crypto),
 * niente stub. Verificano round-trip, valori noti e i guard di errore.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { cryptoNode, uuidNode, jwtNode } from './crypto-utils.js';

const crypto = cryptoNode.executor!;
const uuid = uuidNode.executor!;
const jwt = jwtNode.executor!;

describe('action_crypto', () => {
  it('hash sha256 = valore noto', async () => {
    const r = await crypto({ operation: 'hash', algorithm: 'sha256', value: 'hello' }, undefined);
    expect((r.output as { result: string }).result).toBe(
      createHash('sha256').update('hello').digest('hex'),
    );
  });
  it('hmac deterministico con stessa chiave', async () => {
    const a = await crypto(
      { operation: 'hmac', algorithm: 'sha256', key: 'k', value: 'msg' },
      undefined,
    );
    const b = await crypto(
      { operation: 'hmac', algorithm: 'sha256', key: 'k', value: 'msg' },
      undefined,
    );
    expect((a.output as { result: string }).result).toBe((b.output as { result: string }).result);
  });
  it('hmac richiede la chiave', async () => {
    await expect(crypto({ operation: 'hmac', value: 'x' }, undefined)).rejects.toThrow(/chiave/);
  });
  describe('hmac-verify — verifica firma webhook timing-safe', () => {
    it('firma corretta → valid:true (round-trip con hmac)', async () => {
      const sig = (
        await crypto(
          { operation: 'hmac', algorithm: 'sha256', key: 'whsec', value: 'body' },
          undefined,
        )
      ).output as { result: string };
      const r = await crypto(
        {
          operation: 'hmac-verify',
          algorithm: 'sha256',
          key: 'whsec',
          value: 'body',
          expected: sig.result,
        },
        undefined,
      );
      expect((r.output as { valid: boolean }).valid).toBe(true);
    });
    it('firma errata → valid:false (no throw)', async () => {
      const r = await crypto(
        {
          operation: 'hmac-verify',
          algorithm: 'sha256',
          key: 'whsec',
          value: 'body',
          expected: 'deadbeef',
        },
        undefined,
      );
      expect((r.output as { valid: boolean }).valid).toBe(false);
    });
    it('firma di lunghezza diversa → valid:false SENZA throw (timingSafeEqual non lancia)', async () => {
      // MUTATION: senza il guard `length ===`, timingSafeEqual lancerebbe RangeError.
      const r = await crypto(
        {
          operation: 'hmac-verify',
          algorithm: 'sha256',
          key: 'whsec',
          value: 'body',
          expected: 'ab',
        },
        undefined,
      );
      expect((r.output as { valid: boolean }).valid).toBe(false);
    });
    it('chiave diversa → valid:false (firma non combacia)', async () => {
      const sig = (
        await crypto(
          { operation: 'hmac', algorithm: 'sha256', key: 'right', value: 'body' },
          undefined,
        )
      ).output as { result: string };
      const r = await crypto(
        {
          operation: 'hmac-verify',
          algorithm: 'sha256',
          key: 'wrong',
          value: 'body',
          expected: sig.result,
        },
        undefined,
      );
      expect((r.output as { valid: boolean }).valid).toBe(false);
    });
    it('base64 encoding round-trip', async () => {
      const sig = (
        await crypto(
          { operation: 'hmac', algorithm: 'sha256', key: 'k', value: 'm', encoding: 'base64' },
          undefined,
        )
      ).output as { result: string };
      const r = await crypto(
        {
          operation: 'hmac-verify',
          algorithm: 'sha256',
          key: 'k',
          value: 'm',
          encoding: 'base64',
          expected: sig.result,
        },
        undefined,
      );
      expect((r.output as { valid: boolean }).valid).toBe(true);
    });
    it('richiede la chiave', async () => {
      await expect(
        crypto({ operation: 'hmac-verify', value: 'x', expected: 'y' }, undefined),
      ).rejects.toThrow(/chiave/);
    });
  });
  it('encode/decode base64 round-trip', async () => {
    const enc = await crypto(
      { operation: 'encode', targetFormat: 'base64', value: 'ciào' },
      undefined,
    );
    const dec = await crypto(
      {
        operation: 'decode',
        sourceFormat: 'base64',
        value: (enc.output as { result: string }).result,
      },
      undefined,
    );
    expect((dec.output as { result: string }).result).toBe('ciào');
  });
  it('random produce la lunghezza richiesta (hex = 2×byte)', async () => {
    const r = await crypto({ operation: 'random', bytes: '16', encoding: 'hex' }, undefined);
    expect((r.output as { result: string }).result).toHaveLength(32);
  });
  it("usa l'input del nodo se value è vuoto", async () => {
    const r = await crypto({ operation: 'hash' }, 'fromInput');
    expect((r.output as { result: string }).result).toBe(
      createHash('sha256').update('fromInput').digest('hex'),
    );
  });
});

describe('action_uuid', () => {
  it('v4 ha il formato UUID', async () => {
    const r = await uuid({ version: 'v4' });
    expect((r.output as { id: string }).id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
  it('v7 è ordinabile (due generati: il 2° >= 1°)', async () => {
    const a = (await uuid({ version: 'v7' })).output as { id: string };
    await new Promise((res) => setTimeout(res, 2));
    const b = (await uuid({ version: 'v7' })).output as { id: string };
    expect(b.id >= a.id).toBe(true);
  });
  it('count batch → array di N id unici', async () => {
    const r = (await uuid({ version: 'v4', count: '50' })).output as { ids: string[] };
    expect(r.ids).toHaveLength(50);
    expect(new Set(r.ids).size).toBe(50);
  });
  it('uppercase', async () => {
    const r = (await uuid({ version: 'short', uppercase: 'true' })).output as { id: string };
    expect(r.id).toBe(r.id.toUpperCase());
  });
});

describe('action_jwt', () => {
  it('sign → verify round-trip valido', async () => {
    const signed = (
      await jwt(
        {
          operation: 'sign',
          algorithm: 'HS256',
          secret: 's3cr3t',
          payload: '{"sub":"u1"}',
          expiresIn: '3600',
        },
        undefined,
      )
    ).output as { token: string };
    const v = (
      await jwt(
        { operation: 'verify', algorithm: 'HS256', secret: 's3cr3t', token: signed.token },
        undefined,
      )
    ).output as { verified: boolean; payload: { sub: string } };
    expect(v.verified).toBe(true);
    expect(v.payload.sub).toBe('u1');
  });
  it('verify con secret sbagliato → non verificato (timing-safe)', async () => {
    const signed = (await jwt({ operation: 'sign', secret: 'right', payload: '{}' }, undefined))
      .output as { token: string };
    const v = (await jwt({ operation: 'verify', secret: 'wrong', token: signed.token }, undefined))
      .output as { verified: boolean; signatureValid: boolean };
    expect(v.verified).toBe(false);
    expect(v.signatureValid).toBe(false);
  });
  it('token scaduto → expired=true (exp nel passato)', async () => {
    const past = Math.floor(Date.now() / 1000) - 100;
    const signed = (
      await jwt(
        { operation: 'sign', secret: 's', payload: JSON.stringify({ exp: past }) },
        undefined,
      )
    ).output as { token: string };
    const v = (await jwt({ operation: 'verify', secret: 's', token: signed.token }, undefined))
      .output as { verified: boolean; expired: boolean };
    expect(v.expired).toBe(true);
    expect(v.verified).toBe(false); // firma valida ma scaduto → comunque non verificato
  });
  it('decode legge il payload senza verificare (verified:false)', async () => {
    const signed = (
      await jwt({ operation: 'sign', secret: 's', payload: '{"role":"admin"}' }, undefined)
    ).output as { token: string };
    const d = (await jwt({ operation: 'decode', token: signed.token }, undefined)).output as {
      payload: { role: string };
      verified: boolean;
    };
    expect(d.payload.role).toBe('admin');
    expect(d.verified).toBe(false);
  });

  // ── Robustezza contro token attacker-controlled (audit sicurezza 2026-06-07) ──
  const b64url = (s: string): string =>
    Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  it('verify su token con payload NON-JSON → verified:false, NON lancia (anti-DoS)', async () => {
    const malformed = `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url('NON_E_JSON')}.${b64url('firmafarlocca')}`;
    const v = (await jwt({ operation: 'verify', secret: 's', token: malformed }, undefined))
      .output as { verified: boolean; signatureValid: boolean; payload: unknown };
    expect(v.verified).toBe(false);
    expect(v.signatureValid).toBe(false);
    expect(v.payload).toBeNull();
  });
  it('decode su token con parti non-JSON → errore PULITO (no JSON.parse criptico)', async () => {
    const bad = `${b64url('NON_JSON')}.${b64url('NEANCHE')}.sig`;
    await expect(jwt({ operation: 'decode', token: bad }, undefined)).rejects.toThrow(
      /non decodificabile/,
    );
  });
  it('sign con payload JSON invalido → errore pulito', async () => {
    await expect(
      jwt({ operation: 'sign', secret: 's', payload: '{payload rotto' }, undefined),
    ).rejects.toThrow(/non.*JSON valido/);
  });
  it('verify su garbage totale (non 3 parti) → throw controllato, no crash', async () => {
    await expect(
      jwt({ operation: 'verify', secret: 's', token: 'spazzatura' }, undefined),
    ).rejects.toThrow(/malformato/);
  });
});
