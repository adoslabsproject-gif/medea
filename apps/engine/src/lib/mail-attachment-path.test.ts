/**
 * Test bug-bounty — safeAttachmentPath (guard anti-LFI per allegati email).
 * Usa il `validateUrlForFetch` REALE (no mock): testo che i path su filesystem siano
 * rifiutati, gli URL privati/IMDS bloccati (SSRF) e gli URL pubblici http(s) ammessi.
 */
import { describe, it, expect } from 'vitest';
import { safeAttachmentPath, AttachmentPathError } from './mail-attachment-path.js';

describe('safeAttachmentPath', () => {
  it('🚨 path su filesystem → AttachmentPathError (LFI bloccata)', () => {
    for (const p of [
      '/app/.env', '/etc/passwd', '../../etc/shadow', './local', '~/secret',
      'file:///etc/passwd', '/proc/self/environ', 'C:\\Windows\\win.ini', 'data:text/plain,x',
    ]) {
      expect(() => safeAttachmentPath(p), `doveva bloccare ${p}`).toThrow(AttachmentPathError);
    }
  });

  it('🚨 URL privato/loopback/IMDS → bloccato (SSRF guard reale)', () => {
    for (const u of [
      'http://169.254.169.254/latest/meta-data',
      'http://127.0.0.1/x', 'http://localhost/x',
      'http://10.0.0.1/x', 'http://192.168.1.1/x',
    ]) {
      expect(() => safeAttachmentPath(u), `doveva bloccare ${u}`).toThrow(AttachmentPathError);
    }
  });

  it('✅ URL pubblico http(s) → ammesso, ritorna l\'URL trimmato', () => {
    expect(safeAttachmentPath('https://cdn.example.com/d.pdf')).toBe('https://cdn.example.com/d.pdf');
    expect(safeAttachmentPath('  https://cdn.example.com/x  ')).toBe('https://cdn.example.com/x');
  });

  it('🚨 schema non-http (ftp/gopher/javascript) → bloccato come filesystem', () => {
    for (const u of ['ftp://host/x', 'gopher://host', 'javascript:alert(1)', 'ssh://host']) {
      expect(() => safeAttachmentPath(u), `doveva bloccare ${u}`).toThrow(AttachmentPathError);
    }
  });

  it('errore è AttachmentPathError tipizzato', () => {
    try {
      safeAttachmentPath('/app/.env');
      throw new Error('doveva lanciare');
    } catch (e) {
      expect(e).toBeInstanceOf(AttachmentPathError);
    }
  });
});
