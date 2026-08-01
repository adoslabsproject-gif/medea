/**
 * Estrazione contenuto da busta CAdES `.p7m` (PKCS#7/CMS SignedData) — il
 * formato con cui le fatture elettroniche firmate viaggiano da/verso SdI e
 * arrivano via PEC (`IT...._xxxxx.xml.p7m`).
 *
 * Implementazione: walker ASN.1 DER/BER minimale e DIFENSIVO (zero dipendenze,
 * niente asn1js/pkijs nella supply-chain). Non verifica la firma — estrae il
 * payload (eContent). La VERIFICA della firma è compito del destinatario col
 * suo software di conservazione; qui serve leggere il contenuto per
 * automatizzarlo (parse fattura, archivio, AI).
 *
 * Struttura attesa:
 *   ContentInfo ::= SEQUENCE { contentType OID(1.2.840.113549.1.7.2 signedData),
 *     [0] EXPLICIT SignedData }
 *   SignedData ::= SEQUENCE { version, digestAlgorithms, encapContentInfo, … }
 *   EncapsulatedContentInfo ::= SEQUENCE { eContentType OID(1.2.840.113549.1.7.1),
 *     [0] EXPLICIT eContent OCTET STRING OPTIONAL }
 *
 * Supporta: lunghezze definite (corte e lunghe), OCTET STRING costruiti
 * (concatenazione dei segmenti), input base64/base64-spezzato (alcuni gestori
 * PEC ri-codificano il p7m come testo). Lunghezze INDEFINITE (BER 0x80)
 * rifiutate con errore chiaro (mai viste nei p7m SdI, che sono DER).
 *
 * @module executors/sdi/p7m-extract
 */

import type { NodeExecutor } from '@flowforge/nodes-stdlib';
import { resolveBinaryInline } from '@/executors/pdf.js';

const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_DATA = '1.2.840.113549.1.7.1';

interface Tlv {
  /** Tag completo (primo byte). */
  tag: number;
  /** true se constructed (bit 0x20). */
  constructed: boolean;
  /** Offset di inizio del contenuto. */
  start: number;
  /** Lunghezza del contenuto. */
  length: number;
  /** Offset del primo byte DOPO il TLV completo. */
  end: number;
}

class P7mError extends Error {}

/** Legge un TLV DER a partire da `off`. Lancia P7mError su struttura invalida. */
function readTlv(buf: Buffer, off: number): Tlv {
  if (off + 2 > buf.length) throw new P7mError(`ASN.1 troncato a offset ${String(off)}`);
  const tag = buf[off]!;
  if ((tag & 0x1f) === 0x1f) throw new P7mError('tag ASN.1 multi-byte non supportato (mai presente nei p7m SdI)');
  const lenByte = buf[off + 1]!;
  let start = off + 2;
  let length: number;
  if (lenByte === 0x80) {
    throw new P7mError('lunghezza BER indefinita non supportata: il p7m non è in DER canonico');
  } else if (lenByte & 0x80) {
    const n = lenByte & 0x7f;
    if (n > 4) throw new P7mError('lunghezza ASN.1 oltre 4 byte (payload > 4GB?)');
    if (start + n > buf.length) throw new P7mError('lunghezza ASN.1 troncata');
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + buf[start + i]!;
    start += n;
  } else {
    length = lenByte;
  }
  const end = start + length;
  if (end > buf.length) throw new P7mError('contenuto ASN.1 oltre la fine del buffer (file troncato?)');
  return { tag, constructed: (tag & 0x20) !== 0, start, length, end };
}

/** Decodifica un OID dal contenuto DER. */
function readOid(buf: Buffer, tlv: Tlv): string {
  const parts: number[] = [];
  let value = 0;
  for (let i = tlv.start; i < tlv.end; i++) {
    const b = buf[i]!;
    value = value * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) {
      if (parts.length === 0) {
        parts.push(Math.floor(value / 40) > 2 ? 2 : Math.floor(value / 40), Math.floor(value / 40) > 2 ? value - 80 : value % 40);
      } else {
        parts.push(value);
      }
      value = 0;
    }
  }
  return parts.join('.');
}

/** OCTET STRING primitivo o costruito → bytes concatenati. */
function octetStringBytes(buf: Buffer, tlv: Tlv): Buffer {
  if (!tlv.constructed) return buf.subarray(tlv.start, tlv.end);
  const chunks: Buffer[] = [];
  let off = tlv.start;
  while (off < tlv.end) {
    const inner = readTlv(buf, off);
    if ((inner.tag & 0x1f) !== 0x04) throw new P7mError('segmento inatteso dentro OCTET STRING costruito');
    chunks.push(octetStringBytes(buf, inner));
    off = inner.end;
  }
  return Buffer.concat(chunks);
}

/**
 * Estrae l'eContent (payload firmato) da un CMS SignedData DER.
 * @throws P7mError con messaggio actionable se la struttura non è un p7m valido.
 */
