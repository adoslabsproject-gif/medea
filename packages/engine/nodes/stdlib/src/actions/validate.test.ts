/**
 * Test bug-bounty — action_validate (CHECKSUM REALI). Era SENZA test (gap gate).
 * Il valore del nodo è proprio rifiutare i valori sintatticamente plausibili ma
 * matematicamente FALSI → testo per ogni tipo sia un VALIDO sia un check-digit ROTTO.
 * Vettori validi determinati empiricamente (vedi review 2026-06-20).
 */
import { describe, it, expect } from 'vitest';
import { validateNode } from './validate.js';

const v = validateNode.executor!;
const ctx = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} } as never;
const run = async (type: string, value: unknown) => {
  const r = await v({ type, value }, undefined, ctx);
  return { out: r.output as { valid: boolean; normalized: string | null }, branch: r.branch };
};

describe('action_validate — checksum reali', () => {
  it('email valida/invalida + normalizza lowercase', async () => {
    expect((await run('email', 'Mario@Example.IT')).out).toMatchObject({ valid: true, normalized: 'mario@example.it' });
    expect((await run('email', 'non-una-email')).out.valid).toBe(false);
  });

  it('url http/https valido; ftp/garbage invalido', async () => {
    expect((await run('url', 'https://x.it/a')).out.valid).toBe(true);
    expect((await run('url', 'ftp://x.it')).out.valid).toBe(false);
    expect((await run('url', 'pippo')).out.valid).toBe(false);
  });

  it('🚨 P.IVA: check-digit Luhn (12345670785 valida, 00000000001 NO, 11 lettere NO)', async () => {
    expect((await run('piva', '12345670785')).out.valid).toBe(true);
    expect((await run('piva', '00000000001')).out.valid).toBe(false);
    expect((await run('piva', '1234567078')).out.valid).toBe(false); // 10 cifre
  });

  it('🚨 Codice Fiscale: carattere di controllo ufficiale (Q corretto, A errato)', async () => {
    expect((await run('codice_fiscale', 'RSSMRA85M01H501Q')).out.valid).toBe(true);
    expect((await run('codice_fiscale', 'RSSMRA85M01H501A')).out.valid).toBe(false); // ctrl rotto
    expect((await run('codice_fiscale', 'rssmra85m01h501q')).out).toMatchObject({ valid: true, normalized: 'RSSMRA85M01H501Q' });
    expect((await run('codice_fiscale', 'TROPPOCORTO')).out.valid).toBe(false);
  });

  it('🚨 IBAN: mod-97 (DE/IT validi, una cifra sbagliata NO)', async () => {
    expect((await run('iban', 'DE89 3704 0044 0532 0130 00')).out.valid).toBe(true); // spazi tollerati
    expect((await run('iban', 'IT60X0542811101000000123456')).out.valid).toBe(true);
    expect((await run('iban', 'DE89370400440532013001')).out.valid).toBe(false); // ultima cifra rotta
  });

  it('phone_it → E.164 (mobile/fisso/00/+), garbage invalido', async () => {
    expect((await run('phone_it', '340 123 4567')).out).toMatchObject({ valid: true, normalized: '+393401234567' });
    expect((await run('phone_it', '06 1234567')).out.normalized).toBe('+39061234567');
    expect((await run('phone_it', '0039 340 1234567')).out.normalized).toBe('+393401234567');
    expect((await run('phone_it', 'abc')).out.valid).toBe(false);
  });

  it('json parsabile/non', async () => {
    expect((await run('json', '{"a":1}')).out.valid).toBe(true);
    expect((await run('json', '{bad')).out.valid).toBe(false);
  });

  it('🚨 branch valid/invalid esposto per il routing', async () => {
    expect((await run('email', 'a@b.it')).branch).toBe('valid');
    expect((await run('email', 'x')).branch).toBe('invalid');
  });

  it('🚨 tipo sconosciuto → throw', async () => {
    await expect(v({ type: 'nope', value: 'x' }, undefined, ctx)).rejects.toThrow(/sconosciuto/);
  });
});
