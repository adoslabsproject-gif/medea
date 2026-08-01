/**
 * Utility PROVIDER-AGNOSTIC per la vision: rilevamento MIME immagine, normalizzazione
 * data-URL ed estrazione testo da PDF.
 *
 * NB lettura PDF: estraiamo il TESTO con unpdf (`extractText`) e lo passiamo al
 * modello. Il render pagina→immagine (per dare il PDF "a vista" a Qwen3-VL) NON è
 * usabile: pdfjs apre un worker che sotto bundle tsup (= produzione) non riesce a
 * trasferire il canvas @napi-rs (`DataCloneError`). `extractText` invece usa lo
 * stesso pdfjs SENZA il canvas-worker e funziona nel bundle (provato). I PDF
 * scansionati (senza layer testo) restano fuori portata finché non c'è un renderer
 * senza-worker.
 */

export interface VisionImage {
  /** base64 PURO (senza prefisso `data:`). */
  base64: string;
  /** es. 'image/png', 'image/jpeg'. */
  mimeType: string;
}

/** Riconosce il MIME immagine dai magic bytes del base64 (default jpeg). Evita di
 *  mandare un `data:` con mime sbagliato che alcuni provider rifiutano. */
export function detectImageMime(base64: string): string {
  const head = base64.slice(0, 16);
  if (head.startsWith('iVBORw0KGgo')) return 'image/png';
  if (head.startsWith('/9j/')) return 'image/jpeg';
  if (head.startsWith('R0lGOD')) return 'image/gif';
  if (head.startsWith('UklGR')) return 'image/webp';
  return 'image/jpeg';
}

/** Strip di un eventuale prefisso `data:<mime>;base64,` lasciando il base64 puro. */
export function stripDataUrl(input: string): { base64: string; mimeType?: string } {
  const m = /^data:([^;]+);base64,(.*)$/su.exec(input);
  if (m) {
    const mimeType = m[1];
    const base64 = m[2] ?? '';
    return mimeType ? { base64, mimeType } : { base64 };
  }
  return { base64: input };
}

/** Normalizza un input immagine (base64 puro o data-URL) in `VisionImage` col MIME
 *  corretto (preso dal data-URL se presente, altrimenti dedotto dai magic bytes). */
export function toVisionImage(input: string): VisionImage {
  const { base64, mimeType } = stripDataUrl(input);
  return { base64, mimeType: mimeType ?? detectImageMime(base64) };
}

export interface PdfTextResult {
  /** Testo estratto (tutte le pagine concatenate). */
  text: string;
  /** Numero totale di pagine del documento. */
  totalPages: number;
}

/**
 * Estrae il testo di un PDF con unpdf (pdfjs, ramo testo — funziona nel bundle).
 * `verbosity:0` silenzia i warning pdfjs su stderr.
 */
export async function extractPdfText(pdfBytes: Uint8Array): Promise<PdfTextResult> {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(pdfBytes, { verbosity: 0 });
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { text, totalPages };
}
