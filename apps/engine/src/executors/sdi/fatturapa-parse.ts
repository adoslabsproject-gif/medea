/**
 * Parser FatturaPA XML → JSON strutturato e tipizzato — il pezzo mancante del
 * flusso INBOUND: le fatture arrivano (via PEC/SdI, spesso dentro un `.p7m`,
 * vedi p7m-extract.ts) come XML FatturaPA; per automatizzare contabilità,
 * scadenzario e analisi AI serve la versione strutturata DETERMINISTICA, non
 * un LLM che rilegge l'XML ogni volta.
 *
 * Parsing con libxml2 (WASM, già in uso per la validazione XSD) e XPath
 * namespace-agnostic (`local-name()`): FPR12, FPA12 e namespace privati dei
 * gestionali vengono letti allo stesso modo. Una fattura può contenere N
 * FatturaElettronicaBody (lotto): l'output è SEMPRE un array `fatture`.
 *
 * @module executors/sdi/fatturapa-parse
 */

import { XmlDocument, type XmlNode } from 'libxml2-wasm';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { validateFatturaPaXsd } from './xsd-validator.js';

function text(el: XmlNode | null, path: string): string | null {
  const found = el?.get(xp(path));
  const content = found?.content.trim();
  return content !== undefined && content !== '' ? content : null;
}

