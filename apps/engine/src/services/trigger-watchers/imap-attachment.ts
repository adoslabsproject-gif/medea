/**
 * trigger-watchers/imap-attachment — costruzione dell'allegato IMAP nel payload
 * del trigger, ref-primario (split 2026-06-12, estratto dal monolite).
 *
 * Responsabilità unica: mappare un allegato email grezzo in un `ImapAttachment`
 * con handle `BinaryData`. Due percorsi, entrambi sicuri-by-design contro il
 * path-traversal (il `ref` è l'sha256 del CONTENUTO, mai il filename ostile):
 *   - CON blob-store → handle `ref` content-addressed, contenuto INTERO (dedup,
 *     quota per-tenant, byte fuori dal payload), nessun troncamento;
 *   - SENZA store (test/engine) → fail-soft inline base64 con cap anti-OOM.
 */

import { makeBinaryRef, makeBinaryInline, type BinaryData } from '@medea/engine-core-schema';
import type { BinaryStore } from '../binary-store.service.js';

/**
 * Cap dell'allegato tenuto INLINE nel payload (bytes) — si applica SOLO al
 * percorso fail-soft senza store. Oltre, viene troncato con `truncated: true`
 * per non far esplodere la RAM del runtime. Tunable via
 * `MEDEA_IMAP_MAX_ATTACHMENT_BYTES`. Col blob-store NON c'è cap (i byte
 * vivono su disco content-addressed).
 */
export const MAX_ATTACHMENT_BYTES = Number(
  process.env.MEDEA_IMAP_MAX_ATTACHMENT_BYTES ?? 25 * 1024 * 1024,
);

export interface ImapAttachment {
  filename: string;
  contentType: string;
  size: number;
  /** REF-PRIMARIO: l'allegato è SEMPRE un handle BinaryData (ref con store, inline
   *  base64 fail-soft senza). Mai più base64 grezzo nel payload del trigger. */
  binary: BinaryData;
  truncated: boolean;
}

/**
 * Mappa un allegato email in `ImapAttachment`. Testabile in isolamento.
 *
 *   • CON store → handle `ref` content-addressed: contenuto INTERO (niente
 *     troncamento), dedup, byte fuori dal payload. `ref` = sha256 del CONTENUTO,
 *     mai il filename → un filename ostile (`../../etc/x`) da un'email NON può
 *     causare path-traversal: resta puro metadata.
 *   • SENZA store (fail-soft) → handle inline base64, cap a `maxBytes` (anti-OOM).
 *     In produzione lo store c'è sempre → nessun cap nel path reale.
 */
export async function buildImapAttachment(
  att: { filename?: string | undefined; contentType: string; content: Buffer },
  store: Pick<BinaryStore, 'writeBuffer'> | undefined,
  maxBytes: number = MAX_ATTACHMENT_BYTES,
): Promise<ImapAttachment> {
  const filename = att.filename ?? 'attachment';
  const size = att.content.length;
  if (store) {
    const r = await store.writeBuffer(att.content);
    return {
      filename,
      contentType: att.contentType,
      size,
      truncated: false,
      binary: makeBinaryRef({
        mimeType: att.contentType,
        ref: r.ref,
        size: r.size,
        sha256: r.sha256,
        fileName: filename,
      }),
    };
  }
  const truncated = size > maxBytes;
  const buf = truncated ? att.content.subarray(0, maxBytes) : att.content;
  return {
    filename,
    contentType: att.contentType,
    size,
    truncated,
    binary: makeBinaryInline({
      mimeType: att.contentType,
      data: buf.toString('base64'),
      fileName: filename,
    }),
  };
}
