/**
 * mail-attachment-path — guard ANTI-LFI per il campo `path`/`url` degli allegati email.
 *
 * PROBLEMA: nodemailer interpreta l'opzione `path` di un allegato come: se è un URL
 * http(s) → lo *fetcha*; altrimenti → lo legge come FILE su disco. In un container
 * multi-tenant l'autore del workflow non ha accesso al filesystem del container: un
 * `path` su disco (`/app/.env`, `/proc/self/environ`, `../../etc/passwd`) sarebbe una
 * LFI → l'allegato esfiltrerebbe il MEDEA_SSO_SECRET / LICENSE_HMAC / internal token
 * via email. Le fonti LEGITTIME di un allegato sono: handle BinaryData (blob del tenant),
 * base64 inline, oppure un URL http(s) (passato per il guard SSRF).
 *
 * REGOLA: il valore passato a nodemailer come `path` DEVE essere un URL http(s) validato
 * SSRF. Qualsiasi path su filesystem (assoluto, relativo, `file://`, `~`) → throw.
 *
 * @module lib/mail-attachment-path
 */
import { validateUrlForFetch } from '@medea/engine-safe-fetch';

/** Sollevata quando un `path`/`url` di allegato non è ammesso (filesystem o SSRF). */
export class AttachmentPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentPathError';
  }
}

/**
 * Valida un `path`/`url` di allegato destinato all'opzione `path` di nodemailer.
 * Ammette SOLO URL http(s) e li passa per il guard SSRF; ritorna l'URL sicuro.
 * Lancia {@link AttachmentPathError} per path su filesystem o URL non sicuri.
 */
export function safeAttachmentPath(raw: string): string {
  const v = raw.trim();
  if (!/^https?:\/\//iu.test(v)) {
    throw new AttachmentPathError(
      'attachment "path" non ammesso: usa un handle binario, base64, oppure un URL http(s). ' +
        'Un percorso su filesystem è bloccato per prevenire LFI/esfiltrazione di segreti.',
    );
  }
  const safe = validateUrlForFetch(v);
  if (!safe.ok) {
    throw new AttachmentPathError(
      `attachment URL bloccato (SSRF guard): ${safe.reason ?? 'unsafe'}`,
    );
  }
  return v;
}
