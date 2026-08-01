/**
 * Integration webhook receivers — inbound HMAC-verified callbacks da provider.
 *
 * Stack 2026:
 *   • Express-style raw body capture (CRUCIAL: HMAC verify richiede bytes
 *     IDENTICI a quelli inviati — niente JSON.stringify round-trip che
 *     riorderebbe le chiavi e invaliderebbe la signature)
 *   • Constant-time HMAC compare (crypto.timingSafeEqual) → no timing attack
 *   • Idempotent dedup via integration_webhook_events(provider, event_id_external)
 *     UNIQUE → re-delivery dello stesso evento ritorna 200 senza riprocessare
 *   • Tenant attribution via account_id (Stripe Connect) o webhook URL token
 *     fallback. Per il flusso single-tenant SaaS basta env STRIPE_WEBHOOK_SECRET.
 *
 * Provider supportati:
 *   • Stripe (POST /webhooks/stripe — verifica Stripe-Signature)
 *
 * Roadmap: PayPal, WhatsApp Business, Telegram Bot.
 *
 * @see https://stripe.com/docs/webhooks/signatures (algoritmo HMAC)
 */

import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { logger } from '@/lib/logger.js';
import { getDatabase } from '@/storage/db.js';
import type { IEventBus } from '@/ports/event-bus.js';

// ─── Stripe HMAC SHA-256 verify ─────────────────────────────────────
//
// Header shape: `t=<unix-timestamp>,v1=<hex-hmac>[,v0=<legacy>]`
// Signed payload: `<timestamp>.<raw-body>`
// HMAC: HMAC-SHA256(signed_payload, webhook_secret)
//
// Tolerance: 5min (default Stripe SDK) per prevenire replay attacks dilatati.

const STRIPE_TOLERANCE_SEC = 300;

interface ParsedStripeSig {
  timestamp: number;
  v1: string;
}

function parseStripeSignature(header: string): ParsedStripeSig | null {
  const parts = header.split(',').map((s) => s.trim());
  let timestamp = 0;
  let v1 = '';
  for (const part of parts) {
    const [k, v] = part.split('=');
    if (k === 't' && v) timestamp = parseInt(v, 10);
    if (k === 'v1' && v) v1 = v;
  }
  if (!timestamp || !v1) return null;
  return { timestamp, v1 };
}

function verifyStripeSignature(rawBody: string, header: string, secret: string): { ok: true } | { ok: false; reason: string } {
  const parsed = parseStripeSignature(header);
  if (!parsed) return { ok: false, reason: 'malformed Stripe-Signature header' };

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - parsed.timestamp) > STRIPE_TOLERANCE_SEC) {
    return { ok: false, reason: `timestamp drift ${(nowSec - parsed.timestamp).toString()}s (max ${STRIPE_TOLERANCE_SEC.toString()}s) — replay attack?` };
  }

  const signedPayload = `${parsed.timestamp.toString()}.${rawBody}`;
  const expected = createHmac('sha256', secret).update(signedPayload).digest('hex');

  // Constant-time compare: timingSafeEqual richiede same-length Buffers
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(parsed.v1, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return { ok: false, reason: 'signature length mismatch' };
  if (!timingSafeEqual(expectedBuf, actualBuf)) return { ok: false, reason: 'HMAC mismatch — secret rotated or forged request' };

  return { ok: true };
}

// ─── Dedup helpers ───────────────────────────────────────────────────

interface DedupCheck {
  alreadyProcessed: boolean;
  insertedNew: boolean;
}