export function extractP7mContent(der: Buffer): Buffer {
  const contentInfo = readTlv(der, 0);
  if (contentInfo.tag !== 0x30) throw new P7mError('il file non inizia con una SEQUENCE ASN.1: non è un p7m');
  const oidTlv = readTlv(der, contentInfo.start);
  if ((oidTlv.tag & 0x1f) !== 0x06) throw new P7mError('ContentInfo senza contentType OID: non è un p7m');
  const oid = readOid(der, oidTlv);
  if (oid !== OID_SIGNED_DATA) {
    throw new P7mError(`contentType ${oid} non è SignedData (${OID_SIGNED_DATA}): busta CMS non firmata o tipo diverso`);
  }
  const explicit0 = readTlv(der, oidTlv.end);
  if (explicit0.tag !== 0xa0) throw new P7mError('SignedData assente ([0] EXPLICIT mancante)');
  const signedData = readTlv(der, explicit0.start);
  if (signedData.tag !== 0x30) throw new P7mError('SignedData non è una SEQUENCE');

  // SEQUENCE: version(INTEGER), digestAlgorithms(SET), encapContentInfo(SEQUENCE), …
  const version = readTlv(der, signedData.start);
  const digestAlgos = readTlv(der, version.end);
  const encap = readTlv(der, digestAlgos.end);
  if (encap.tag !== 0x30) throw new P7mError('encapContentInfo non trovato');
  const eContentType = readTlv(der, encap.start);
  const eOid = readOid(der, eContentType);
  if (eOid !== OID_DATA) throw new P7mError(`eContentType ${eOid} non è "data": payload non estraibile`);
  if (eContentType.end >= encap.end) {
    throw new P7mError('eContent ASSENTE: firma detached — il contenuto viaggia in un file separato');
  }
  const eContentWrap = readTlv(der, eContentType.end);
  if (eContentWrap.tag !== 0xa0) throw new P7mError('eContent [0] EXPLICIT mancante');
  const octet = readTlv(der, eContentWrap.start);
  if ((octet.tag & 0x1f) !== 0x04) throw new P7mError('eContent non è un OCTET STRING');
  return octetStringBytes(der, octet);
}

/** Riconosce e decodifica input base64 (con o senza a-capo). */
function coerceToDer(input: Buffer): Buffer {
  // DER SignedData inizia SEMPRE con 0x30. Se il buffer sembra testo base64,
  // decodifica (alcuni gestori PEC ricodificano l'allegato).
  if (input.length > 0 && input[0] === 0x30) return input;
  const text = input.toString('utf8').replace(/[\r\n\s]/gu, '');
  if (/^[A-Za-z0-9+/]+={0,2}$/u.test(text) && text.length >= 16) {
    const decoded = Buffer.from(text, 'base64');
    if (decoded.length > 0 && decoded[0] === 0x30) return decoded;
  }
  return input;
}

/**
 * Executor `italia_p7m_extract`.
 * Sorgenti del p7m, in ordine di precedenza:
 *   1. input BinaryData ref/base64 — l'ALLEGATO dell'IMAP/PEC trigger (il caso
 *      reale: il .p7m arriva come binario, non come stringa). Risolto via
 *      context.readBinary, stesso pattern ref-primario di action_pdf_parse.
 *   2. config.content — stringa base64 o XML (con {{espressioni}}).
 *   3. input.content — stringa dal nodo precedente.
 * Output: { content, wasSigned, sizeBytes, contentIsXml }
 */
/**
 * Il trigger IMAP/PEC emette `attachments: ImapAttachment[]`, ognuno con un
 * `binary` ref annidato. resolveBinaryInline scende un solo livello e non
 * entra negli array → qui selezioniamo l'allegato p7m (o l'unico presente) e
 * lo passiamo come sorgente, così PEC → p7m_extract si collega diretto senza
 * nodo intermedio. Preferenza: filename `.p7m` > primo con binary.
 */
function pickAttachment(input: unknown): unknown {
  if (input === null || typeof input !== 'object') return input;
  const raw = (input as { attachments?: unknown }).attachments;
  if (!Array.isArray(raw) || raw.length === 0) return input;
  // Array.isArray narrowa `unknown` ad `any[]` (nota limitazione TS): re-tipizzo
  // esplicitamente a unknown[] per non propagare `any` (gate no-unsafe-*).
  const atts: unknown[] = raw;
  const p7m = atts.find((a): boolean => {
    const name = a !== null && typeof a === 'object' ? (a as { filename?: unknown }).filename : undefined;
    return typeof name === 'string' && /\.p7m$/iu.test(name);
  });
  return p7m ?? atts[0];
}

export const p7mExtractExecutor: NodeExecutor = async (config, input, context) => {
  const start = Date.now();
  // 1) Allegato binario (IMAP/PEC): ref → context.readBinary, base64 → decode.
  //    Se l'input è la mail intera, seleziona l'allegato p7m da attachments[].
  const binSource = pickAttachment(input);
  const binBytes = await resolveBinaryInline(binSource, context.readBinary);
  let buf: Buffer;
  if (binBytes) {
    buf = binBytes;
  } else {
    // 2/3) Stringa da config o input.content.
    const raw = typeof config.content === 'string' && config.content !== ''
      ? config.content
      : (input && typeof input === 'object' && typeof (input as Record<string, unknown>).content === 'string'
        ? (input as Record<string, unknown>).content as string
        : '');
    if (raw === '') throw new Error('italia_p7m_extract: nessun contenuto — passa il p7m come allegato binario (input), oppure in base64 nel campo "content"');
    buf = Buffer.from(raw, 'utf8');
  }

  // Già XML in chiaro? Pass-through dichiarato (fatture NON firmate sono legali per B2B).
  const asText = buf.toString('utf8').trimStart();
  if (asText.startsWith('<?xml') || asText.startsWith('<')) {
    return {
      output: { content: buf.toString('utf8'), wasSigned: false, sizeBytes: buf.length, contentIsXml: true },
      durationMs: Date.now() - start,
    };
  }

  const der = coerceToDer(buf);
  if (der[0] !== 0x30) {
    throw new Error('italia_p7m_extract: il contenuto non è né XML né un p7m DER/base64 riconoscibile');
  }
  let payload: Buffer;
  try {
    payload = extractP7mContent(der);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`italia_p7m_extract: ${msg}`);
  }
  const text = payload.toString('utf8');
  const isXml = text.trimStart().startsWith('<');
  return {
    output: { content: text, wasSigned: true, sizeBytes: payload.length, contentIsXml: isXml },
    durationMs: Date.now() - start,
  };
};
