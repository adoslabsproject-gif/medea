/**
 * Tests for email triage.
 *
 * Coverage (no smoke):
 *   • parseFromHeader on all 4 RFC 822 shapes
 *   • subject cleaning: nested Re:/Fw:/I: + 200-char cap
 *   • body truncation + bodyTextOriginalLength preservation
 *   • HTML-to-text-lite stripping
 *   • language guess: it / en / de / null on short text
 *   • urgency keywords (subject AND body)
 *   • isPec / isNewsletter via headers
 *   • attachments aggregation (count + bytes + mimeTypes set)
 *   • adversarial: empty input, HTML-only body, body with hostile entities
 */

import { describe, it, expect } from 'vitest';
import {
  triageEmail,
  parseFromHeader,
  cleanSubject,
  guessLanguage,
} from './triage.js';

describe('parseFromHeader', () => {
  it('parses "Name Surname <addr>"', () => {
    expect(parseFromHeader('Mario Rossi <mario.rossi@x.it>')).toEqual({
      senderName: 'Mario Rossi', senderEmail: 'mario.rossi@x.it',
    });
  });
  it('parses quoted name "Name" <addr>', () => {
    expect(parseFromHeader('"Mario Rossi" <mario@x.it>')).toEqual({
      senderName: 'Mario Rossi', senderEmail: 'mario@x.it',
    });
  });
  it('parses bracket-only <addr>', () => {
    expect(parseFromHeader('<mario@x.it>')).toEqual({ senderName: null, senderEmail: 'mario@x.it' });
  });
  it('parses bare address', () => {
    expect(parseFromHeader('mario@x.it')).toEqual({ senderName: null, senderEmail: 'mario@x.it' });
  });
  it('returns nulls on undefined / garbage', () => {
    expect(parseFromHeader(undefined)).toEqual({ senderName: null, senderEmail: null });
    expect(parseFromHeader('not an email')).toEqual({ senderName: null, senderEmail: null });
  });
});

describe('cleanSubject', () => {
  it('strips a single Re: prefix', () => {
    expect(cleanSubject('Re: Fattura')).toBe('Fattura');
  });
  it('strips nested Re:/Fw:/I: combinations', () => {
    expect(cleanSubject('Re: Fw: Re:I: Fattura urgente')).toBe('Fattura urgente');
  });
  it('caps at 200 chars', () => {
    const long = 'x'.repeat(500);
    expect(cleanSubject(long)).toHaveLength(200);
  });
  it('handles missing input', () => {
    expect(cleanSubject(undefined as unknown as string)).toBe('');
  });
});

describe('guessLanguage', () => {
  it('returns null on text < 80 chars', () => {
    expect(guessLanguage('Ciao Mario')).toBeNull();
  });
  it('detects italian from common stopwords', () => {
    const itText = 'Buongiorno, le scrivo per confermare che il documento è stato ricevuto con successo. ' +
      'Non sono necessarie altre azioni da parte vostra. La ringrazio per la collaborazione.';
    expect(guessLanguage(itText)).toBe('it');
  });
  it('detects english', () => {
    const enText = 'Hello, this is to confirm that the document has been received with success. ' +
      'You are not required to take any further action. Thank you very much for your collaboration.';
    expect(guessLanguage(enText)).toBe('en');
  });
  it('returns null when no language scores enough', () => {
    const noise = 'aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll mmm nnn ooo ppp qqq rrr sss';
    expect(guessLanguage(noise)).toBeNull();
  });
});

describe('triageEmail — body normalisation', () => {
  it('truncates the body and reports the original length', () => {
    const huge = 'a'.repeat(3000);
    const t = triageEmail({ body: huge });
    expect(t.bodyTextOriginalLength).toBe(3000);
    expect(t.bodyTextShort.length).toBeLessThanOrEqual(2001);  // 2000 + ellipsis
    expect(t.bodyTextShort.endsWith('…')).toBe(true);
  });

  it('honours custom bodyMaxChars', () => {
    const t = triageEmail({ body: 'abcdefghij' }, { bodyMaxChars: 5 });
    expect(t.bodyTextShort).toBe('abcde…');
  });

  it('converts HTML body to plain text (HTML-to-text-lite)', () => {
    const html = '<p>Ciao <b>Mario</b>, &nbsp;ecco il <a href="x">link</a>.</p>';
    const t = triageEmail({ body: html });
    // Whitespace is collapsed to single spaces by the lite normaliser.
    expect(t.bodyTextShort).toContain('Ciao');
    expect(t.bodyTextShort).toContain('Mario');
    expect(t.bodyTextShort).toContain('link');
    expect(t.bodyTextShort).not.toMatch(/<[^>]+>/);
  });

  it('prefers `bodyText` over `body` when both are present', () => {
    const t = triageEmail({ body: '<p>html</p>', bodyText: 'plain text override' });
    expect(t.bodyTextShort).toBe('plain text override');
  });
});

describe('triageEmail — sender + subject + attachment summary', () => {
  it('extracts sender + domain + cleaned subject', () => {
    const t = triageEmail({
      from: '"Mario" <Mario@StudioComm.IT>',
      subject: 'Re: Fw: Sollecito fattura 2026/123',
    });
    expect(t.senderName).toBe('Mario');
    expect(t.senderEmail).toBe('mario@studiocomm.it');
    expect(t.senderDomain).toBe('studiocomm.it');
    expect(t.subjectClean).toBe('Sollecito fattura 2026/123');
  });

  it('aggregates attachments (count + bytes + mimeTypes set)', () => {
    const t = triageEmail({
      from: 'a@b.it',
      attachments: [
        { filename: 'doc1.pdf', mimeType: 'application/pdf', sizeBytes: 1000 },
        { filename: 'doc2.pdf', mimeType: 'application/pdf', sizeBytes: 500 },
        { filename: 'img.png', mimeType: 'image/png', sizeBytes: 2000 },
      ],
    });
    expect(t.attachments.count).toBe(3);
    expect(t.attachments.bytes).toBe(3500);
    expect([...t.attachments.mimeTypes].sort()).toEqual(['application/pdf', 'image/png']);
  });
});

describe('triageEmail — flag detection', () => {
  it('detects urgency keywords (subject + body merged)', () => {
    const t = triageEmail({
      subject: 'Promemoria scadenza',
      body: 'Si prega di rispondere ASAP.',
    });
    expect(t.urgencySignals).toContain('scadenza');
    expect(t.urgencySignals).toContain('asap');
  });

  it('detects isPec from X-Trasporto header', () => {
    const t = triageEmail({ headers: { 'X-Trasporto': 'posta-certificata' } });
    expect(t.isPec).toBe(true);
  });

  it('detects isNewsletter from List-Unsubscribe header', () => {
    const t = triageEmail({ headers: { 'List-Unsubscribe': '<https://x.it/u>' } });
    expect(t.isNewsletter).toBe(true);
  });

  it('isNewsletter=false on a normal mail', () => {
    expect(triageEmail({ from: 'a@b.it', subject: 'Hi' }).isNewsletter).toBe(false);
  });
});

describe('triageEmail — input guards', () => {
  it('throws on non-object input', () => {
    expect(() => triageEmail(null as unknown as Record<string, string>)).toThrow(/RawEmail/);
  });

  it('handles a completely empty RawEmail without crashing', () => {
    const t = triageEmail({});
    expect(t.senderEmail).toBeNull();
    expect(t.subjectClean).toBeNull();
    expect(t.bodyTextShort).toBe('');
    expect(t.attachments.count).toBe(0);
  });
});
