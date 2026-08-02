/**
 * Parsing e classificazione di un messaggio PEC ricevuto.
 *
 * Una PEC NON è una semplice email: il gestore (Aruba) incapsula i messaggi in
 * "buste" e genera "ricevute" con header X-* normati (DPR 68/2005 + DM 2/11/2005,
 * regole tecniche). Il TIPO di messaggio (la PEC vera vs una ricevuta di
 * accettazione/consegna/errore) si determina da quegli header — informazione
 * essenziale per il triage legale che l'executor pec-receive deve esporre.
 *
 * Modulo separato dall'executor IMAP (I/O) e PURO sui dati → testabile esaustivo.
 */

import type { ParsedMail, AddressObject } from 'mailparser';

/** Le 4 categorie esposte al workflow (mappate dai valori X-Ricevuta normati). */
export type PecType = 'received' | 'acceptance' | 'delivery' | 'reject';

export interface PecAttachmentMeta {
  filename: string;
  contentType: string;
  size: number;
  /** Contenuto base64 (cap a maxAttachmentBytes; '' se oltre soglia). */
  contentBase64: string;
}

export interface PecParsedMessage {
  messageId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  attachments: PecAttachmentMeta[];
  /** Header PEC rilevanti (X-Trasporto, X-Ricevuta, X-Riferimento-Message-ID, …). */
  pecHeaders: Record<string, string>;
  pecType: PecType;
}

/**
 * Valori normati dell'header `X-Ricevuta` (DM 2/11/2005). Mappati alle 4 categorie:
 *  - accettazione                              → acceptance
 *  - avvenuta-consegna                         → delivery
 *  - non-accettazione / errore-consegna /
 *    mancata-consegna / rilevazione-virus /
 *    preavviso-errore-consegna                 → reject
 *  - (nessun X-Ricevuta, ma X-Trasporto:
 *    posta-certificata) = busta di trasporto   → received (la PEC vera e propria)
 */
const RICEVUTA_MAP: Readonly<Record<string, PecType>> = {
  accettazione: 'acceptance',
  'avvenuta-consegna': 'delivery',
  'non-accettazione': 'reject',
  'errore-consegna': 'reject',
  'mancata-consegna': 'reject',
  'rilevazione-virus': 'reject',
  'preavviso-errore-consegna': 'reject',
};

/**
 * Classifica il tipo di messaggio PEC dagli header (case-insensitive sulle chiavi).
 * Una ricevuta è identificata da `X-Ricevuta`; in sua assenza, `X-Trasporto:
 * posta-certificata` marca la busta di trasporto (PEC ricevuta = 'received').
 * Default conservativo: 'received' (un messaggio non riconosciuto è trattato come
 * posta in arrivo, non come ricevuta di sistema).
 */
export function classifyPecType(headers: Record<string, string>): PecType {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;

  const ricevuta = (lower['x-ricevuta'] ?? '').trim().toLowerCase();
  if (ricevuta !== '') {
    return RICEVUTA_MAP[ricevuta] ?? 'reject'; // un X-Ricevuta sconosciuto NON è posta normale
  }
  return 'received';
}

/** Estrae il primo indirizzo email da un campo address mailparser (o ''). */
function addressText(addr: AddressObject | AddressObject[] | undefined): string {
  if (addr === undefined) return '';
  const list = Array.isArray(addr) ? addr : [addr];
  const parts: string[] = [];
  for (const a of list) {
    for (const v of a.value) {
      if (v.address) parts.push(v.address);
    }
  }
  return parts.join(', ');
}

/** Header PEC rilevanti: chiave lowercase (come mailparser) → forma canonica esposta. */
const PEC_HEADER_CANONICAL: Readonly<Record<string, string>> = {
  'x-trasporto': 'X-Trasporto',
  'x-ricevuta': 'X-Ricevuta',
  'x-riferimento-message-id': 'X-Riferimento-Message-ID',
  'x-tiporicevuta': 'X-TipoRicevuta',
  'x-verificasicurezza': 'X-VerificaSicurezza',
};

/** Raccoglie gli header PEC rilevanti con chiavi CANONICHE (mailparser le lowercase-a). */
function extractPecHeaders(parsed: ParsedMail): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of parsed.headers) {
    const canonical = PEC_HEADER_CANONICAL[key.toLowerCase()];
    if (canonical !== undefined) {
      // Gli header X-* PEC sono testuali; un valore non-stringa (mailparser può
      // restituire oggetti strutturati per certi header) viene ignorato, non
      // serializzato a "[object Object]".
      if (typeof value === 'string') out[canonical] = value;
    }
  }
  return out;
}

export interface ParsePecOptions {
  /** Cap dimensione body (char) — default 100k. */
  maxBodyChars?: number;
  /** Cap dimensione singolo attachment per l'inline base64 — default 5 MB. */
  maxAttachmentBytes?: number;
}

/**
 * Trasforma un messaggio MIME già parsato (mailparser) nella shape PEC esposta al
 * workflow: { messageId, from, to, subject, body, attachments[], pecHeaders, pecType }.
 * Funzione PURA sul `ParsedMail` (nessun I/O) → l'executor fa il fetch IMAP + parse.
 */
export function buildPecMessage(parsed: ParsedMail, opts: ParsePecOptions = {}): PecParsedMessage {
  const maxBodyChars = opts.maxBodyChars ?? 100_000;
  const maxAttachmentBytes = opts.maxAttachmentBytes ?? 5 * 1024 * 1024;

  const pecHeaders = extractPecHeaders(parsed);
  const attachments: PecAttachmentMeta[] = (parsed.attachments ?? []).map((att) => {
    const size = att.size ?? att.content.byteLength;
    return {
      filename: att.filename ?? 'allegato',
      contentType: att.contentType || 'application/octet-stream',
      size,
      contentBase64: size <= maxAttachmentBytes ? att.content.toString('base64') : '',
    };
  });

  return {
    messageId: parsed.messageId ?? '',
    from: addressText(parsed.from),
    to: addressText(parsed.to),
    subject: parsed.subject ?? '',
    body: (parsed.text ?? '').slice(0, maxBodyChars),
    attachments,
    pecHeaders,
    pecType: classifyPecType(pecHeaders),
  };
}
