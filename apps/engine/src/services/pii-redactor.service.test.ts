/**
 * Test 2026-grade — PIIRedactor (Italian-aware regex + Luhn).
 *
 * 🚨 GDPR: PII NON deve mai finire in training set / log persistenti.
 * 🚨 Conservative: false positive (over-redact) OK, false negative (leak) NO.
 * 🚨 Italian-specific: email + IBAN IT + CF + P.IVA + phone +39 + CC Luhn.
 */
import { describe, it, expect } from 'vitest';
import { PIIRedactor, piiRedactor } from './pii-redactor.service.js';

describe('🚨 redactText — single string', () => {
  const r = new PIIRedactor();

  it('🚨 email RFC 5321 → <EMAIL>', () => {
    const out = r.redactText('Contact me at mario.rossi@example.com or admin@zeli.it');
    expect(out.redacted).toBe('Contact me at <EMAIL> or <EMAIL>');
    expect(out.classes).toContain('email');
    expect(out.counts.email).toBe(2);
  });

  it('🚨 codice fiscale IT (16 char strict) → <CF>', () => {
    const out = r.redactText('CF: RSSMRA80A01H501Z trovato');
    expect(out.redacted).toContain('<CF>');
    expect(out.counts.codice_fiscale).toBe(1);
  });

  it('🚨 CF wrong length 15 char → NON match (no false positive)', () => {
    const out = r.redactText('RSSMRA80A01H501'); // 15 char
    expect(out.redacted).toBe('RSSMRA80A01H501');
    expect(out.counts.codice_fiscale).toBe(0);
  });

  it('🚨 partita IVA con prefisso IT → <PIVA>', () => {
    const out = r.redactText('P.IVA: IT12345678901');
    expect(out.redacted).toContain('<PIVA>');
    expect(out.counts.partita_iva).toBe(1);
  });

  it('🚨 partita IVA 11 cifre nude → <PIVA>', () => {
    const out = r.redactText('Vat 12345678901 enabled');
    expect(out.counts.partita_iva).toBeGreaterThanOrEqual(1);
  });

  it('🚨 IBAN italiano 27 char → <IBAN>', () => {
    const out = r.redactText('IBAN: IT60X0542811101000000123456');
    expect(out.redacted).toContain('<IBAN>');
    expect(out.counts.iban).toBe(1);
  });

  it('🚨 IBAN processato PRIMA di P.IVA (no overlap)', () => {
    const out = r.redactText('IT60X0542811101000000123456');
    // 27-char IBAN matched as iban, NON come piva 11 digits parziale
    expect(out.counts.iban).toBe(1);
    expect(out.counts.partita_iva).toBe(0);
  });

  it('🚨 credit card Luhn valid (Visa test 4111 1111 1111 1111) → <CC>', () => {
    const out = r.redactText('Card 4111 1111 1111 1111 used');
    expect(out.counts.credit_card).toBe(1);
    expect(out.redacted).toContain('<CC>');
  });

  it('🚨 credit card Luhn NON valida → NON ridatta (postValidate)', () => {
    const out = r.redactText('Number 1234 5678 9012 3456 random');
    // Quel CC NON è Luhn valido → resta inalterato
    expect(out.counts.credit_card).toBe(0);
    expect(out.redacted).toContain('1234');
  });

  it('🚨 phone IT mobile con +39 → <PHONE>', () => {
    const out = r.redactText('Chiamami al +39 333 1234567');
    expect(out.counts.phone).toBeGreaterThanOrEqual(1);
    expect(out.redacted).toContain('<PHONE>');
  });

  it('🚨 phone IT fisso senza prefisso → <PHONE>', () => {
    const out = r.redactText('Telefono: 02 1234567');
    expect(out.counts.phone).toBeGreaterThanOrEqual(1);
  });

  it('🚨 stringa senza PII → invariata, classes=[], counts=0', () => {
    const out = r.redactText('Hello world, nothing personal');
    expect(out.redacted).toBe('Hello world, nothing personal');
    expect(out.classes).toEqual([]);
    expect(Object.values(out.counts).every((c) => c === 0)).toBe(true);
  });

  it('🚨 empty string → result vuoto', () => {
    const out = r.redactText('');
    expect(out.redacted).toBe('');
    expect(out.classes).toEqual([]);
  });

  it('🚨 input non-string → result vuoto (defensive)', () => {
    // @ts-expect-error testing runtime guard
    const out = r.redactText(undefined);
    expect(out.redacted).toBe('');
  });

  it('🚨 multi-class string → tutti classes contati', () => {
    const out = r.redactText(
      'Email mario@x.it CF RSSMRA80A01H501Z IBAN IT60X0542811101000000123456',
    );
    expect(out.classes).toEqual(expect.arrayContaining(['email', 'codice_fiscale', 'iban']));
    expect(out.counts.email).toBe(1);
    expect(out.counts.codice_fiscale).toBe(1);
    expect(out.counts.iban).toBe(1);
  });

  it('🚨 regex state reset tra chiamate (global flag /g)', () => {
    const out1 = r.redactText('a@b.com');
    const out2 = r.redactText('c@d.com');
    expect(out1.counts.email).toBe(1);
    expect(out2.counts.email).toBe(1); // se non resettato lastIndex sarebbe 0
  });
});

