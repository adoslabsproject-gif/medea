/**
 * PIIRedactor — golden test suite focused on Italian PII patterns.
 *
 * Strategy: drive the redactor with a curated battery of realistic Italian
 * documents (CF, P.IVA, IBAN, phones, emails, credit cards) plus negative
 * cases (random uppercase strings, IBAN-like substrings of UUIDs, partial
 * matches) to ensure we OVER-redact PII without false positives that mangle
 * normal text.
 *
 * Coverage targets ≥ 90% of branches in pii-redactor.service.ts.
 */

import { describe, it, expect } from 'vitest';
import { PIIRedactor, piiRedactor } from './pii-redactor.service.js';

describe('PIIRedactor', () => {
  /* ── Email ────────────────────────────────────────────────────────── */

  describe('email', () => {
    it('redacts a simple email', () => {
      const r = piiRedactor.redactText('Scrivi a mario.rossi@example.com per info');
      expect(r.redacted).toBe('Scrivi a <EMAIL> per info');
      expect(r.classes).toContain('email');
      expect(r.counts.email).toBe(1);
    });

    it('redacts multiple emails in one string', () => {
      const r = piiRedactor.redactText('da: a@b.it, cc: c@d.com, bcc: e+tag@f.example.org');
      expect((r.redacted.match(/<EMAIL>/g) ?? []).length).toBe(3);
      expect(r.counts.email).toBe(3);
    });

    it('handles emails with dots, plus, and digits', () => {
      const r = piiRedactor.redactText('user.name+1234@sub.domain.co.uk');
      expect(r.redacted).toBe('<EMAIL>');
    });

    it('does NOT redact a plain word with @ but no domain (e.g. handle)', () => {
      const r = piiRedactor.redactText('Mention @bobsmith on Twitter');
      expect(r.redacted).toBe('Mention @bobsmith on Twitter');
      expect(r.classes).not.toContain('email');
    });
  });

  /* ── Codice Fiscale (italiano) ───────────────────────────────────── */

  describe('codice_fiscale', () => {
    it('redacts a valid-format CF (16 chars AAAAAA00A00A000A)', () => {
      // RSSMRA80A01H501Z = Mario Rossi born Jan 1980 in Rome
      const r = piiRedactor.redactText('CF: RSSMRA80A01H501Z grazie');
      expect(r.redacted).toBe('CF: <CF> grazie');
      expect(r.classes).toContain('codice_fiscale');
    });

    it('does NOT match random 16-char uppercase strings without the digit/letter pattern', () => {
      const r = piiRedactor.redactText('Key ABCDEFGHIJKLMNOP value');
      expect(r.redacted).toBe('Key ABCDEFGHIJKLMNOP value');
      expect(r.classes).not.toContain('codice_fiscale');
    });

    it('redacts CF in a sentence with multiple PII', () => {
      const r = piiRedactor.redactText(
        'Cliente Mario Rossi (CF: RSSMRA80A01H501Z) email: mario@test.it',
      );
      expect(r.redacted).toContain('<CF>');
      expect(r.redacted).toContain('<EMAIL>');
      expect(r.classes).toContain('codice_fiscale');
      expect(r.classes).toContain('email');
    });
  });

  /* ── Partita IVA (italiana) ──────────────────────────────────────── */

  describe('partita_iva', () => {
    it('redacts an 11-digit P.IVA with IT prefix', () => {
      const r = piiRedactor.redactText('P.IVA IT12345678901 di Acme Srl');
      expect(r.redacted).toContain('<PIVA>');
      expect(r.classes).toContain('partita_iva');
    });

    it('redacts a bare 11-digit P.IVA', () => {
      const r = piiRedactor.redactText("Codice 12345678901 dell'azienda");
      expect(r.redacted).toContain('<PIVA>');
    });

    it('does NOT match 10- or 12-digit numbers (not P.IVA)', () => {
      const r10 = piiRedactor.redactText('Ref 1234567890 trade');
      expect(r10.classes).not.toContain('partita_iva');
      const r12 = piiRedactor.redactText('Order 123456789012 placed');
      expect(r12.classes).not.toContain('partita_iva');
    });
  });

  /* ── IBAN italiano ───────────────────────────────────────────────── */

  describe('iban', () => {
    it('redacts a valid-format IT IBAN (27 chars)', () => {
      const r = piiRedactor.redactText('Bonifico su IT60X0542811101000000123456 grazie');
      expect(r.redacted).toContain('<IBAN>');
      expect(r.classes).toContain('iban');
    });

    it('does NOT match a P.IVA inside the IBAN as a separate match', () => {
      // The 11-digit substring inside an IBAN should NOT trigger partita_iva
      // because the IBAN regex runs first and replaces the whole 27 chars.
      const r = piiRedactor.redactText('IBAN IT60X0542811101000000123456');
      expect(r.classes).toContain('iban');
      expect(r.classes).not.toContain('partita_iva');
    });
  });

  /* ── Telefono italiano ───────────────────────────────────────────── */

  describe('phone', () => {
    it('redacts an Italian mobile with +39 prefix', () => {
      const r = piiRedactor.redactText('Chiamami al +39 333 1234567 oggi');
      expect(r.redacted).toContain('<PHONE>');
      expect(r.classes).toContain('phone');
    });

    it('redacts an Italian landline 0xx prefix', () => {
      const r = piiRedactor.redactText('Ufficio 02 87654321 per appuntamenti');
      expect(r.classes).toContain('phone');
    });
  });

  /* ── Credit card (Luhn-checked) ──────────────────────────────────── */

  describe('credit_card', () => {
    it('redacts a Luhn-valid 16-digit card (test card 4242 4242 4242 4242)', () => {
      const r = piiRedactor.redactText('Card 4242 4242 4242 4242 expires 12/26');
      expect(r.redacted).toContain('<CC>');
      expect(r.classes).toContain('credit_card');
    });

    it('does NOT redact a Luhn-INVALID 16-digit string', () => {
      // 1234567890123456 fails Luhn
      const r = piiRedactor.redactText('Ref 1234567890123456 random');
      expect(r.classes).not.toContain('credit_card');
    });

    it('does NOT redact 12-digit numbers (too short for CC)', () => {
      const r = piiRedactor.redactText('Tracking 123456789012 sent');
      expect(r.classes).not.toContain('credit_card');
    });
  });

  /* ── Multi-class scenarios ───────────────────────────────────────── */

  describe('multi-class', () => {
    it('redacts an order receipt with email + phone + P.IVA + CC + IBAN', () => {
      const input = [
        'Cliente: mario.rossi@example.com',
        'Tel: +39 333 1234567',
        'P.IVA: IT12345678901',
        'Carta: 4242 4242 4242 4242',
        'IBAN: IT60X0542811101000000654321',
      ].join('\n');
      const r = piiRedactor.redactText(input);
      expect(r.classes).toEqual(
        expect.arrayContaining(['email', 'phone', 'partita_iva', 'credit_card', 'iban']),
      );
      expect(r.redacted).not.toContain('mario.rossi@example.com');
      expect(r.redacted).not.toContain('4242');
    });
  });

  /* ── Negative cases (no over-redaction) ──────────────────────────── */

  describe('negative cases', () => {
    it('leaves a normal Italian sentence untouched', () => {
      const text = 'Il workflow è partito alle 09:30 e ha processato 1500 record correttamente.';
      const r = piiRedactor.redactText(text);
      expect(r.redacted).toBe(text);
      expect(r.classes.length).toBe(0);
    });

    it('handles empty input gracefully', () => {
      const r = piiRedactor.redactText('');
      expect(r.redacted).toBe('');
      expect(r.classes.length).toBe(0);
    });

    it('handles non-string input gracefully (defensive)', () => {
      // @ts-expect-error — testing defensive path
      const r = piiRedactor.redactText(null);
      expect(r.redacted).toBe('');
      expect(r.classes.length).toBe(0);
    });
  });

  /* ── JSON redaction ──────────────────────────────────────────────── */

  describe('redactJson', () => {
    it('redacts strings nested inside arrays and objects', () => {
      const input = {
        order: {
          customer: 'mario@example.com',
          items: [
            { name: 'Item A', notes: 'contatto: +39 333 1234567' },
            { name: 'Item B', notes: 'P.IVA IT12345678901' },
          ],
        },
      };
      const r = piiRedactor.redactJson(input);
      const out = r.redacted as typeof input;
      expect(out.order.customer).toBe('<EMAIL>');
      expect(out.order.items[0]!.notes).toContain('<PHONE>');
      expect(out.order.items[1]!.notes).toContain('<PIVA>');
      expect(r.classes).toEqual(expect.arrayContaining(['email', 'phone', 'partita_iva']));
    });

    it('preserves numbers, booleans, and null', () => {
      const input = { count: 42, ok: true, missing: null, label: 'mario@x.it' };
      const r = piiRedactor.redactJson(input) as { redacted: typeof input };
      expect(r.redacted.count).toBe(42);
      expect(r.redacted.ok).toBe(true);
      expect(r.redacted.missing).toBeNull();
      expect(r.redacted.label).toBe('<EMAIL>');
    });
  });

  /* ── Multiple-call statelessness ─────────────────────────────────── */

  describe('statelessness', () => {
    it('produces identical output across multiple calls (regex state reset)', () => {
      const r1 = new PIIRedactor();
      const text = 'Email1: a@b.it Email2: c@d.it';
      const o1 = r1.redactText(text);
      const o2 = r1.redactText(text);
      const o3 = r1.redactText(text);
      expect(o1.redacted).toBe(o2.redacted);
      expect(o2.redacted).toBe(o3.redacted);
      expect(o1.counts.email).toBe(2);
      expect(o2.counts.email).toBe(2);
    });
  });
});
