/**
 * Tests for PEC receipt-parser.
 *
 * Coverage (no smoke):
 *   • all 4 branches: received_message | acceptance | delivery | rejection
 *   • each of the 8 official X-Ricevuta values (accettazione, presa-in-carico,
 *     avvenuta-consegna, non-accettazione, errore-consegna,
 *     preavviso-errore-consegna, rilevazione-virus, + absent = normal msg)
 *   • header lookup is case-insensitive
 *   • unknown X-Ricevuta value falls back to received_message + raw category
 *   • isPec=true when any PEC header is present; false on plain mail
 *   • input-shape guards (null/array rejected)
 */

import { describe, it, expect } from 'vitest';
import { classifyPecMessage, PEC_RECEIPT_VALUES } from './receipt-parser.js';

const MID = '<original.message-id@studiocomm.example.it>';

describe('classifyPecMessage — message types', () => {
  it('normal message (no X-Ricevuta) → pec_received_message', () => {
    const c = classifyPecMessage({
      'X-Trasporto': 'posta-certificata',
      Subject: 'Comunicazione',
    });
    expect(c.type).toBe('pec_received_message');
    expect(c.receiptCategory).toBeNull();
    expect(c.isPec).toBe(true);
  });

  it('X-Ricevuta=accettazione → pec_acceptance_receipt', () => {
    const c = classifyPecMessage({
      'X-Ricevuta': 'accettazione',
      'X-Riferimento-Message-ID': MID,
      'X-TipoRicevuta': 'completa',
      'X-Trasporto': 'posta-certificata',
    });
    expect(c.type).toBe('pec_acceptance_receipt');
    expect(c.receiptCategory).toBe('accettazione');
    expect(c.refMessageId).toBe(MID);
    expect(c.receiptStyle).toBe('completa');
  });

  it('X-Ricevuta=presa-in-carico → pec_acceptance_receipt (intermediate hop)', () => {
    const c = classifyPecMessage({
      'X-Ricevuta': 'presa-in-carico',
      'X-Riferimento-Message-ID': MID,
    });
    expect(c.type).toBe('pec_acceptance_receipt');
  });

  it('X-Ricevuta=avvenuta-consegna → pec_delivery_receipt', () => {
    const c = classifyPecMessage({
      'X-Ricevuta': 'avvenuta-consegna',
      'X-Riferimento-Message-ID': MID,
      'X-TipoRicevuta': 'completa',
    });
    expect(c.type).toBe('pec_delivery_receipt');
  });

  it('X-Ricevuta=non-accettazione → pec_rejection', () => {
    const c = classifyPecMessage({ 'X-Ricevuta': 'non-accettazione', 'X-Riferimento-Message-ID': MID });
    expect(c.type).toBe('pec_rejection');
  });

  it('X-Ricevuta=errore-consegna → pec_rejection', () => {
    expect(classifyPecMessage({ 'X-Ricevuta': 'errore-consegna' }).type).toBe('pec_rejection');
  });

  it('X-Ricevuta=preavviso-errore-consegna → pec_rejection', () => {
    expect(classifyPecMessage({ 'X-Ricevuta': 'preavviso-errore-consegna' }).type).toBe('pec_rejection');
  });

  it('X-Ricevuta=rilevazione-virus → pec_rejection', () => {
    expect(classifyPecMessage({ 'X-Ricevuta': 'rilevazione-virus' }).type).toBe('pec_rejection');
  });

  it('unknown X-Ricevuta value → pec_received_message but preserves raw category', () => {
    const c = classifyPecMessage({ 'X-Ricevuta': 'foo-bar-future-variant' });
    expect(c.type).toBe('pec_received_message');
    expect(c.receiptCategory).toBe('foo-bar-future-variant');
  });
});

describe('classifyPecMessage — header lookup robustness', () => {
  it('matches lowercased header names', () => {
    const c = classifyPecMessage({ 'x-ricevuta': 'avvenuta-consegna' });
    expect(c.type).toBe('pec_delivery_receipt');
  });

  it('matches mixed-case header names', () => {
    const c = classifyPecMessage({ 'X-RICEVUTA': 'accettazione' });
    expect(c.type).toBe('pec_acceptance_receipt');
  });

  it('accepts header values as arrays (some IMAP libs do this)', () => {
    const c = classifyPecMessage({ 'X-Ricevuta': ['avvenuta-consegna'] });
    expect(c.type).toBe('pec_delivery_receipt');
  });

  it('trims and lowercases X-Ricevuta', () => {
    const c = classifyPecMessage({ 'X-Ricevuta': '  AVVENUTA-Consegna  ' });
    expect(c.type).toBe('pec_delivery_receipt');
    expect(c.receiptCategory).toBe('avvenuta-consegna');
  });
});

describe('classifyPecMessage — isPec flag', () => {
  it('false for plain non-PEC mail (no PEC headers)', () => {
    const c = classifyPecMessage({ Subject: 'newsletter', From: 'x@y.test' });
    expect(c.isPec).toBe(false);
    expect(c.type).toBe('pec_received_message');
  });

  it('true when X-Trasporto is present alone', () => {
    expect(classifyPecMessage({ 'X-Trasporto': 'posta-certificata' }).isPec).toBe(true);
  });

  it('true when X-Ricevuta is present alone', () => {
    expect(classifyPecMessage({ 'X-Ricevuta': 'accettazione' }).isPec).toBe(true);
  });
});

describe('classifyPecMessage — input guards', () => {
  it('throws on null input', () => {
    expect(() => classifyPecMessage(null as unknown as Record<string, string>)).toThrow(/headers object/);
  });
  it('throws on array input', () => {
    expect(() => classifyPecMessage([] as unknown as Record<string, string>)).toThrow(/headers object/);
  });
});

describe('PEC_RECEIPT_VALUES — taxonomy is frozen', () => {
  it('is immutable at the top level', () => {
    expect(Object.isFrozen(PEC_RECEIPT_VALUES)).toBe(true);
  });
});
