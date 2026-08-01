/**
 * bounce-parser — riconosce e struttura un BOUNCE (Delivery Status Notification)
 * da una email inbound. PURO (zero IO) → testabile con campioni DSN reali.
 *
 * Standard: RFC 3464 (DSN format, parti message/delivery-status), RFC 3463 (status
 * code enhanced X.Y.Z). Un bounce è tipicamente un multipart/report; report-type=
 * delivery-status inviato da MAILER-DAEMON/postmaster, con:
 *   - una parte message/delivery-status coi campi Action/Status/Final-Recipient/
 *     Diagnostic-Code/Reporting-MTA;
 *   - una parte message/rfc822 (o text/rfc822-headers) con gli header del messaggio
 *     ORIGINALE → da cui estraiamo il Message-ID per correlare al run d'invio.
 *
 * Non tutti i bounce sono DSN conformi: alcuni MTA mandano solo testo. Per questo la
 * detection è a più segnali (report-type / campi DSN / mittente daemon + subject),
 * e l'estrazione è best-effort campo-per-campo (un DSN malformato non deve crashare).
 *
 * bounceType: dalla CLASSE del codice RFC 3463 — 5.x.x = hard (permanente, rimuovi
 * dalla lista), 4.x.x = soft (transitorio, ritenta più tardi), altro = unknown.
 */

export type BounceType = 'hard' | 'soft' | 'unknown';

export interface BounceReport {
  /** Indirizzo/i destinatario che hanno fallito (Final-Recipient, normalizzati). */
  failedRecipients: string[];
  /** hard (5.x.x, permanente) | soft (4.x.x, transitorio) | unknown. */
  bounceType: BounceType;
  /** Codice enhanced RFC 3463, es. "5.1.1". null se assente. */
  status: string | null;
  /** Action RFC 3464: failed | delayed | delivered | relayed | expanded. null se assente. */
  action: string | null;
  /** Diagnostic-Code SMTP grezzo, es. "smtp; 550 5.1.1 User unknown". null se assente. */
  diagnosticCode: string | null;
  /** Message-ID del messaggio ORIGINALE rimbalzato (per correlazione al run). null se assente. */
  originalMessageId: string | null;
  /** Reporting-MTA che ha generato il DSN. null se assente. */
  reportingMta: string | null;
}

/** Campi minimi che ci servono da una email parsata (compat mailparser ParsedMail). */
export interface BounceParseInput {
  /** Sorgente MIME COMPLETA del messaggio (la più affidabile per i campi DSN). */
  source: string;
  /** Header Content-Type top-level (se già estratto). Opzionale: si ricava da source. */
  contentType?: string | undefined;
  /** Mittente (per il segnale MAILER-DAEMON). Opzionale. */
  from?: string | undefined;
  /** Subject (per il segnale euristico). Opzionale. */
  subject?: string | undefined;
}

/** Estrae il valore di un header RFC 822 (prima occorrenza), unfolding incluso. */
function headerValue(block: string, name: string): string | null {
  // Cattura `Name: value` con continuation lines (folding: righe che iniziano con spazio/tab).
  const re = new RegExp(`^${name}\\s*:[ \\t]*([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)`, 'im');
  const m = re.exec(block);
  if (m?.[1] === undefined) return null;
  return m[1].replace(/\r?\n[ \t]+/g, ' ').trim();
}

/** Final/Original-Recipient: "rfc822; user@example.com" → "user@example.com". */
function normalizeRecipient(raw: string): string {
  const afterSemi = raw.includes(';') ? raw.slice(raw.indexOf(';') + 1) : raw;
  return afterSemi.trim().replace(/^<|>$/g, '').trim().toLowerCase();
}

/** Status RFC 3463 "X.Y.Z" → classe (primo gruppo) → tipo bounce. */
function classifyStatus(status: string | null, diagnostic: string | null): BounceType {
  const fromStatus = status?.match(/^([245])\./)?.[1];
  if (fromStatus === '5') return 'hard';
  if (fromStatus === '4') return 'soft';
  // Fallback sul Diagnostic-Code SMTP (es. "550 ..." / "451 ...") se Status assente.
  const smtp = diagnostic?.match(/\b([45])\d\d\b/)?.[1];
  if (smtp === '5') return 'hard';
  if (smtp === '4') return 'soft';
  return 'unknown';
}

