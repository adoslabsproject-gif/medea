/**
 * BinaryData — rappresentazione CANONICA di un file binario che fluisce tra i
 * nodi (gap "Binary data streaming"). Prima i binari erano gestiti ad-hoc
 * (stringhe base64 sparse, config `attachments`); questo tipo formale li rende
 * riconoscibili e processabili in modo uniforme da engine, nodi e SDK.
 *
 * Due modalità di trasporto:
 *   • encoding='base64' → il contenuto è inline nel campo `data` (file piccoli).
 *   • encoding='ref'    → il contenuto è su disco/storage, `ref` è l'handle
 *     (streaming-to-disk, file grandi: il webhook accetta upload fino a 50MB
 *     senza tenerli in memoria). Il consumatore risolve il ref via runtime.
 *
 * Il discriminator `__ffBinary: true` permette a `isBinaryData` di distinguere
 * un BinaryData da un qualunque oggetto, ovunque appaia nell'output di un nodo.
 */
import { z } from 'zod';

export const BinaryDataSchema = z.object({
  /** Brand discriminator — sempre true, identifica un BinaryData. */
  __ffBinary: z.literal(true),
  /** MIME type (es. 'application/pdf', 'image/png'). */
  mimeType: z.string().min(1),
  /** Dimensione in byte. */
  size: z.number().int().nonnegative(),
  /** Nome file originale, se noto. */
  fileName: z.string().optional(),
  /** Modalità di trasporto del contenuto. */
  encoding: z.enum(['base64', 'ref']),
  /** Contenuto base64 (quando encoding='base64'). */
  data: z.string().optional(),
  /** Handle/percorso allo storage (quando encoding='ref'). */
  ref: z.string().optional(),
  /** Hash di integrità opzionale. */
  sha256: z.string().optional(),
});

export type BinaryData = z.infer<typeof BinaryDataSchema>;

/** Type guard: true se `v` è un BinaryData ben formato. */
export function isBinaryData(v: unknown): v is BinaryData {
  return (
    v !== null &&
    typeof v === 'object' &&
    (v as { __ffBinary?: unknown }).__ffBinary === true &&
    typeof (v as { mimeType?: unknown }).mimeType === 'string' &&
    typeof (v as { size?: unknown }).size === 'number'
  );
}

interface MakeBinaryInlineOpts {
  mimeType: string;
  data: string;
  fileName?: string;
  sha256?: string;
}
interface MakeBinaryRefOpts {
  mimeType: string;
  ref: string;
  size: number;
  fileName?: string;
  sha256?: string;
}

/** Costruisce un BinaryData inline (base64). `size` derivato dai byte decodificati. */
export function makeBinaryInline(opts: MakeBinaryInlineOpts): BinaryData {
  const size = Buffer.byteLength(opts.data, 'base64');
  return {
    __ffBinary: true,
    encoding: 'base64',
    mimeType: opts.mimeType,
    data: opts.data,
    size,
    ...(opts.fileName !== undefined ? { fileName: opts.fileName } : {}),
    ...(opts.sha256 !== undefined ? { sha256: opts.sha256 } : {}),
  };
}

/** Costruisce un BinaryData per riferimento (streaming-to-disk). */
export function makeBinaryRef(opts: MakeBinaryRefOpts): BinaryData {
  return {
    __ffBinary: true,
    encoding: 'ref',
    mimeType: opts.mimeType,
    ref: opts.ref,
    size: opts.size,
    ...(opts.fileName !== undefined ? { fileName: opts.fileName } : {}),
    ...(opts.sha256 !== undefined ? { sha256: opts.sha256 } : {}),
  };
}

/**
 * Estrae un BinaryData dall'output di un nodo. Se `key` è dato cerca quel campo;
 * altrimenti ritorna l'output stesso se è binario, o il PRIMO campo binario
 * trovato. `null` se non c'è nulla di binario → il chiamante decide il fallback.
 */
export function getBinaryData(output: unknown, key?: string): BinaryData | null {
  if (key !== undefined) {
    if (output !== null && typeof output === 'object') {
      const v = (output as Record<string, unknown>)[key];
      return isBinaryData(v) ? v : null;
    }
    return null;
  }
  if (isBinaryData(output)) return output;
  if (output !== null && typeof output === 'object') {
    for (const v of Object.values(output as Record<string, unknown>)) {
      if (isBinaryData(v)) return v;
    }
  }
  return null;
}

/** Legge un `ref` (handle storage) restituendo i byte. Iniettato dal runtime. */
export type BinaryRefReader = (ref: string) => Buffer | Promise<Buffer>;

/**
 * Risolve i byte di un BinaryData indipendentemente dalla modalità di trasporto:
 *   • encoding='base64' → decodifica inline `data` (nessun reader necessario).
 *   • encoding='ref'    → delega al `refReader` (il runtime legge dal disk/storage
 *     dove il webhook ha fatto streaming-to-disk). Senza reader → errore esplicito.
 *
 * È il "runtime resolver del ref": il community-node author chiama
 * getBinaryData(input) per trovare il binario e readBinaryBytes(b, ctx.readBinary)
 * per ottenerne i byte, senza sapere SE è inline o su disco.
 */
export async function readBinaryBytes(b: BinaryData, refReader?: BinaryRefReader): Promise<Buffer> {
  if (b.encoding === 'base64') {
    return Buffer.from(b.data ?? '', 'base64');
  }
  // encoding === 'ref'
  if (!b.ref) throw new Error('BinaryData encoding=ref senza campo "ref"');
  if (!refReader)
    throw new Error('readBinaryBytes: refReader richiesto per BinaryData encoding=ref');
  return await refReader(b.ref);
}

/**
 * Resolver UNIVERSALE lato CONSUMATORE (capstone ref-primario).
 *
 * Dato un valore che PUÒ essere un BinaryData (handle ref/inline) — o un oggetto
 * che ne contiene uno (es. `{ binary: ... }`, un attachment, l'output di un nodo)
 * — ritorna i BYTE risolti. `null` se non c'è nulla di binario → il chiamante
 * gestisce la sua forma legacy (base64 string / testo).
 *
 * È il pezzo che rende il `ref` TRASPARENTE: ovunque un nodo si aspetti i byte di
 * un file, chiama questo e NON sa (né gli importa) SE i byte erano un ref
 * content-addressed su disco o un base64 inline. Così il `ref` può diventare la
 * forma PRIMARIA senza che i consumatori cambino logica.
 */
export async function resolveBinaryValue(
  value: unknown,
  refReader?: BinaryRefReader,
): Promise<Buffer | null> {
  const bin = getBinaryData(value);
  return bin !== null ? await readBinaryBytes(bin, refReader) : null;
}
