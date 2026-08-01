/**
 * Italian PEC receipt parser.
 *
 * Background
 * ──────────
 * Posta Elettronica Certificata (PEC) — the Italian legally-binding email
 * — exchanges three classes of message between sender and recipient:
 *
 *   1. The real message (busta di trasporto).
 *   2. Acceptance receipts (ricevuta di accettazione) — proof that the
 *      sender's PEC provider received the message.
 *   3. Delivery receipts (avvenuta consegna) — proof that the message
 *      landed in the recipient's PEC mailbox.
 *   4. Rejection receipts (non-accettazione, errore-consegna, virus-rilevato,
 *      preavviso-non-consegna) — proof that the message did NOT reach the
 *      recipient.
 *
 * All four are delivered to BOTH parties' INBOX over IMAP/POP3. Without
 * parsing, a workflow would see them as four indistinguishable "new mail"
 * events and the studio would have to read each one to figure out what
 * happened. This module classifies them in O(1) by header inspection.
 *
 * The canonical header per DPR n.68/2005 + DM 2/11/2005
 * ─────────────────────────────────────────────────────
 *   X-Riferimento-Message-ID  — points at the original message's Message-ID
 *   X-Ricevuta                — receipt category (8 values, listed below)
 *   X-TipoRicevuta            — "completa" | "breve" | "sintetica"
 *   X-Trasporto               — "posta-certificata" | "errore"
 *
 * The 8 official `X-Ricevuta` values
 * ──────────────────────────────────
 *   accettazione                  → acceptance
 *   non-accettazione              → rejection (provider refused)
 *   presa-in-carico               → in-transit (provider forwarded)
 *   avvenuta-consegna             → delivery confirmed
 *   errore-consegna               → rejection (delivery failed)
 *   preavviso-errore-consegna     → rejection (12h warning, retry pending)
 *   rilevazione-virus             → rejection (virus detected)
 *   (absent)                      → not a receipt → normal message
 *
 * @module lib/pec/receipt-parser
 */

const ERR_PREFIX = '[pec-parser]';

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

export type PecMessageType =
  | 'pec_received_message'     // normal message (no X-Ricevuta header)
  | 'pec_acceptance_receipt'   // accettazione, presa-in-carico
  | 'pec_delivery_receipt'     // avvenuta-consegna
  | 'pec_rejection';           // non-accettazione, errore-consegna,
                                // preavviso-errore-consegna, rilevazione-virus

/** The raw X-Ricevuta header values that map to each category. */
export const PEC_RECEIPT_VALUES = Object.freeze({
  acceptance: ['accettazione', 'presa-in-carico'] as const,
  delivery: ['avvenuta-consegna'] as const,
  rejection: [
    'non-accettazione', 'errore-consegna',
    'preavviso-errore-consegna', 'rilevazione-virus',
  ] as const,
});

export interface PecClassification {
  /** The type the workflow should branch on. */
  type: PecMessageType;
  /** Raw `X-Ricevuta` value when present (debug + audit trail). */
  receiptCategory: string | null;
  /** `X-TipoRicevuta` value when present: completa | breve | sintetica. */
  receiptStyle: string | null;
  /** The Message-ID this receipt refers to, when present. */
  refMessageId: string | null;
  /** `X-Trasporto` value: posta-certificata | errore (rarely missing). */
  trasporto: string | null;
  /** Whether this is a PEC mail at all (presence of any PEC header). */
  isPec: boolean;
}

export type PecInputHeaders = Record<string, string | string[] | undefined>;

// ────────────────────────────────────────────────────────────────────────────
// Classifier
// ────────────────────────────────────────────────────────────────────────────

/**
 * Classify a single PEC message by its headers. Pure function; no I/O.
 *
 * Header lookup is case-insensitive (IMAP/SMTP normalise headers
 * inconsistently across servers — we accept either case).
 *
 * Throws when the `headers` argument is not an object — at the boundary
 * we trust the IMAP client to give us a flat headers map.
 */
export function classifyPecMessage(headers: PecInputHeaders): PecClassification {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new TypeError(`${ERR_PREFIX} classifyPecMessage: expected a headers object`);
  }

  const ricevutaRaw = readHeader(headers, 'X-Ricevuta');
  const receiptCategory = ricevutaRaw?.trim().toLowerCase() ?? null;
  const refMessageId = readHeader(headers, 'X-Riferimento-Message-ID')?.trim() ?? null;
  const receiptStyle = readHeader(headers, 'X-TipoRicevuta')?.trim().toLowerCase() ?? null;
  const trasporto = readHeader(headers, 'X-Trasporto')?.trim().toLowerCase() ?? null;

   
  const isPec = Boolean(trasporto || ricevutaRaw || refMessageId);

  let type: PecMessageType;
  if (receiptCategory === null) {
    type = 'pec_received_message';
  } else if ((PEC_RECEIPT_VALUES.acceptance as readonly string[]).includes(receiptCategory)) {
    type = 'pec_acceptance_receipt';
  } else if ((PEC_RECEIPT_VALUES.delivery as readonly string[]).includes(receiptCategory)) {
    type = 'pec_delivery_receipt';
  } else if ((PEC_RECEIPT_VALUES.rejection as readonly string[]).includes(receiptCategory)) {
    type = 'pec_rejection';
  } else {
    // Unknown X-Ricevuta value — treat as received_message but expose the
    // raw category so the workflow author can spot a new provider variant.
    type = 'pec_received_message';
  }

  return {
    type,
    receiptCategory,
    receiptStyle,
    refMessageId,
    trasporto,
    isPec,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function readHeader(headers: PecInputHeaders, name: string): string | undefined {
  // IMAP libraries vary: some give us the canonical case, some lowercase.
  // We try both, then fall back to a case-insensitive linear scan.
  const lower = name.toLowerCase();
  const direct = headers[name] ?? headers[lower];
  if (typeof direct === 'string') return direct;
  if (Array.isArray(direct) && direct.length > 0 && typeof direct[0] === 'string') return direct[0];
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) {
      const v = headers[k];
      if (typeof v === 'string') return v;
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') return v[0];
    }
  }
  return undefined;
}
