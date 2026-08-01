/**
 * Test pec-message — bug-bounty + anti-regressione.
 *
 * classifyPecType: esaustivo sui valori X-Ricevuta normati (DM 2/11/2005) + edge
 * (case, spazi, sconosciuto→reject, assente→received, X-Trasporto). buildPecMessage:
 * integrazione con simpleParser REALE su EML costruiti (to/body/attachments/pecType).
 */
import { describe, it, expect } from 'vitest';
import { simpleParser } from 'mailparser';
import { classifyPecType, buildPecMessage, type PecType } from './pec-message.js';

describe('classifyPecType — header PEC normati', () => {
  const cases: [string, PecType][] = [
    ['accettazione', 'acceptance'],
    ['avvenuta-consegna', 'delivery'],
    ['non-accettazione', 'reject'],
    ['errore-consegna', 'reject'],
    ['mancata-consegna', 'reject'],
    ['rilevazione-virus', 'reject'],
    ['preavviso-errore-consegna', 'reject'],
  ];
  it.each(cases)('X-Ricevuta=%s → %s', (ricevuta, expected) => {
    expect(classifyPecType({ 'X-Ricevuta': ricevuta })).toBe(expected);
  });

  it('🚨 case-insensitive su chiave e valore + trim', () => {
    expect(classifyPecType({ 'x-ricevuta': '  ACCETTAZIONE  ' })).toBe('acceptance');
    expect(classifyPecType({ 'X-RICEVUTA': 'Avvenuta-Consegna' })).toBe('delivery');
  });

  it('🚨 X-Ricevuta SCONOSCIUTO → reject (mai trattato come posta normale)', () => {
    expect(classifyPecType({ 'X-Ricevuta': 'qualcosa-di-nuovo' })).toBe('reject');
  });

  it('🚨 nessun X-Ricevuta + busta di trasporto (X-Trasporto) → received', () => {
    expect(classifyPecType({ 'X-Trasporto': 'posta-certificata' })).toBe('received');
  });

  it('🚨 nessun header PEC → received (default conservativo, non una ricevuta)', () => {
    expect(classifyPecType({})).toBe('received');
  });
});

// ── Helper: costruisce un EML minimale con header + body + (opz.) allegato ──────
function eml(headers: Record<string, string>, body: string, attachment?: { name: string; type: string; data: string }): string {
  const hd = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
  if (!attachment) {
    return `${hd}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
  }
  const boundary = 'BOUND123';
  return [
    hd,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    `--${boundary}`,
    `Content-Type: ${attachment.type}; name="${attachment.name}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${attachment.name}"`,
    '',
    Buffer.from(attachment.data).toString('base64'),
    `--${boundary}--`,
  ].join('\r\n');
}

describe('buildPecMessage — integrazione simpleParser', () => {
  it('🚨 estrae messageId/from/to/subject/body + pecType da una PEC ricevuta', async () => {
    const raw = eml({
      'Message-ID': '<abc@pec.it>',
      From: 'mittente@pec.it',
      To: 'destinatario@pec.it',
      Subject: 'Comunicazione',
      'X-Trasporto': 'posta-certificata',
    }, 'Corpo del messaggio PEC.');
    const msg = buildPecMessage(await simpleParser(raw));
    expect(msg.messageId).toBe('<abc@pec.it>');
    expect(msg.from).toBe('mittente@pec.it');
    expect(msg.to).toBe('destinatario@pec.it');
    expect(msg.subject).toBe('Comunicazione');
    expect(msg.body).toContain('Corpo del messaggio PEC');
    expect(msg.pecType).toBe('received');
    expect(msg.pecHeaders['X-Trasporto']).toBe('posta-certificata');
  });

  it('🚨 ricevuta di avvenuta-consegna → pecType delivery + header esposti', async () => {
    const raw = eml({
      'Message-ID': '<r1@pec.it>',
      From: 'posta-certificata@pec.aruba.it',
      To: 'mittente@pec.it',
      Subject: 'CONSEGNA: Comunicazione',
      'X-Ricevuta': 'avvenuta-consegna',
      'X-Riferimento-Message-ID': '<abc@pec.it>',
    }, 'Ricevuta di avvenuta consegna.');
    const msg = buildPecMessage(await simpleParser(raw));
    expect(msg.pecType).toBe('delivery');
    expect(msg.pecHeaders['X-Riferimento-Message-ID']).toBe('<abc@pec.it>');
  });

  it('🚨 allegato → metadata + base64; size sotto soglia incluso', async () => {
    const raw = eml({
      From: 'a@pec.it', To: 'b@pec.it', Subject: 'con allegato',
      'X-Trasporto': 'posta-certificata',
    }, 'vedi allegato', { name: 'fattura.xml', type: 'application/xml', data: '<Fattura/>' });
    const msg = buildPecMessage(await simpleParser(raw));
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]?.filename).toBe('fattura.xml');
    expect(msg.attachments[0]?.contentType).toContain('xml');
    expect(Buffer.from(msg.attachments[0]?.contentBase64 ?? '', 'base64').toString()).toBe('<Fattura/>');
  });

  it('🚨 allegato oltre maxAttachmentBytes → metadata sì, base64 vuoto (no bloat)', async () => {
    const raw = eml({
      From: 'a@pec.it', To: 'b@pec.it', Subject: 'big',
      'X-Trasporto': 'posta-certificata',
    }, 'big', { name: 'big.bin', type: 'application/octet-stream', data: 'XXXXXXXXXX' });
    const msg = buildPecMessage(await simpleParser(raw), { maxAttachmentBytes: 1 });
    expect(msg.attachments[0]?.size).toBeGreaterThan(1);
    expect(msg.attachments[0]?.contentBase64).toBe('');
  });

  it('🚨 body troncato a maxBodyChars', async () => {
    const raw = eml({ From: 'a@pec.it', To: 'b@pec.it', Subject: 's', 'X-Trasporto': 'posta-certificata' }, 'X'.repeat(500));
    const msg = buildPecMessage(await simpleParser(raw), { maxBodyChars: 100 });
    expect(msg.body.length).toBe(100);
  });

  it('campi mancanti (no From/To/Subject) → stringhe vuote, niente throw', async () => {
    const msg = buildPecMessage(await simpleParser('Content-Type: text/plain\r\n\r\nsolo body'));
    expect(msg.from).toBe('');
    expect(msg.to).toBe('');
    expect(msg.subject).toBe('');
    expect(msg.pecType).toBe('received');
  });
});
