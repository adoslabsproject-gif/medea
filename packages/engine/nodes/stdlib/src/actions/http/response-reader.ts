/**
 * Lettura del body di risposta HTTP — estratto da `executor.ts` (≤250 righe,
 * dottrina no-monoliti). Comportamento INVARIATO (move puro, equivalenza provata
 * da http.test.ts + content-disposition.test.ts):
 *  - cap a N byte con protezione a 2 strati (content-length + streaming counter);
 *  - formati auto/json/text/binary (binary → handle BinaryData via store o inline);
 *  - filename da Content-Disposition (RFC 6266 + ext-value RFC 5987), sanitizzato.
 *
 * @module actions/http/response-reader
 */
import type { NodeExecutionContext } from '../../types.js';
import { ValidationError } from '../../core/node-error.js';
import type { HttpConfig } from './schema.js';

/**
 * Estrae il filename da un header Content-Disposition (RFC 6266), gestendo sia
 * `filename="x.pdf"` sia `filename*=UTF-8''x.pdf`. Ritorna undefined se assente.
 * Sanitizza via basename per evitare che un server malevolo inietti un path.
 */
export function filenameFromContentDisposition(cd: string | null): string | undefined {
  if (!cd) return undefined;
  // R7: ext-value RFC 5987 completo — `filename*=charset'lang'value` (charset/lang
  // opzionali, qualsiasi token, non solo UTF-8''). I gruppi charset(1)/lang(2) sono
  // parsati e SCARTATI; il value(3) è url-decodato (UTF-8/ASCII; charset esotici rari).
  const star = /filename\*=(?:([\w-]+)'([\w-]*)')?([^;]+)/iu.exec(cd);
  const plain = /filename="?([^";]+)"?/iu.exec(cd);
  const raw = star?.[3] ?? plain?.[1];
  if (raw === undefined) return undefined;
  let decoded = raw.trim();
  try { decoded = decodeURIComponent(decoded); } catch { /* non url-encoded → ok */ }
  // basename: niente separatori di path (no `../`, no `/etc/...`).
  const base = decoded.split(/[/\\]/u).pop() ?? decoded;
  return base.length > 0 ? base.slice(0, 255) : undefined;
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Legge il body con un CAP di byte (fix 2026-06-17: prima `arrayBuffer()`/`text()`
 * leggevano qualsiasi dimensione in RAM → OOM/DoS del container su risposte enormi,
 * promessa "max 50 MB" mai enforced). Protezione a due strati:
 *  1) content-length dichiarato oltre il cap → stop SUBITO (nessun byte letto);
 *  2) lettura in STREAMING con contatore (il content-length può mancare o mentire):
 *     supera il cap → cancella lo stream e lancia, senza mai bufferizzare tutto.
 * Fallback per Response senza stream (mock/test): legge per formato + post-check.
 */
export async function readBodyWithCap(res: Response, capBytes: number, prefer: 'binary' | 'text'): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > capBytes) {
    try { await res.body?.cancel(); } catch { /* best-effort */ }
    throw new ValidationError(`Risposta troppo grande: ${formatMb(declared)} dichiarati, oltre il limite di ${formatMb(capBytes)}. Aumenta "Max risposta (MB)" o restringi la richiesta.`);
  }
  const body = res.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > 0) {
        total += value.byteLength;
        if (total > capBytes) {
          try { await reader.cancel(); } catch { /* best-effort */ }
          throw new ValidationError(`Risposta troppo grande: superato il limite di ${formatMb(capBytes)} durante il download. Aumenta "Max risposta (MB)" o restringi la richiesta.`);
        }
        chunks.push(Buffer.from(value));
      }
    }
    return Buffer.concat(chunks);
  }
  // Response senza stream leggibile (mock/test): leggi per formato + post-check size.
  const buf = prefer === 'binary'
    ? Buffer.from(await res.arrayBuffer())
    : Buffer.from(await res.text(), 'utf-8');
  if (buf.byteLength > capBytes) {
    throw new ValidationError(`Risposta troppo grande: ${formatMb(buf.byteLength)}, oltre il limite di ${formatMb(capBytes)}.`);
  }
  return buf;
}

/**
 * Legge la risposta nel formato richiesto (auto / json / text / binary).
 * auto sniffa il Content-Type; json forza parse-or-text; binary emette un handle
 * BinaryData (via store, o inline base64 fail-soft senza store).
 */
export async function readResponse(
  res: Response,
  format: HttpConfig['responseFormat'],
  writeBinary: NodeExecutionContext['writeBinary'] | undefined,
  capBytes: number,
): Promise<unknown> {
  const contentType = res.headers.get('content-type') ?? '';
  if (format === 'binary' || (format === 'auto' && contentType.startsWith('application/octet-stream'))) {
    const buf = await readBodyWithCap(res, capBytes, 'binary');
    const fileName = filenameFromContentDisposition(res.headers.get('content-disposition'));
    const mimeType = contentType.split(';')[0]?.trim() || 'application/octet-stream';
    if (writeBinary) {
      return await writeBinary(buf, { mimeType, ...(fileName !== undefined ? { fileName } : {}) });
    }
    const { makeBinaryInline } = await import('@flowforge/core-schema');
    return makeBinaryInline({ mimeType, data: buf.toString('base64'), ...(fileName !== undefined ? { fileName } : {}) });
  }
  const text = (await readBodyWithCap(res, capBytes, 'text')).toString('utf-8');
  if (format === 'json' || (format === 'auto' && contentType.includes('application/json') && text)) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return text;
}
