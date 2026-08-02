/**
 * Lettura CAPPATA del body di una `Response` — anti-OOM condiviso.
 *
 * `safeOutboundFetch` restituisce una `Response` GREZZA (fa SSRF + redirect, non
 * limita il body). Decine di consumer leggevano poi `res.json()`/`res.text()` SENZA
 * limite: una list-API che torna decine di migliaia di record, un endpoint
 * compromesso o un URL sbagliato (fetchUrl) → buffer illimitato in RAM → OOM del
 * container tenant. Questo modulo è il primitivo unico che TUTTI i consumer devono
 * usare al posto di `res.text()/json()` diretti.
 *
 * Strategia (in ordine di robustezza):
 *  1. `content-length` dichiarato oltre il cap → stop SUBITO, zero byte letti.
 *  2. body come stream (`getReader`) → contatore byte, abort al superamento del cap.
 *  3. fallback `res.text()` + post-check (per `Response` mock/senza stream nei test).
 * Non bufferizza mai più del cap.
 */

/** Cap di default (25 MB): generoso per qualsiasi risposta API JSON legittima,
 *  protegge da payload abnormi/malevoli. I caller con esigenze diverse passano il
 *  proprio cap (es. download file → cap più alto e dedicato). */
export const DEFAULT_RESPONSE_CAP_BYTES = 25 * 1024 * 1024;

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** content-length dichiarato, o NaN se header assente/non-numerico. Difensivo: una
 *  Response vera ha sempre `headers`, ma i mock di test a volte no. */
function declaredLength(res: Response): number {
  const headers = (res as { headers?: { get?: (k: string) => string | null } }).headers;
  return Number(headers && typeof headers.get === 'function' ? headers.get('content-length') : null);
}

/**
 * Ultima rete quando la Response NON espone un body-stream leggibile (`getReader`):
 * in PRODUZIONE non capita mai (undici/fetch danno sempre uno stream → si passa di
 * sopra, col cap vero). Capita SOLO con Response-like di test: usiamo `text()` se
 * c'è, altrimenti ri-serializziamo `json()`. Il length-check del cap resta applicato
 * dal chiamante.
 */
async function fallbackBodyText(res: Response): Promise<string> {
  const r = res as unknown as { text?: () => Promise<string>; json?: () => Promise<unknown> };
  if (typeof r.text === 'function') return r.text();
  if (typeof r.json === 'function') return JSON.stringify(await r.json());
  return '';
}

/**
 * Legge il body come testo applicando un cap in byte. Lancia `RangeError` se il body
 * supera `capBytes` (prima via content-length, poi durante lo streaming).
 */
export async function readTextCapped(res: Response, capBytes: number = DEFAULT_RESPONSE_CAP_BYTES): Promise<string> {
  const declared = declaredLength(res);
  if (Number.isFinite(declared) && declared > capBytes) {
    try { await res.body?.cancel(); } catch { /* best-effort: libera l'FD */ }
    throw new RangeError(`risposta troppo grande: ${mb(declared)} MB oltre il limite di ${mb(capBytes)} MB`);
  }

  const body = res.body;
  if (body && typeof body.getReader === 'function') {
    // `getReader()` non porta con sé il tipo dei blocchi letti: senza questa
    // annotazione ogni `value` sarebbe `any`, e con lui tutto ciò che tocca.
    const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        if (total > capBytes) {
          try { await reader.cancel(); } catch { /* best-effort */ }
          throw new RangeError(`risposta troppo grande: superato il limite di ${mb(capBytes)} MB durante il download`);
        }
        chunks.push(Buffer.from(value));
      }
    }
    return Buffer.concat(chunks).toString('utf-8');
  }

  // Fallback senza body-stream (test). `.length` è approssimato (UTF-16 vs byte) ma
  // basta come ultima rete; il cap resta applicato.
  const text = await fallbackBodyText(res);
  if (text.length > capBytes) {
    throw new RangeError(`risposta troppo grande: oltre il limite di ${mb(capBytes)} MB`);
  }
  return text;
}

