import { describe, it, expect } from 'vitest';
import { classifyDbConnectionError } from './db-connection-error.js';

describe('classifyDbConnectionError — errori REALI di connettività → 503', () => {
  it('🚨 ssh2 handshake timeout (il bug NHA 2026-06-17) → unreachable + msg che cita fail2ban/irraggiungibile', () => {
    const r = classifyDbConnectionError(new Error('Timed out while waiting for handshake'));
    expect(r.unreachable).toBe(true);
    expect(r.userMessage).toMatch(/tunnel SSH|irraggiungibile|fail2ban/i);
  });

  it('🚨 ssh auth fallita → unreachable + msg su chiave/credenziali', () => {
    const r = classifyDbConnectionError(new Error('All configured authentication methods failed'));
    expect(r.unreachable).toBe(true);
    expect(r.userMessage).toMatch(/autenticazione|chiave|credenziali/i);
  });

  it('🚨 ECONNREFUSED → unreachable + "rifiutata"', () => {
    const r = classifyDbConnectionError(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
    expect(r.unreachable).toBe(true);
    expect(r.userMessage).toMatch(/rifiutata/i);
  });

  it('🚨 EHOSTUNREACH / ENETUNREACH → unreachable', () => {
    expect(classifyDbConnectionError(new Error('connect EHOSTUNREACH 91.98.131.3:22')).unreachable).toBe(true);
    expect(classifyDbConnectionError(new Error('connect ENETUNREACH')).unreachable).toBe(true);
  });

  it('🚨 DNS ENOTFOUND/getaddrinfo → unreachable + msg DNS', () => {
    const r = classifyDbConnectionError(new Error('getaddrinfo ENOTFOUND db.example.com'));
    expect(r.unreachable).toBe(true);
    expect(r.userMessage).toMatch(/DNS|hostname|risolv/i);
  });

  it('🚨 ETIMEDOUT generico → unreachable + "timeout"', () => {
    const r = classifyDbConnectionError(new Error('connect ETIMEDOUT 10.0.0.1:5432'));
    expect(r.unreachable).toBe(true);
    expect(r.userMessage).toMatch(/timeout/i);
  });

  it('🚨 ECONNRESET / connection terminated → unreachable', () => {
    expect(classifyDbConnectionError(new Error('Connection terminated unexpectedly')).unreachable).toBe(true);
    expect(classifyDbConnectionError(new Error('read ECONNRESET')).unreachable).toBe(true);
  });

  it('🔒 errore NON di connettività (es. SQL syntax) → unreachable:false (resta 400)', () => {
    expect(classifyDbConnectionError(new Error('syntax error at or near "SELCT"')).unreachable).toBe(false);
    expect(classifyDbConnectionError(new Error('relation "ghost" does not exist')).unreachable).toBe(false);
    expect(classifyDbConnectionError(new Error('permission denied for table x')).unreachable).toBe(false);
  });

  it('🔒 input non-Error (stringa/undefined) → non lancia', () => {
    expect(classifyDbConnectionError('Timed out while waiting for handshake').unreachable).toBe(true);
    expect(classifyDbConnectionError(undefined).unreachable).toBe(false);
    expect(classifyDbConnectionError(null).unreachable).toBe(false);
  });

  it('🔒 non-unreachable → userMessage vuoto (nessun falso messaggio)', () => {
    expect(classifyDbConnectionError(new Error('boom generico')).userMessage).toBe('');
  });
});
