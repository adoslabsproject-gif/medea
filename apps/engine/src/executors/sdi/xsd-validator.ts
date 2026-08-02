/**
 * Validazione XSD FatturaPA v1.2.2 — offline, via libxml2 (WASM, nessuna dep nativa).
 *
 * Valida l'XML di una fattura elettronica contro lo schema UFFICIALE dell'Agenzia
 * PRIMA dell'invio al SdI → intercetta gli errori strutturali che il SdI scarterebbe
 * (notifica di scarto), facendoli emergere subito nel workflow.
 *
 * Lo schema FatturaPA importa `xmldsig-core-schema.xsd`: lo serviamo da un
 * input-provider IN-MEMORY (gli XSD sono embeddati come stringhe → niente file su
 * disco, niente COPY nel Dockerfile, niente rete). Il validator è costruito UNA
 * volta (lazy) e riusato — parsare lo schema a ogni fattura sarebbe spreco.
 *
 * Ritorna un risultato STRUTTURATO (mai throw sul caso "fattura invalida"): il
 * chiamante decide se bloccare l'invio. Throw solo per errori di sistema (WASM).
 */

import {
  XmlDocument,
  XsdValidator,
  XmlValidateError,
  xmlRegisterInputProvider,
  type XmlInputProvider,
} from 'libxml2-wasm';
import {
  FATTURAPA_XSD_V122,
  XMLDSIG_CORE_XSD,
  XMLDSIG_SCHEMA_FILENAME,
} from './fatturapa-xsd.generated.js';

export interface XsdValidationResult {
  valid: boolean;
  /** Messaggi di errore XSD (uno per violazione), vuoto se valid. */
  errors: string[];
}

// ── Input-provider in-memory: risolve l'import `xmldsig-core-schema.xsd` ─────────
const SCHEMA_FILES = new Map<string, Uint8Array>([
  [XMLDSIG_SCHEMA_FILENAME, new TextEncoder().encode(XMLDSIG_CORE_XSD)],
]);

interface OpenFd {
  data: Uint8Array;
  pos: number;
}
const openFds = new Map<number, OpenFd>();
let nextFd = 1;
let providerRegistered = false;

function matchedKey(filename: string): string | undefined {
  for (const key of SCHEMA_FILES.keys()) {
    if (filename.endsWith(key)) return key;
  }
  return undefined;
}

const inMemoryProvider: XmlInputProvider = {
  match: (filename) => matchedKey(filename) !== undefined,
  open: (filename) => {
    const key = matchedKey(filename);
    if (key === undefined) return undefined;
    const data = SCHEMA_FILES.get(key);
    if (data === undefined) return undefined;
    const fd = nextFd;
    nextFd += 1;
    openFds.set(fd, { data, pos: 0 });
    return fd;
  },
  read: (fd, buf) => {
    const st = openFds.get(fd);
    if (st === undefined) return -1;
    const n = Math.min(buf.byteLength, st.data.byteLength - st.pos);
    buf.set(st.data.subarray(st.pos, st.pos + n));
    st.pos += n;
    return n;
  },
  close: (fd) => openFds.delete(fd),
};

// ── Validator lazy-singleton ────────────────────────────────────────────────────
// libxml2-wasm è sincrono dopo l'init del modulo (l'import risolve il WASM): il
// validator si costruisce una volta e si riusa. Cache su variabile module-level.
let cachedValidator: XsdValidator | undefined;

function getValidator(): XsdValidator {
  if (cachedValidator === undefined) {
    if (!providerRegistered) {
      xmlRegisterInputProvider(inMemoryProvider);
      providerRegistered = true;
    }
    const xsdDoc = XmlDocument.fromString(FATTURAPA_XSD_V122, {
      url: 'mem://schemas/fatturapa-v1.2.2.xsd',
    });
    cachedValidator = XsdValidator.fromDoc(xsdDoc);
  }
  return cachedValidator;
}

/**
 * Valida un XML FatturaPA contro lo schema XSD v1.2.2.
 *
 * @returns { valid, errors } — `valid:false` con la lista delle violazioni se il
 *   documento non è conforme. Non lancia per documento invalido; lancia solo su
 *   errore di sistema (parse XML malformato → restituito come invalid; WASM down → throw).
 *
 * Sincrona: libxml2-wasm si inizializza all'import del modulo e valida in-process.
 */
export function validateFatturaPaXsd(xml: string): XsdValidationResult {
  let doc: XmlDocument;
  try {
    doc = XmlDocument.fromString(xml);
  } catch (err) {
    // XML non parsabile = struttura non conforme (il SdI lo scarterebbe comunque).
    return {
      valid: false,
      errors: [`XML non valido: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  try {
    getValidator().validate(doc);
    return { valid: true, errors: [] };
  } catch (err) {
    if (err instanceof XmlValidateError) {
      const errors = err.message
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '');
      return { valid: false, errors: errors.length > 0 ? errors : [err.message] };
    }
    throw err;
  } finally {
    doc.dispose();
  }
}

/** Reset dello stato (per i test: forza la ricostruzione del validator). */
export function __resetXsdValidator(): void {
  cachedValidator = undefined;
}