/**
 * Come `readTextCapped` ma fa il `JSON.parse`. Robusto su body vuoto 2xx (es.
 * SendGrid 202, molte API POST): `res.json()` lancerebbe "Unexpected end of JSON
 * input" → qui body vuoto restituisce `null` castato a `T`.
 */
export async function readJsonCapped<T>(res: Response, capBytes: number = DEFAULT_RESPONSE_CAP_BYTES): Promise<T> {
  const text = await readTextCapped(res, capBytes);
  if (!text.trim()) return null as T;
  return JSON.parse(text) as T;
}

/**
 * Legge il body come testo TRONCANDO a `maxBytes`: appena raggiunto il limite ferma
 * lo stream (nessun byte oltre viene bufferizzato) e ritorna ciò che ha. NON lancia.
 *
 * È il primitivo corretto per "mi servono solo i primi N byte" (fetchUrl/scrape per
 * l'LLM, estratti d'errore): leggere `res.text()` e poi `.slice(0, N)` bufferizza
 * PRIMA tutto il body → OOM su risposte enormi. Qui il taglio avviene durante il
 * download. `truncated` segnala se la risposta era più lunga di `maxBytes`.
 */
export async function readTextTruncated(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const body = res.body;
  if (body && typeof body.getReader === 'function') {
    // `getReader()` non porta con sé il tipo dei blocchi letti: senza questa
    // annotazione ogni `value` sarebbe `any`, e con lui tutto ciò che tocca.
    const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        if (total + value.byteLength > maxBytes) {
          // Questo chunk sforerebbe il limite → prendi solo i byte che mancano e ferma.
          const remaining = maxBytes - total;
          if (remaining > 0) chunks.push(Buffer.from(value.subarray(0, remaining)));
          truncated = true;
          try { await reader.cancel(); } catch { /* best-effort */ }
          break;
        }
        total += value.byteLength;
        chunks.push(Buffer.from(value));
      }
    }
    return { text: Buffer.concat(chunks).toString('utf-8'), truncated };
  }

  // Fallback senza stream (test): leggiamo e tronchiamo a posteriori.
  const text = await fallbackBodyText(res);
  return text.length > maxBytes
    ? { text: text.slice(0, maxBytes), truncated: true }
    : { text, truncated: false };
}

/**
 * Legge il body come BYTES (Buffer) applicando un cap, preservando i dati binari
 * (a differenza di readTextTruncated che decodifica UTF-8). Lancia `RangeError` se
 * il body supera `capBytes`. Per chi deve marshallare/servire bytes raw (es. il
 * proxy fetch del sandbox: text + base64 dello STESSO buffer).
 */
export async function readBytesCapped(res: Response, capBytes: number = DEFAULT_RESPONSE_CAP_BYTES): Promise<Buffer> {
  const declared = declaredLength(res);
  if (Number.isFinite(declared) && declared > capBytes) {
    try { await res.body?.cancel(); } catch { /* best-effort */ }
    throw new RangeError(`risposta troppo grande: ${mb(declared)} MB oltre il limite di ${mb(capBytes)} MB`);
  }

  const body = res.body;
  if (body && typeof body.getReader === 'function') {
    // `getReader()` non porta con sé il tipo dei blocchi letti: senza questa
    // annotazione ogni `value` sarebbe `any`, e con lui tutto ciò che tocca.
    const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        if (total > capBytes) {
          try { await reader.cancel(); } catch { /* best-effort */ }
          throw new RangeError(`risposta troppo grande: superato il limite di ${mb(capBytes)} MB durante il download`);
        }
        chunks.push(Buffer.from(value));
      }
    }
    return Buffer.concat(chunks);
  }

  // Fallback senza body-stream (mock di test): arrayBuffer + post-check.
  const r = res as unknown as { arrayBuffer?: () => Promise<ArrayBuffer> };
  const buf = typeof r.arrayBuffer === 'function' ? Buffer.from(await r.arrayBuffer()) : Buffer.alloc(0);
  if (buf.length > capBytes) {
    throw new RangeError(`risposta troppo grande: oltre il limite di ${mb(capBytes)} MB`);
  }
  return buf;
}