const DSN_SUBJECT_RE = /(delivery\s+status|undeliverable|returned\s+mail|delivery\s+has\s+failed|mail\s+delivery\s+failed|failure\s+notice|mail\s+system\s+error)/i;
const DAEMON_RE = /(mailer-daemon|postmaster)@/i;

/**
 * Riconosce e struttura un bounce. Ritorna null se il messaggio NON è (riconoscibile
 * come) un bounce → il chiamante lo ignora (non avvia il workflow bounce).
 *
 * Detection (un segnale forte O due deboli):
 *  - FORTE: report-type=delivery-status, o presenza di una parte message/delivery-status,
 *    o campi DSN (Action: + Status:/Final-Recipient:).
 *  - DEBOLE: mittente MAILER-DAEMON/postmaster; subject di tipo failure.
 */
export function parseBounce(input: BounceParseInput): BounceReport | null {
  const src = input.source;
  const ct = (input.contentType ?? headerValue(src, 'Content-Type') ?? '').toLowerCase();

  const hasReportType = /report-type\s*=\s*"?delivery-status"?/i.test(ct);
  const hasDeliveryStatusPart = /content-type:\s*message\/delivery-status/i.test(src);
  // I campi DSN: estraiamo dall'INTERA source (robusto anche se il MIME è atipico).
  const action = headerValue(src, 'Action');
  const status = headerValue(src, 'Status');
  const finalRecipientRaw = src.match(/^Final-Recipient\s*:[^\r\n]*/gim) ?? [];
  const hasDsnFields = action !== null && (status !== null || finalRecipientRaw.length > 0);

  const fromDaemon = DAEMON_RE.test(input.from ?? '') || DAEMON_RE.test(headerValue(src, 'From') ?? '');
  const failureSubject = DSN_SUBJECT_RE.test(input.subject ?? '') || DSN_SUBJECT_RE.test(headerValue(src, 'Subject') ?? '');

  const strong = hasReportType || hasDeliveryStatusPart || hasDsnFields;
  const weak = (fromDaemon ? 1 : 0) + (failureSubject ? 1 : 0);
  if (!strong && weak < 2) return null;

  // ── Estrazione campi (best-effort) ──────────────────────────────────────
  const failedRecipients = Array.from(
    new Set(
      finalRecipientRaw
        .map((line) => normalizeRecipient(line.slice(line.indexOf(':') + 1)))
        .filter((r) => r.length > 0 && r.includes('@')),
    ),
  );
  const diagnosticCode = headerValue(src, 'Diagnostic-Code');
  const reportingMta = headerValue(src, 'Reporting-MTA');

  // Message-ID originale: preferisci Original-Message-ID; altrimenti il PRIMO Message-ID
  // che NON sia quello del DSN stesso (il DSN top-level ha il suo Message-ID per primo).
  const explicitOriginal = headerValue(src, 'Original-Message-ID');
  let originalMessageId: string | null = explicitOriginal;
  if (originalMessageId === null) {
    const ids = src.match(/^Message-ID\s*:[ \t]*<[^>\r\n]+>/gim) ?? [];
    // [0] = Message-ID del bounce; [1] = quello del messaggio originale incapsulato.
    const pick = ids.length >= 2 ? ids[1] : undefined;
    if (pick !== undefined) {
      const mm = /<([^>]+)>/.exec(pick);
      originalMessageId = mm?.[1] !== undefined ? `<${mm[1]}>` : null;
    }
  } else {
    const mm = /<([^>]+)>/.exec(originalMessageId);
    originalMessageId = mm?.[1] !== undefined ? `<${mm[1]}>` : originalMessageId;
  }

  return {
    failedRecipients,
    bounceType: classifyStatus(status, diagnosticCode),
    status,
    action: action?.toLowerCase() ?? null,
    diagnosticCode,
    originalMessageId,
    reportingMta,
  };
}
