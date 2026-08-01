/**
 * Guard PURA sulla dimensione di un input già risolto in memoria (file, base64,
 * BinaryData). Anti-OOM uniforme: i parser (pdf_parse, xlsx_parse) cappavano la
 * dimensione SOLO sul file da disco (stat), non sul base64/binary da upstream (es.
 * allegato IMAP enorme) → il parser amplificava in RAM → OOM (fix 2026-06-17).
 *
 * PURE → testabile a costo zero (solo numeri, niente buffer da allocare).
 */

/** Lancia se `byteLength` supera `maxBytes`. `label` apre il messaggio (es. "PDF"). */
export function assertInputSizeWithinCap(byteLength: number, maxBytes: number, label: string): void {
  if (byteLength > maxBytes) {
    const mb = (maxBytes / (1024 * 1024)).toString();
    throw new Error(`${label} troppo grande (${byteLength.toString()} bytes). Max ${mb} MB.`);
  }
}
