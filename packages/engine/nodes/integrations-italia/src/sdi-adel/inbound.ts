/**
 * Nodi INBOUND del ciclo fattura elettronica — i gemelli di ricezione di
 * sdi-adel/index.ts (che copre l'invio): estrazione dalla busta firmata
 * `.p7m` e parsing FatturaPA → JSON strutturato.
 *
 * Executor server-side in apps/engine/src/executors/sdi/
 * (p7m-extract.ts, fatturapa-parse.ts) — registrati nel registry runtime.
 */
import type { NodeModule } from '@medea/engine-nodes-stdlib';

export const p7mExtract: NodeModule = {
  def: {
    id: 'italia_p7m_extract',
    type: 'action',
    label: 'P7M: Estrai contenuto',
    icon: 'file-key',
    color: '#0ea5e9',
    description:
      'Estrattore del contenuto dalla busta firmata CAdES `.p7m` (PKCS#7/CMS SignedData) — il formato con cui le '
      + 'fatture elettroniche firmate viaggiano da e verso il Sistema di Interscambio e arrivano via PEC come '
      + 'allegato `IT..._xxxxx.xml.p7m`. Senza questo passaggio l\'XML della fattura resta illeggibile per i nodi '
      + 'a valle (parser, database, AI). Parser ASN.1 DER minimale e difensivo, zero dipendenze esterne: nessuna '
      + 'libreria crypto di terze parti nella supply-chain. Accetta il p7m in base64 (come esce dagli allegati dei '
      + 'nodi PEC/IMAP), riconosce e decodifica anche i p7m ri-codificati base64 dai gestori di posta, e se il '
      + 'contenuto è GIÀ un XML in chiaro (fattura B2B non firmata, perfettamente legale) lo passa oltre '
      + 'dichiarando wasSigned:false. NON verifica la firma: la verifica di validità legale è compito del sistema '
      + 'di conservazione — qui serve LEGGERE il contenuto per automatizzarlo. Errori actionable e specifici '
      + '(firma detached, busta non-SignedData, DER troncato) invece di crash generici.\n\n'
      + 'Output: { content (testo estratto), wasSigned, sizeBytes, contentIsXml }.\n\n'
      + 'Use case: (1) ciclo passivo automatizzato — trigger PEC/IMAP sulla casella → estrai dal p7m → '
      + 'italia_fatturapa_parse → scadenzario nel DB; (2) far LEGGERE la fattura a un nodo AI (riassunto, controllo '
      + 'anomalie prezzi) partendo dalla busta firmata; (3) archiviazione: salvi sia il p7m originale sia l\'XML '
      + 'estratto ricercabile.',
    configFields: [
      {
        key: 'content',
        label: 'Contenuto p7m (base64) o XML',
        type: 'expression',
        required: false,
        placeholder: '{{ $node.pec_in.json.attachments.0.contentBase64 }}',
        help:
          'Il p7m in base64 (tipicamente l\'allegato del nodo PEC/IMAP a monte). Vuoto = usa '
          + 'input.content del nodo precedente. XML in chiaro → pass-through con wasSigned:false.',
      },
    ],
    outputs: ['content', 'wasSigned', 'sizeBytes', 'contentIsXml'],
    outputContract: {
      fields: [
        { name: 'content', type: 'string', desc: 'Il payload estratto dalla busta (per le fatture: l\'XML FatturaPA), decodificato utf-8' },
        { name: 'wasSigned', type: 'boolean', desc: 'true se il contenuto proveniva da una busta CAdES; false se l\'input era già XML in chiaro (pass-through)' },
        { name: 'sizeBytes', type: 'number', desc: 'Dimensione in byte del payload estratto' },
        { name: 'contentIsXml', type: 'boolean', desc: 'true se il payload estratto inizia con markup XML' },
      ],
      notes: 'La firma NON viene verificata (serve per LEGGERE, non per certificare). Firma detached (eContent assente) → errore esplicito: il contenuto viaggia in un file separato.',
    },
    searchAliases: ['p7m', 'cades', 'pkcs7', 'firma', 'busta', 'fattura', 'sdi', 'estrai'],
    vendor: 'flowforge-italia',
    version: '1.0.0',
  },
};

