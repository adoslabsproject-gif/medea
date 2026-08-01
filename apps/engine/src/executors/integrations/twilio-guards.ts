/**
 * twilio-guards — protezione ANTI TOLL-FRAUD per gli invii SMS/WhatsApp.
 *
 * Un nodo Twilio senza limiti è un rischio finanziario: un loop nel workflow, un
 * trigger ad alta frequenza o un autore ostile possono emettere migliaia di SMS →
 * bolletta Twilio enorme (toll fraud / pumping). Il guard impone un tetto PER-TENANT
 * di invii al minuto (leaky-bucket in-memory, come {@link ../error-outbox/fanout-rate-limit}).
 *
 * In-memory è adeguato: il danno da limitare è il VOLUME al minuto; un restart del
 * container regala al più una finestra fresca (accettabile, non un bypass strutturale).
 * I bucket scaduti sono GC'ati su accesso → nessun memory leak da tenant inattivi.
 *
 * @module executors/integrations/twilio-guards
 */

interface SendBucket {
  count: number;
  windowStart: number;
}

const sendBuckets = new Map<string, SendBucket>();
const WINDOW_MS = 60_000;

/** Tetto invii/minuto per tenant (default 30). Override via env per piani enterprise. */
function maxSendsPerMin(): number {
  const raw = Number(process.env.FLOWFORGE_TWILIO_MAX_SENDS_PER_MIN ?? '30');
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

/**
 * Registra un tentativo di invio per `tenantId` e dice se è consentito. Da chiamare
 * UNA volta per invio (non per retry). Quando ritorna `allowed:false` il chiamante
 * deve rifiutare l'invio con un errore chiaro (niente retry).
 */
export function checkTwilioSendRateLimit(tenantId: string): { allowed: boolean; max: number } {
  const max = maxSendsPerMin();
  const now = Date.now();
  const bucket = sendBuckets.get(tenantId);
  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    sendBuckets.set(tenantId, { count: 1, windowStart: now });
    return { allowed: true, max };
  }
  if (bucket.count >= max) return { allowed: false, max };
  bucket.count++;
  return { allowed: true, max };
}

/** Esposto per i test (reset deterministico dei bucket). */
export const __testHooks__ = { sendBuckets, maxSendsPerMin };