function num(el: XmlNode | null, path: string): number | null {
  const t = text(el, path);
  if (t === null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Path "A/B/C" → XPath namespace-agnostic con local-name(). */
function xp(path: string): string {
  return path
    .split('/')
    .map((seg) => `*[local-name()="${seg}"]`)
    .join('/');
}

export interface FatturaPaAnagrafica {
  denominazione: string | null;
  partitaIva: string | null;
  codiceFiscale: string | null;
}

export interface FatturaPaRiga {
  numeroLinea: number | null;
  descrizione: string | null;
  quantita: number | null;
  prezzoUnitario: number | null;
  prezzoTotale: number | null;
  aliquotaIva: number | null;
}

export interface FatturaPaScadenza {
  modalitaPagamento: string | null;
  dataScadenza: string | null;
  importo: number | null;
}

export interface FatturaPaParsed {
  formato: string | null;
  progressivoInvio: string | null;
  codiceDestinatario: string | null;
  cedente: FatturaPaAnagrafica;
  cessionario: FatturaPaAnagrafica;
  tipoDocumento: string | null;
  divisa: string | null;
  data: string | null;
  numero: string | null;
  importoTotaleDocumento: number | null;
  righe: FatturaPaRiga[];
  riepilogoIva: { aliquota: number | null; imponibile: number | null; imposta: number | null }[];
  scadenze: FatturaPaScadenza[];
  numeroAllegati: number;
}

function parseAnagrafica(
  root: XmlNode,
  who: 'CedentePrestatore' | 'CessionarioCommittente',
): FatturaPaAnagrafica {
  const base = root.get(xp(`FatturaElettronicaHeader/${who}/DatiAnagrafici`));
  const denominazione =
    text(base, 'Anagrafica/Denominazione') ??
    (() => {
      // Ditte individuali: Nome + Cognome al posto della Denominazione.
      const nome = text(base, 'Anagrafica/Nome');
      const cognome = text(base, 'Anagrafica/Cognome');
      return nome !== null || cognome !== null ? [nome, cognome].filter(Boolean).join(' ') : null;
    })();
  const idPaese = text(base, 'IdFiscaleIVA/IdPaese') ?? '';
  const idCodice = text(base, 'IdFiscaleIVA/IdCodice');
  return {
    denominazione,
    partitaIva: idCodice !== null ? `${idPaese}${idCodice}` : null,
    codiceFiscale: text(base, 'CodiceFiscale'),
  };
}

/**
 * Parsa un XML FatturaPA. @throws Error con messaggio actionable se l'XML non
 * è parsabile o non contiene una FatturaElettronica.
 */
export function parseFatturaPa(xml: string): FatturaPaParsed[] {
  let doc: XmlDocument;
  try {
    doc = XmlDocument.fromString(xml);
  } catch (e) {
    throw new Error(`XML non parsabile: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const root = doc.root;
    if (!root.name.endsWith('FatturaElettronica')) {
      throw new Error(`radice <${root.name}>: non è una FatturaElettronica`);
    }
    const formato =
      root.attrs.find((a) => a.name === 'versione')?.value ??
      text(root, 'FatturaElettronicaHeader/DatiTrasmissione/FormatoTrasmissione');
    const bodies = root.find(`${xp('FatturaElettronicaBody')}`);
    if (bodies.length === 0) throw new Error('nessun FatturaElettronicaBody presente');
    const cedente = parseAnagrafica(root, 'CedentePrestatore');
    const cessionario = parseAnagrafica(root, 'CessionarioCommittente');
    const progressivoInvio = text(
      root,
      'FatturaElettronicaHeader/DatiTrasmissione/ProgressivoInvio',
    );
    const codiceDestinatario = text(
      root,
      'FatturaElettronicaHeader/DatiTrasmissione/CodiceDestinatario',
    );

    return bodies.map((b) => {
      const righe = b.find(xp('DatiBeniServizi/DettaglioLinee')).map((line) => {
        return {
          numeroLinea: num(line, 'NumeroLinea'),
          descrizione: text(line, 'Descrizione'),
          quantita: num(line, 'Quantita'),
          prezzoUnitario: num(line, 'PrezzoUnitario'),
          prezzoTotale: num(line, 'PrezzoTotale'),
          aliquotaIva: num(line, 'AliquotaIVA'),
        };
      });
      const riepilogoIva = b.find(xp('DatiBeniServizi/DatiRiepilogo')).map((ri) => ({
        aliquota: num(ri, 'AliquotaIVA'),
        imponibile: num(ri, 'ImponibileImporto'),
        imposta: num(ri, 'Imposta'),
      }));
      const scadenze = b.find(xp('DatiPagamento/DettaglioPagamento')).map((sc) => ({
        modalitaPagamento: text(sc, 'ModalitaPagamento'),
        dataScadenza: text(sc, 'DataScadenzaPagamento'),
        importo: num(sc, 'ImportoPagamento'),
      }));
      return {
        formato: formato ?? null,
        progressivoInvio,
        codiceDestinatario,
        cedente,
        cessionario,
        tipoDocumento: text(b, 'DatiGenerali/DatiGeneraliDocumento/TipoDocumento'),
        divisa: text(b, 'DatiGenerali/DatiGeneraliDocumento/Divisa'),
        data: text(b, 'DatiGenerali/DatiGeneraliDocumento/Data'),
        numero: text(b, 'DatiGenerali/DatiGeneraliDocumento/Numero'),
        importoTotaleDocumento: num(b, 'DatiGenerali/DatiGeneraliDocumento/ImportoTotaleDocumento'),
        righe,
        riepilogoIva,
        scadenze,
        numeroAllegati: b.find(xp('Allegati')).length,
      };
    });
  } finally {
    doc.dispose();
  }
}

/**
 * Executor `italia_fatturapa_parse`.
 * Config/input: xml (string, con {{espressioni}}) — accetta anche input.content
 * (chain diretta da italia_p7m_extract). validateXsd opzionale (schema ufficiale
 * v1.2.2, riusa il validator dell'invio).
 * Output: { fatture: FatturaPaParsed[], count, xsd?: {valid, errors} }
 */
export const fatturapaParseExecutor: NodeExecutor = (config, input) => {
  const start = Date.now();
  const xml =
    typeof config.xml === 'string' && config.xml !== ''
      ? config.xml
      : input &&
          typeof input === 'object' &&
          typeof (input as Record<string, unknown>).content === 'string'
        ? ((input as Record<string, unknown>).content as string)
        : '';
  if (xml === '')
    return Promise.reject(
      new Error(
        'italia_fatturapa_parse: nessun XML — passa la fattura nel campo "xml" o concatena italia_p7m_extract',
      ),
    );

  let xsd: { valid: boolean; errors: string[] } | undefined;
  if (config.validateXsd === 'true') {
    xsd = validateFatturaPaXsd(xml);
  }
  let fatture: FatturaPaParsed[];
  try {
    fatture = parseFatturaPa(xml);
  } catch (e) {
    return Promise.reject(
      new Error(`italia_fatturapa_parse: ${e instanceof Error ? e.message : String(e)}`),
    );
  }
  return Promise.resolve({
    output: { fatture, count: fatture.length, ...(xsd !== undefined ? { xsd } : {}) },
    durationMs: Date.now() - start,
  });
};