describe('🚨 redactJson — deep walk', () => {
  const r = new PIIRedactor();

  it('🚨 oggetto piatto: stringhe redatte, numeri inalterati', () => {
    const out = r.redactJson({
      email: 'a@b.it',
      age: 25,
      enabled: true,
      meta: null,
    });
    expect((out.redacted as any).email).toBe('<EMAIL>');
    expect((out.redacted as any).age).toBe(25);
    expect((out.redacted as any).enabled).toBe(true);
    expect((out.redacted as any).meta).toBeNull();
    expect(out.classes).toContain('email');
  });

  it('🚨 nested deep: walk ricorsivo', () => {
    const out = r.redactJson({
      user: {
        contact: { email: 'nested@x.it', phone: '+39 333 1234567' },
        tags: ['ok', 'piva:IT12345678901'],
      },
    });
    const j = JSON.stringify(out.redacted);
    expect(j).toContain('<EMAIL>');
    expect(j).toContain('<PHONE>');
    expect(j).toContain('<PIVA>');
    expect(j).not.toContain('nested@x.it');
    expect(j).not.toContain('+39 333');
  });

  it('🚨 array di stringhe', () => {
    const out = r.redactJson(['a@b.com', 'plain', 'IT60X0542811101000000123456']);
    const arr = out.redacted as string[];
    expect(arr[0]).toBe('<EMAIL>');
    expect(arr[1]).toBe('plain');
    expect(arr[2]).toBe('<IBAN>');
    expect(out.classes).toEqual(expect.arrayContaining(['email', 'iban']));
  });

  it('🚨 input primitivo: passa attraverso', () => {
    expect(r.redactJson(42).redacted).toBe(42);
    expect(r.redactJson(null).redacted).toBeNull();
    expect(r.redactJson(true).redacted).toBe(true);
  });

  it('🚨 classes set unique (no duplicati per occorrenze multiple)', () => {
    const out = r.redactJson({
      a: 'x@y.com',
      b: 'p@q.com',
      c: { d: 'r@s.com' },
    });
    expect(out.classes).toEqual(['email']);
  });
});

describe('🚨 piiRedactor singleton', () => {
  it('🚨 esiste istanza esportata stateless', () => {
    expect(piiRedactor).toBeInstanceOf(PIIRedactor);
    const a = piiRedactor.redactText('a@b.com');
    const b = piiRedactor.redactText('c@d.com');
    expect(a.counts.email).toBe(1);
    expect(b.counts.email).toBe(1);
  });
});

describe('🚨 regression: PII non leak per training set', () => {
  it('🚨 prompt AI con PII multipla → 0 PII in output', () => {
    const r = new PIIRedactor();
    const prompt = `
      Compila fattura per:
      - Cliente: Mario Rossi
      - Email: mario.rossi@cliente.it
      - P.IVA: IT12345678901
      - CF: RSSMRA80A01H501Z
      - IBAN: IT60X0542811101000000123456
      - Tel: +39 333 1234567
      - CC: 4111 1111 1111 1111
    `;
    const out = r.redactText(prompt);
    // Tutte le classi rilevate
    expect(out.classes).toEqual(
      expect.arrayContaining([
        'email',
        'partita_iva',
        'codice_fiscale',
        'iban',
        'phone',
        'credit_card',
      ]),
    );
    // 🚨 nessuna PII originale resta
    expect(out.redacted).not.toContain('mario.rossi@cliente.it');
    expect(out.redacted).not.toContain('IT12345678901');
    expect(out.redacted).not.toContain('RSSMRA80A01H501Z');
    expect(out.redacted).not.toContain('IT60X0542811101000000123456');
    expect(out.redacted).not.toContain('1234567');
    expect(out.redacted).not.toContain('4111');
  });
});
