/**
 * Test bounce-parser — RFC 3464/3463. Bug-bounty: DSN reali (Postfix/Gmail),
 * hard vs soft, non-bounce → null, detection a segnali (forte/debole), malformati,
 * classificazione dal Diagnostic-Code quando Status manca, dedup recipients,
 * estrazione Message-ID originale (esplicito vs incapsulato).
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { parseBounce } from './bounce-parser.js';

// ── Fixture: hard bounce Postfix tipico (multipart/report) ──────────────────
const HARD_BOUNCE = [
  'From: MAILER-DAEMON@mx.example.com (Mail Delivery System)',
  'Subject: Undelivered Mail Returned to Sender',
  'Message-ID: <dsn-9988@mx.example.com>',
  'Content-Type: multipart/report; report-type=delivery-status; boundary="XYZ"',
  '',
  '--XYZ',
  'Content-Type: text/plain',
  '',
  'This is the mail system at host mx.example.com.',
  '',
  '--XYZ',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; mx.example.com',
  '',
  'Final-Recipient: rfc822; nobody@example.org',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 <nobody@example.org>: Recipient address rejected: User unknown',
  '',
  '--XYZ',
  'Content-Type: message/rfc822',
  '',
  'From: me@mydomain.com',
  'To: nobody@example.org',
  'Message-ID: <original-42@mydomain.com>',
  'Subject: Ciao',
  '',
  '--XYZ--',
].join('\r\n');

// ── Fixture: soft bounce (mailbox full, 4.2.2) ──────────────────────────────
const SOFT_BOUNCE = [
  'From: postmaster@mail.example.net',
  'Subject: Delivery Status Notification (Delay)',
  'Content-Type: message/delivery-status',
  '',
  'Final-Recipient: rfc822; busy@example.net',
  'Action: delayed',
  'Status: 4.2.2',
  'Diagnostic-Code: smtp; 452 4.2.2 Mailbox full',
].join('\r\n');

// ── Fixture: email NORMALE (non bounce) ─────────────────────────────────────
const NORMAL = [
  'From: friend@gmail.com',
  'Subject: Pranzo domani?',
  'Message-ID: <chat-1@gmail.com>',
  'Content-Type: text/plain',
  '',
  'Ci vediamo all\'una!',
].join('\r\n');

describe('parseBounce — detection + estrazione', () => {
  it('🚨 hard bounce (5.1.1) → tipo hard + recipient + status + Message-ID ORIGINALE', () => {
    const r = parseBounce({ source: HARD_BOUNCE });
    expect(r).not.toBeNull();
    expect(r!.bounceType).toBe('hard');
    expect(r!.failedRecipients).toEqual(['nobody@example.org']);
    expect(r!.status).toBe('5.1.1');
    expect(r!.action).toBe('failed');
    expect(r!.diagnosticCode).toMatch(/User unknown/);
    expect(r!.reportingMta).toBe('dns; mx.example.com');
    // Il Message-ID originale è il SECONDO (il primo è del DSN stesso).
    expect(r!.originalMessageId).toBe('<original-42@mydomain.com>');
  });

  it('🚨 soft bounce (4.2.2) → tipo soft, action delayed', () => {
    const r = parseBounce({ source: SOFT_BOUNCE });
    expect(r).not.toBeNull();
    expect(r!.bounceType).toBe('soft');
    expect(r!.action).toBe('delayed');
    expect(r!.failedRecipients).toEqual(['busy@example.net']);
  });

  it('🚨 email normale → null (NON è un bounce, niente falso positivo)', () => {
    expect(parseBounce({ source: NORMAL })).toBeNull();
  });

  it('🚨 detection debole: solo MAILER-DAEMON SENZA subject-failure né DSN → null (1 segnale debole non basta)', () => {
    const src = ['From: MAILER-DAEMON@x.com', 'Subject: Hello there', 'Content-Type: text/plain', '', 'ciao'].join('\r\n');
    expect(parseBounce({ source: src })).toBeNull();
  });

  it('🚨 detection debole: MAILER-DAEMON + subject-failure (no parti DSN) → riconosciuto', () => {
    const src = ['From: MAILER-DAEMON@x.com', 'Subject: Mail delivery failed: returning message', 'Content-Type: text/plain', '', 'failure'].join('\r\n');
    const r = parseBounce({ source: src });
    expect(r).not.toBeNull();
    expect(r!.bounceType).toBe('unknown'); // nessun codice → unknown
    expect(r!.failedRecipients).toEqual([]);
  });

  it('🚨 Status assente → classifica dal Diagnostic-Code SMTP (550 → hard)', () => {
    const src = [
      'Content-Type: message/delivery-status', '',
      'Final-Recipient: rfc822; x@y.com', 'Action: failed',
      'Diagnostic-Code: smtp; 550 mailbox unavailable',
    ].join('\r\n');
    const r = parseBounce({ source: src });
    expect(r).not.toBeNull();
    expect(r!.status).toBeNull();
    expect(r!.bounceType).toBe('hard');
  });

  it('🚨 malformato: Action presente ma niente Status/Final-Recipient → non basta come DSN forte → null se nessun altro segnale', () => {
    const src = ['From: x@y.com', 'Subject: ok', 'Content-Type: text/plain', '', 'Action: failed'].join('\r\n');
    expect(parseBounce({ source: src })).toBeNull();
  });

  it('🚨 più Final-Recipient duplicati → dedup + normalizzazione (lowercase, no <>)', () => {
    const src = [
      'Content-Type: message/delivery-status', '',
      'Final-Recipient: rfc822; <A@B.com>', 'Action: failed', 'Status: 5.0.0',
      '', 'Final-Recipient: rfc822; a@b.com', 'Action: failed', 'Status: 5.0.0',
    ].join('\r\n');
    const r = parseBounce({ source: src });
    expect(r!.failedRecipients).toEqual(['a@b.com']);
  });

  it('Original-Message-ID esplicito → usato direttamente', () => {
    const src = [
      'Content-Type: message/delivery-status', '',
      'Original-Message-ID: <explicit-7@me.com>',
      'Final-Recipient: rfc822; x@y.com', 'Action: failed', 'Status: 5.1.1',
    ].join('\r\n');
    expect(parseBounce({ source: src })!.originalMessageId).toBe('<explicit-7@me.com>');
  });

  it('🚨 source vuota / garbage → null, nessun crash', () => {
    expect(parseBounce({ source: '' })).toBeNull();
    expect(parseBounce({ source: '\r\n\r\n random bytes }{' })).toBeNull();
  });

  it('contentType/from/subject passati a parte (già estratti dal poller) sono usati', () => {
    const r = parseBounce({
      source: 'Final-Recipient: rfc822; z@w.com\r\nAction: failed\r\nStatus: 5.7.1',
      contentType: 'multipart/report; report-type=delivery-status',
    });
    expect(r).not.toBeNull();
    expect(r!.bounceType).toBe('hard');
  });
});
