/**
 * Client S2S runtime → portal per l'invio dell'email di notifica errore.
 *
 * #1 (review): il container NON ha SMTP (465 bloccata in egress) → l'invio è
 * DELEGATO al portal, che manda con Orion 587/STARTTLS. Questo client è la `sendViaPortal`
 * iniettata nel makeEmailDispatcher; THROWA su fallimento/non-2xx così il worker
 * dell'outbox ritenta (#2, at-least-once).
 *
 * Trust boundary: usa `internalAwareFetch` scope:'portal' (il portal è su host privato
 * host.docker.internal → il SSRF guard lo bloccherebbe; lo scope concede il bypass SOLO
 * verso l'origin del portal) + `getOutboundPortalToken` (il portal valida col SUO
 * FLOWFORGE_INTERNAL_TOKEN; usiamo PORTAL_CALLBACK_TOKEN propagato in onboarding).
 */

import { internalAwareFetch } from '@/lib/internal-service-fetch.js';
import { getOutboundPortalToken } from '@/lib/internal-token.js';
import type { FailureEmailPayload } from './dispatchers/email.dispatcher.js';

const PORTAL_URL = process.env.PORTAL_INTERNAL_URL ?? 'http://host.docker.internal:3006';
const SEND_TIMEOUT_MS = 20_000;

/**
 * Invia (via portal S2S) l'email di notifica errore. Throwa se:
 *  - manca il token interno (mis-config → meglio ritentare che perdere silenziosamente);
 *  - la rete fallisce / timeout;
 *  - il portal risponde non-2xx (incluso 502 = SMTP fallito → ritenta).
 */
export async function sendFailureEmailViaPortal(payload: FailureEmailPayload): Promise<void> {
  const token = getOutboundPortalToken();
  if (!token) {
    throw new Error('portal internal token missing — cannot send failure email');
  }

  const res = await internalAwareFetch(
    `${PORTAL_URL}/api/v1/internal/error-email/send`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-token': token },
      body: JSON.stringify(payload),
      timeoutMs: SEND_TIMEOUT_MS,
    },
    { allow: 'portal' },
  );
  // Anti-OOM: il body non ci serve → drena/cancella senza leggere.
  try { await res.body?.cancel(); } catch { /* best-effort */ }

  if (!res.ok) {
    throw new Error(`portal error-email/send: HTTP ${String(res.status)}`);
  }
}
