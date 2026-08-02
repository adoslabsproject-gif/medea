/**
 * webhook-token — derivazione e verifica del token webhook di default
 * (authMode `none`), UNICA fonte di verità.
 *
 * Il token NON è persistito da nessuna parte: è DERIVATO dal secret corrente
 * del container via HMAC-SHA256(MEDEA_SSO_SECRET, "webhook:<workflowId>").
 * Questo è il motivo per cui un link che CABLA il token si rompe quando il
 * secret ruota (migrazione legacy→derived, rotazione master del portal,
 * disaster recovery): il fix sistemico è l'indirection `ref://` (vedi
 * `lib/webhook-ref.ts`) — i link interni referenziano il workflow, mai il
 * token, e il resolver lo ricalcola a ogni run dal secret CORRENTE.
 *
 * GRACE PERIOD (rotazione senza downtime): durante una rotazione del secret,
 * l'operatore può settare `MEDEA_WEBHOOK_GRACE_SECRETS` (comma-separated,
 * ognuno ≥32 char) con i secret PRECEDENTI. `verifyDefaultWebhookToken`
 * accetta anche i token derivati da questi secret e segnala `viaGraceSecret`
 * al chiamante, che DEVE loggarlo: la finestra è temporanea e osservabile,
 * non un secondo canale permanente.
 *
 * Legge `process.env` a ogni chiamata (non lo snapshot di config): il secret
 * è iniettato a provision-time e i test lo ruotano per verificare il contract
 * di rotazione.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Lunghezza minima accettata per un secret (allineata a config.MEDEA_SSO_SECRET). */
const MIN_SECRET_LENGTH = 32;

/** Confronto constant-time (primitiva nativa; length pubblica per token/HMAC). */
function constantTimeCompare(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Deriva il token webhook (32 char hex, 128 bit) da un secret ESPLICITO.
 * Torna stringa vuota se il secret è assente/corto → il chiamante fallisce
 * closed (nessun token valido esiste senza secret).
 */
export function deriveWebhookTokenFromSecret(secret: string, workflowId: string): string {
  if (!secret || secret.length < MIN_SECRET_LENGTH) return '';
  return createHmac('sha256', secret).update(`webhook:${workflowId}`).digest('hex').slice(0, 32);
}

/**
 * Deriva il token webhook di default dal secret CORRENTE del container.
 * Senza MEDEA_SSO_SECRET (caso impossibile in prod), torna stringa
 * vuota → authorize fail.
 */
export function deriveDefaultWebhookToken(workflowId: string): string {
  return deriveWebhookTokenFromSecret(process.env.MEDEA_SSO_SECRET ?? '', workflowId);
}

/**
 * Secret precedenti accettati in grace window durante una rotazione.
 * Vuoto quando la env non è settata (caso normale). Entry più corte di
 * MIN_SECRET_LENGTH sono scartate: un secret corto non è mai stato valido.
 */
function graceSecrets(): string[] {
  const raw = process.env.MEDEA_WEBHOOK_GRACE_SECRETS ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_SECRET_LENGTH);
}

export interface WebhookTokenVerdict {
  /** true se il token combacia col secret corrente O con un grace secret. */
  valid: boolean;
  /** true se ha matchato SOLO un grace secret → il chiamante logga il warn. */
  viaGraceSecret: boolean;
}

/**
 * Verifica un token webhook di default: prima contro il secret corrente,
 * poi (solo se fallisce) contro ogni grace secret. Constant-time su ogni
 * confronto singolo; l'early-return sul match corrente non leaka nulla di
 * segreto (distingue solo "corrente" da "grace", informazione già nota al
 * possessore di un token valido).
 */
export function verifyDefaultWebhookToken(workflowId: string, providedToken: string): WebhookTokenVerdict {
  const current = deriveDefaultWebhookToken(workflowId);
  if (current !== '' && constantTimeCompare(providedToken, current)) {
    return { valid: true, viaGraceSecret: false };
  }
  for (const secret of graceSecrets()) {
    const graced = deriveWebhookTokenFromSecret(secret, workflowId);
    if (graced !== '' && constantTimeCompare(providedToken, graced)) {
      return { valid: true, viaGraceSecret: true };
    }
  }
  return { valid: false, viaGraceSecret: false };
}
