/**
 * Test reali email-sanitize — anti CRLF/header injection RFC 5322.
 * NO smoke fake. Asserisce VALORI specifici per input maliziosi.
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeEmailAddress,
  sanitizeEmailList,
  sanitizeEmailHeader,
  sanitizeEmailWithDisplayName,
  EmailSanitizeError,
} from './email-sanitize.js';

describe('sanitizeEmailAddress — happy path', () => {
  it('email valida → ritorna trimmed', () => {
    expect(sanitizeEmailAddress('  user@example.com  ')).toBe('user@example.com');
  });

  it('email con + tag → accettata', () => {
    expect(sanitizeEmailAddress('user+filter@example.com')).toBe('user+filter@example.com');
  });

  it('email con subdomain → accettata', () => {
    expect(sanitizeEmailAddress('a@mail.sub.example.com')).toBe('a@mail.sub.example.com');
  });

  it('email con dot in local → accettata', () => {
    expect(sanitizeEmailAddress('first.last@example.com')).toBe('first.last@example.com');
  });
});

describe('sanitizeEmailAddress — header injection (CRLF) attacks', () => {
  it('reject \\r\\n nell\'email → throw header injection', () => {
    expect(() => sanitizeEmailAddress('victim@x.com\r\nBcc: leak@evil.com')).toThrow(
      /control chars.*header injection blocked/,
    );
  });

  it('reject \\r solo (Mac legacy)', () => {
    expect(() => sanitizeEmailAddress('a@b.com\rBcc: x@y.com')).toThrow(/control chars/);
  });

  it('reject \\n solo (Unix)', () => {
    expect(() => sanitizeEmailAddress('a@b.com\nBcc: x@y.com')).toThrow(/control chars/);
  });

  it('reject NULL byte', () => {
    expect(() => sanitizeEmailAddress('a@b.com\0Bcc: x@y.com')).toThrow(/control chars/);
  });

  it('reject CRLF tab payload sneaky', () => {
    expect(() => sanitizeEmailAddress('a@b.com\r\n\tSubject: hacked')).toThrow(/control chars/);
  });
});

describe('sanitizeEmailAddress — format invalid', () => {
  it('reject senza @', () => {
    expect(() => sanitizeEmailAddress('notanemail')).toThrow(/email format invalid/);
  });

  it('reject senza domain', () => {
    expect(() => sanitizeEmailAddress('user@')).toThrow(/email format invalid/);
  });

  it('reject senza TLD', () => {
    expect(() => sanitizeEmailAddress('user@localhost')).toThrow(/email format invalid/);
  });

  it('reject email vuota', () => {
    expect(() => sanitizeEmailAddress('')).toThrow(/email is empty/);
    expect(() => sanitizeEmailAddress('   ')).toThrow(/email is empty/);
  });

  it('reject non-string', () => {
    expect(() => sanitizeEmailAddress(null)).toThrow(/email must be a string/);
    expect(() => sanitizeEmailAddress(123)).toThrow(/email must be a string/);
    expect(() => sanitizeEmailAddress(undefined)).toThrow(/email must be a string/);
  });

  it('reject email > 320 char (RFC 5321 limit)', () => {
    const long = 'a'.repeat(315) + '@b.com'; // 321 chars
    expect(() => sanitizeEmailAddress(long)).toThrow(/exceeds RFC 5321/);
  });

  it('throw è instance di EmailSanitizeError', () => {
    try {
      sanitizeEmailAddress('bad\r\nx');
    } catch (e) {
      expect(e).toBeInstanceOf(EmailSanitizeError);
    }
  });
});

describe('sanitizeEmailList — multi recipients', () => {
  it('array di email valide → ritorna sanitized', () => {
    expect(sanitizeEmailList(['a@x.com', 'b@y.com'])).toEqual(['a@x.com', 'b@y.com']);
  });

  it('CSV string → split + sanitize', () => {
    expect(sanitizeEmailList('a@x.com, b@y.com; c@z.com')).toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
  });

  it('null/undefined → array vuoto', () => {
    expect(sanitizeEmailList(null)).toEqual([]);
    expect(sanitizeEmailList(undefined)).toEqual([]);
  });

  it('uno solo invalido nell\'array → throw (no partial)', () => {
    expect(() => sanitizeEmailList(['a@x.com', 'bad\r\ninject@y.com'])).toThrow(/control chars/);
  });

  it('string vuota → array vuoto (no error)', () => {
    expect(sanitizeEmailList('')).toEqual([]);
    expect(sanitizeEmailList('  ')).toEqual([]);
  });
});

describe('sanitizeEmailHeader — subject/display name', () => {
  it('rimuove \\r\\n con spazio', () => {
    expect(sanitizeEmailHeader('Hello\r\nBcc: x@y.com')).toBe('Hello Bcc: x@y.com');
  });

  it('rimuove \\0', () => {
    expect(sanitizeEmailHeader('Hi\0there')).toBe('Hi there');
  });

  it('multiple \\r\\n consecutivi → single space', () => {
    expect(sanitizeEmailHeader('A\r\n\r\n\r\nB')).toBe('A B');
  });

  it('null/undefined → empty string', () => {
    expect(sanitizeEmailHeader(null)).toBe('');
    expect(sanitizeEmailHeader(undefined)).toBe('');
  });

  it('NON throw (utility per testo libero)', () => {
    expect(() => sanitizeEmailHeader('any\r\nthing')).not.toThrow();
  });
});

describe('sanitizeEmailWithDisplayName — RFC 5322 angle format', () => {
  it('"Name <email>" format → preservato', () => {
    expect(sanitizeEmailWithDisplayName('Nicola <n@x.com>')).toBe('"Nicola" <n@x.com>');
  });

  it('display name semplice (no nested quote) → wrapped', () => {
    expect(sanitizeEmailWithDisplayName('Dr Strange <dr@x.com>')).toBe('"Dr Strange" <dr@x.com>');
  });

  it('display name con CRLF → sanitized', () => {
    expect(sanitizeEmailWithDisplayName('Bad\r\nName <a@b.com>')).toBe('"Bad Name" <a@b.com>');
  });

  it('plain email senza angle → ritorna come sanitizeEmailAddress', () => {
    expect(sanitizeEmailWithDisplayName('a@b.com')).toBe('a@b.com');
  });

  it('email INSIDE angle invalida → throw', () => {
    expect(() => sanitizeEmailWithDisplayName('Name <invalid>')).toThrow(/email format invalid/);
  });

  it('email INSIDE angle con CRLF → throw header injection', () => {
    expect(() => sanitizeEmailWithDisplayName('N <a@b.com\r\nBcc: x>')).toThrow(/control chars/);
  });
});