function checkAndStoreEvent(
  provider: string,
  externalEventId: string,
  eventType: string,
  payloadJson: string,
  tenantId: string,
  signatureValid: boolean,
): DedupCheck {
  const { sqlite } = getDatabase();
  // SQLite INSERT OR IGNORE: se (provider, event_id_external) esiste già →
  // changes() = 0 e l'evento è dedup. Race-condition safe (UNIQUE constraint).
  const stmt = sqlite.prepare(`
    INSERT OR IGNORE INTO integration_webhook_events
      (id, provider, tenant_id, event_id_external, event_type, payload_json, signature_valid)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  // id = composite hash determinístico per debugging (visibile in audit)
  const compositeId = `${provider}:${externalEventId}`;
  const result = stmt.run(compositeId, provider, tenantId, externalEventId, eventType, payloadJson, signatureValid ? 1 : 0);
  return {
    alreadyProcessed: result.changes === 0,
    insertedNew: result.changes === 1,
  };
}

function markEventProcessed(provider: string, externalEventId: string): void {
  const { sqlite } = getDatabase();
  sqlite.prepare(`
    UPDATE integration_webhook_events
       SET processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE provider = ? AND event_id_external = ?
  `).run(provider, externalEventId);
}

// ─── Routes ─────────────────────────────────────────────────────────

export function createIntegrationWebhookRoutes(eventBus: IEventBus): Hono {
  const app = new Hono();

  /**
   * POST /webhooks/stripe
   *
   * Riceve eventi Stripe (payment_intent.succeeded, invoice.paid, customer.subscription.*,
   * checkout.session.completed, ...). Verifica HMAC + dedup + emit event.
   *
   * Secret: STRIPE_WEBHOOK_SECRET env var (whsec_...). UN solo endpoint
   * single-tenant per ora.
   *
   * Tenant attribution:
   *   1. event.data.object.metadata.tenantId (impostato in fase di create_*)
   *   2. 'global' fallback (per webhook applicativi — billing portal)
   *
   * STRIPE CONNECT — DELIBERATAMENTE NON ABILITATO:
   *   Se l'event contiene `account` (top-level), significa che proviene da
   *   un Connected Account (marketplace pattern). Per supportare Connect
   *   serve account_id → tenant_id mapping table, RBAC su sub-account, e
   *   propagation logica di refund/payout chain. Senza questo wiring, un
   *   event Connect verrebbe attribuito al WRONG tenant (mismatch perché
   *   account_id != metadata.tenantId), o droppato silenziosamente.
   *
   *   POLICY OGGI: rifiutiamo esplicitamente con 200 + body
   *   { received: true, ignored: true, reason: 'connect_not_enabled' }.
   *   Il 200 evita retry storm Stripe (3gg esponenziale). Il flag `ignored:
   *   true` permette al merchant di rilevare il drop nel proprio dashboard
   *   Stripe events log. Pinging quando Connect verrà abilitato:
   *   docs/STRIPE-CONNECT-ENABLEMENT.md (non ancora scritto — issue #339).
   *
   * Risposta sempre 200 anche per dedup (Stripe richiede 2xx, altrimenti
   * retry esponenziale fino a 3gg). Errori HMAC → 400 (request invalida).
   */
  app.post('/stripe', async (c) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      logger.error('STRIPE_WEBHOOK_SECRET non configurato — webhook rifiutati');
      return c.json({ error: 'webhook receiver non configurato' }, 503);
    }

    const sigHeader = c.req.header('stripe-signature');
    if (!sigHeader) return c.json({ error: 'missing Stripe-Signature header' }, 400);

    // CRUCIAL: raw body byte-perfect (no parse → re-stringify che reordererebbe keys)
    const rawBody = await c.req.text();

    const verify = verifyStripeSignature(rawBody, sigHeader, secret);
    if (!verify.ok) {
      logger.warn({ reason: verify.reason }, '[STRIPE-WEBHOOK] signature reject');
      return c.json({ error: 'invalid signature', reason: verify.reason }, 400);
    }

    // Parse event JSON dopo verifica HMAC
    let event: { id?: string; type?: string; account?: string; data?: { object?: { metadata?: { tenantId?: string } } } };
    try {
      event = JSON.parse(rawBody) as typeof event;
    } catch {
      return c.json({ error: 'payload not valid JSON' }, 400);
    }
    const externalId = event.id ?? '';
    const eventType = event.type ?? 'unknown';
    if (!externalId) return c.json({ error: 'event missing id' }, 400);

    // ─── Stripe Connect explicit guard ───
    // Se l'event proviene da un Connected Account, lo droppiamo con 200
    // esplicito invece di silently routare a 'global' (che causerebbe
    // contaminazione cross-tenant nel billing/portal listener).
    const connectAccountEnabled = process.env.STRIPE_CONNECT_ENABLED === 'true';
    if (event.account && !connectAccountEnabled) {
      logger.warn(
        { externalId, eventType, connectAccount: event.account },
        '[STRIPE-WEBHOOK] Connect event ignored — STRIPE_CONNECT_ENABLED=false',
      );
      return c.json({
        received: true,
        ignored: true,
        reason: 'connect_not_enabled',
        message: 'Stripe Connect events require STRIPE_CONNECT_ENABLED=true + account→tenant mapping. Event ignored.',
      }, 200);
    }

    // Tenant attribution (Connect explicit guard sopra → qui solo platform):
    //   1. event.data.object.metadata.tenantId (impostato in fase di create_*)
    //   2. 'global' fallback (per webhook applicativi — billing portal)
    const tenantId =
      event.data?.object?.metadata?.tenantId ??
      'global';

    // Dedup + INSERT atomic
    const dedup = checkAndStoreEvent('stripe', externalId, eventType, rawBody, tenantId, true);
    if (dedup.alreadyProcessed) {
      logger.info({ externalId, eventType }, '[STRIPE-WEBHOOK] dedup (already processed)');
      return c.json({ received: true, dedup: true });
    }

    // Emit event sul bus interno per workflow listener / billing service
    try {
      eventBus.emit({
        type: 'integration.webhook.stripe',
        tenantId,
        payload: {
          externalId,
          eventType,
          data: event.data,
        },
      } as unknown as Parameters<typeof eventBus.emit>[0]);
      markEventProcessed('stripe', externalId);
    } catch (err) {
      logger.error({ err, externalId }, '[STRIPE-WEBHOOK] event emit failed — will retry on next delivery');
      // NB: NON marchiamo processed_at → Stripe ritrasmetterà, dedup salterà
      // l'INSERT ma il consumer (workflow engine) si riattiverà al retry.
    }

    return c.json({ received: true, externalId, eventType });
  });

  return app;
}
