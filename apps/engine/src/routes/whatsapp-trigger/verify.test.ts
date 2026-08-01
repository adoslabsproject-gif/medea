/**
 * verify.ts — firma X-Hub-Signature-256 + verification handshake Meta.
 *
 * Bug-bounty first: firma manomessa, prefisso mancante, secret vuoto
 * (fail-closed), body alterato di 1 byte, mode sbagliato, challenge vuoto.
 * Ogni assert è mutation-sensitive: invertire un confronto o togliere un
 * check fail-closed fa diventare rosso almeno un test.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyMetaSignature, evaluateHandshake } from './verify.js';

const SECRET = 'meta-app-secret-test';

function sign(body: string, secret: string = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

describe('verifyMetaSignature', () => {
  it('accetta la firma corretta sui byte esatti del body', () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    expect(verifyMetaSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('🚨 rifiuta se il body è alterato di UN byte (firma non più valida)', () => {
    const body = '{"a":1}';
    expect(verifyMetaSignature('{"a":2}', sign(body), SECRET)).toBe(false);
  });

  it('🚨 rifiuta firma calcolata con secret diverso', () => {
    const body = '{"a":1}';
    expect(verifyMetaSignature(body, sign(body, 'wrong-secret'), SECRET)).toBe(false);
  });

  it('🚨 fail-closed: appSecret vuoto → SEMPRE rifiutato, anche con firma "coerente" su secret vuoto', () => {
    const body = '{"a":1}';
    // Un attacker che sa che il secret è vuoto potrebbe firmare con ''.
    expect(verifyMetaSignature(body, sign(body, ''), '')).toBe(false);
  });

  it('rifiuta header senza prefisso sha256=', () => {
    const body = '{"a":1}';
    const bareHex = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifyMetaSignature(body, bareHex, SECRET)).toBe(false);
  });

  it('rifiuta header vuoto / spazzatura / hex troncato', () => {
    const body = '{"a":1}';
    expect(verifyMetaSignature(body, '', SECRET)).toBe(false);
    expect(verifyMetaSignature(body, 'sha256=', SECRET)).toBe(false);
    expect(verifyMetaSignature(body, 'sha256=deadbeef', SECRET)).toBe(false);
    expect(verifyMetaSignature(body, sign(body).slice(0, -2), SECRET)).toBe(false);
  });

  it('la firma copre i byte utf8 reali (payload con emoji/accenti)', () => {
    const body = JSON.stringify({ text: 'una pizza però 🍕 sùbito' });
    expect(verifyMetaSignature(body, sign(body), SECRET)).toBe(true);
  });
});

describe('evaluateHandshake', () => {
  const q = (over: Partial<{ mode: string; verifyToken: string; challenge: string }> = {}) => ({
    mode: 'subscribe',
    verifyToken: 'tok-123',
    challenge: 'challenge-echo-me',
    ...over,
  });

  it('token corretto + mode=subscribe → ritorna il challenge da echo-are', () => {
    expect(evaluateHandshake(q(), 'tok-123')).toBe('challenge-echo-me');
  });

  it('🚨 token sbagliato → null (403)', () => {
    expect(evaluateHandshake(q({ verifyToken: 'tok-999' }), 'tok-123')).toBeNull();
  });

  it('🚨 fail-closed: expectedToken vuoto (nodo non configurato) → null anche se il client manda vuoto', () => {
    expect(evaluateHandshake(q({ verifyToken: '' }), '')).toBeNull();
  });

  it('mode diverso da subscribe → null', () => {
    expect(evaluateHandshake(q({ mode: 'unsubscribe' }), 'tok-123')).toBeNull();
    expect(evaluateHandshake(q({ mode: '' }), 'tok-123')).toBeNull();
  });

  it('challenge vuoto → null (niente echo di stringa vuota)', () => {
    expect(evaluateHandshake(q({ challenge: '' }), 'tok-123')).toBeNull();
  });

  it('token con lunghezza diversa → null senza throw (length-check del timing-safe)', () => {
    expect(evaluateHandshake(q({ verifyToken: 'tok-123-molto-piu-lungo' }), 'tok-123')).toBeNull();
  });
});