export const fatturapaParse: NodeModule = {
  def: {
    id: 'italia_fatturapa_parse',
    type: 'action',
    label: 'FatturaPA: Parse XML → JSON',
    icon: 'receipt',
    color: '#16a34a',
    description:
      'Parser deterministico di fatture elettroniche FatturaPA (FPR12 e FPA12) da XML a JSON tipizzato — il pezzo '
      + 'che trasforma il ciclo passivo in dati lavorabili: cedente e cessionario (denominazione, Partita IVA, '
      + 'Codice Fiscale, con supporto Nome+Cognome delle ditte individuali), tipo documento, numero, data, valuta, '
      + 'importo totale, TUTTE le righe (descrizione, quantità, prezzi, aliquota), riepiloghi IVA per aliquota e '
      + 'scadenze di pagamento con importi. Parsing con libxml2 (lo stesso motore della validazione XSD del nodo '
      + 'di invio) e XPath namespace-agnostic: gli XML dei diversi gestionali vengono letti allo stesso modo. Una '
      + 'fattura-lotto con N corpi produce N elementi nell\'array. Validazione XSD opzionale contro lo schema '
      + 'UFFICIALE v1.2.2 dell\'Agenzia delle Entrate (offline). Deterministico per design: a differenza di un '
      + 'LLM che rilegge l\'XML, gli importi estratti sono ESATTI e sempre uguali — l\'AI a valle riceve il JSON '
      + 'pulito e non può sbagliare un totale.\n\n'
      + 'Output: { fatture: [{cedente, cessionario, numero, data, importoTotaleDocumento, righe[], riepilogoIva[], '
      + 'scadenze[]}], count, xsd? }.\n\n'
      + 'Use case: (1) scadenzario automatico — PEC in ingresso → p7m extract → parse → db_insert delle scadenze '
      + 'con alert Telegram 5 giorni prima; (2) controllo fornitori con AI — Liara confronta i prezzi di riga con '
      + 'lo storico e segnala rincari; (3) registrazione contabile assistita verso il gestionale (Odoo/Fatture in '
      + 'Cloud) coi dati già strutturati; (4) report IVA mensile aggregando i riepiloghi per aliquota.',
    configFields: [
      {
        key: 'xml',
        label: 'XML FatturaPA',
        type: 'expression',
        required: false,
        placeholder: '{{ $node.p7m.json.content }}',
        help:
          'L\'XML della fattura. Vuoto = usa input.content del nodo precedente '
          + '(concatenazione diretta da "P7M: Estrai contenuto").',
      },
      {
        key: 'validateXsd',
        label: 'Valida contro XSD ufficiale v1.2.2',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help:
          'Se on: valida l\'XML contro lo schema ufficiale FatturaPA v1.2.2 (offline) e '
          + 'riporta le violazioni nel campo output "xsd" senza bloccare il parse.',
      },
    ],
    outputs: ['fatture', 'count', 'xsd'],
    outputContract: {
      fields: [
        { name: 'fatture', type: 'FatturaPaParsed[]', desc: 'Un elemento per FatturaElettronicaBody: {formato, progressivoInvio, codiceDestinatario, cedente{denominazione,partitaIva,codiceFiscale}, cessionario{...}, tipoDocumento, divisa, data, numero, importoTotaleDocumento, righe[], riepilogoIva[], scadenze[], numeroAllegati}' },
        { name: 'count', type: 'number', desc: 'Numero di corpi fattura nel lotto (di norma 1)' },
        { name: 'xsd', type: '{ valid, errors } | assente', desc: 'Presente solo con validateXsd on: esito della validazione contro lo schema ufficiale (errors = violazioni puntuali)' },
      ],
      notes: 'Campi assenti nell\'XML → null (mai stringhe vuote inventate). XML non parsabile o radice diversa da FatturaElettronica → errore actionable, non output vuoto.',
    },
    searchAliases: ['fattura', 'fatturapa', 'sdi', 'xml', 'parse', 'ciclo', 'passivo', 'scadenze', 'iva'],
    vendor: 'flowforge-italia',
    version: '1.0.0',
  },
};
