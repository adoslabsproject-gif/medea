/**
 * Verifica webhook Telegram Bot API — funzione PURA.
 *
 * Telegram non firma il body: l'autenticazione è il secret token passato a
 * setWebhook (&secret_token=...) che Telegram rimanda IDENTICO in ogni POST
 * nell'header `X-Telegram-Bot-Api-Secret-Token`. Confronto timing-safe,
 * fail-closed su secret non configurato.
 *
 * @module routes/telegram-trigger/verify
 */

import { timingSafeEqual } from 'node:crypto';

function constantTimeCompare(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * @param headerToken   valore dell'header X-Telegram-Bot-Api-Secret-Token
 * @param expectedToken secret configurato sul nodo trigger
 * @returns true SOLO se il secret è configurato e combacia timing-safe
 */
export function verifyTelegramSecret(headerToken: string, expectedToken: string): boolean {
  if (expectedToken === '') return false; // fail-closed: mai accettare senza secret
  if (headerToken === '') return false;
  return constantTimeCompare(headerToken, expectedToken);
}
