/**
 * Verifica protocollo Meta per il trigger WhatsApp — funzioni PURE.
 *
 * Due flussi distinti del webhook Cloud API:
 *   1. GET verification handshake: Meta manda hub.mode=subscribe +
 *      hub.verify_token + hub.challenge; si risponde 200 col challenge
 *      SOLO se il verify token combacia (timing-safe), altrimenti 403.
 *   2. POST eventi: firmati X-Hub-Signature-256 = "sha256=" + hex di
 *      HMAC-SHA256(appSecret, raw body BYTES). La verifica DEVE avvenire
 *      sui byte esatti ricevuti (nessun re-serialize del JSON).
 *
 * Fail-closed ovunque: secret non configurato → mai autorizzato.
 *
 * @module routes/whatsapp-trigger/verify
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Confronto timing-safe fra stringhe (stesso pattern di routes/webhooks.ts):
 * primitiva nativa constant-time, length-check esplicito (la lunghezza di un
 * HMAC hex è pubblica, non leaka nulla).
 */
function constantTimeCompare(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Verifica la firma X-Hub-Signature-256 di un POST Meta.
 *
 * @param rawBody          i byte esatti del body come stringa utf8
 * @param signatureHeader  valore dell'header X-Hub-Signature-256 ("sha256=<hex>")
 * @param appSecret        App Secret dell'app Meta
 * @returns true SOLO se secret presente, header nel formato atteso e HMAC combacia
 */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string,
  appSecret: string,
): boolean {
  if (appSecret === '') return false; // fail-closed: mai accettare senza secret
  if (!signatureHeader.startsWith('sha256=')) return false;
  const provided = signatureHeader.slice('sha256='.length);
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  return constantTimeCompare(provided, expected);
}

export interface HandshakeQuery {
  mode: string;
  verifyToken: string;
  challenge: string;
}

/**
 * Valuta il verification handshake GET.
 *
 * @returns il challenge da echo-are (200 text/plain) se mode=subscribe e il
 *          token combacia timing-safe; null in ogni altro caso (→ 403).
 *          expectedToken vuoto = nodo non configurato → sempre null.
 */
export function evaluateHandshake(query: HandshakeQuery, expectedToken: string): string | null {
  if (expectedToken === '') return null; // fail-closed
  if (query.mode !== 'subscribe') return null;
  if (query.challenge === '') return null;
  if (!constantTimeCompare(query.verifyToken, expectedToken)) return null;
  return query.challenge;
}
