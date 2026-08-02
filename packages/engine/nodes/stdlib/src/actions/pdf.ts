import type { NodeModule } from '../types.js';

/**
 * action_pdf_parse — estrae testo da PDF con pipeline a confidenza:
 *   1) pdf-parse (gratis, veloce, funziona sui PDF nativi)
 *   2) Se confidenza bassa → fallback Claude Sonnet vision (a pagamento,
 *      gestisce scan, OCR malfatti, PDF protetti)
 *
 * Nodo critico per il workflow ordini: l'utente carica un PDF ordine →
 * questo nodo estrae testo → Agent Extractor lo trasforma in JSON strutturato.
 *
 * NOMI CAMPI: devono matchare ESATTAMENTE i `config.X` letti
 * dall'executor `pdfParseExecutor` in `apps/runtime/src/executors/pdf.ts`.
 */
export const pdfParseNode: NodeModule = {
  def: {
    id: 'action_pdf_parse',
    type: 'action',
    label: 'PDF: Parse (text extraction)',
    icon: 'file-text',
    color: '#ef4444',
    description:
      'Estrazione testo da PDF con cascata 2-stage qualità-prima: pdf-parse libreria gratuita (~50ms, zero cost, no API) come tentativo veloce → fallback automatico a Claude Sonnet vision (cost ~$0.003-0.015/PDF, latency 2-5s) quando pdf-parse ritorna testo scarno o gibberish da PDF scannerizzato. La heuristica fallback usa confidence score basato su densità caratteri leggibili + presenza glifi standard latini.\n\n' +
      'Differenza con i sibling: action_pdf_parse = text extraction OUT (PDF → string). Per generare PDF IN partendo da titolo+sezioni+tabella vedi action_pdf_generate (pdfkit, fatture/cataloghi). Per immagini generiche con AI vedi action_vision_extract (Qwen2.5-VL-7B locale, no Claude cost).\n\n' +
      'Modalità configurabili: auto (default — cascata pdf-parse → Claude se low confidence), pdf-parse-only (zero cost, accetta fallimenti su scan), llm-only (massima qualità, sempre Claude — usare quando sai a priori che i PDF sono scan). La modalità auto e\\` consigliata: il 70-80% dei PDF moderni hanno text layer estraibile gratis, il fallback Claude paga solo per i casi reali (vecchi scan, ricevute fotografate).\n\n' +
      'Input flessibile: file da disco (path nel sandbox tenant, file-picker UI) OPPURE base64 da nodo upstream (tipico: allegato trigger_imap senza salvare su disco). Max 32 MB hard cap per evitare OOM, 100 pagine cap su modalità Claude per cost control.\n\n' +
      'Use case: (1) ingest fatture PEC ricevute via trigger_imap → estrarre IBAN + importo + scadenza per inserimento contabile automatico, (2) parsing contratti firmati per archiviazione searchable con full-text index, (3) categorizzazione spese da ricevute scannerizzate (Claude vision riconosce anche grafica/logo), (4) corpus PDF per pipeline RAG con embedding BGE-M3.\n\n' +
      'Safety budget: SSRF non applicabile (nessun fetch outbound), file I/O sandboxato su tenant data dir, cost cap configurabile per workflow (max N call Claude/run), audit log con sha256 input + mode used + tokens consumed.',
    configFields: [
      {
        key: 'path',
        label: 'File PDF su disco (opzionale)',
        type: 'file-picker',
        required: false,
        placeholder: 'es. ordine.pdf o {{input.attachment.path}}',
        help: 'Path nel sandbox del tenant. Se vuoto, l\'engine cerca i bytes in "Base64" qui sotto. Uno dei due è obbligatorio.',
      },
      {
        key: 'base64',
        label: 'Base64 dei bytes PDF (opzionale)',
        type: 'expression',
        required: false,
        placeholder: '{{$node.ImapTrigger.json.attachments[0].base64}}',
        help: 'Stringa base64 del PDF (es. allegato email). Massimo 32 MB. Si usa quando il PDF arriva via webhook/email senza essere salvato su disco.',
      },
      {
        key: 'mode',
        label: 'Strategia estrazione',
        type: 'select',
        required: false,
        options: ['auto', 'pdf-parse-only', 'llm-only'],
        defaultValue: 'auto',
        help: 'auto = prova pdf-parse, fa fallback LLM-vision se la qualità è bassa (raccomandato). pdf-parse-only = solo libreria gratis, niente API LLM (costo zero, ma fallisce su PDF scannerizzati). llm-only = salta pdf-parse e va diretto su Claude Sonnet (massima qualità, max costo per call).',
      },
    ],
    outputs: ['text', 'confidence', 'mode', 'pages', 'sizeBytes', 'usedLlmFallback', 'llmModel', 'cheapAttempt'],
    vendor: 'flowforge',
    version: '1.0.0',
    cost: {
      // pdf-parse: zero. LLM-vision: ~$0.003-0.015 per PDF tipico (Sonnet).
      // Estimator UI userà questo per "stima costo workflow di 1000 PDF".
      costPerCall: 0.005,
      typicalLatencyMs: 2000, // pdf-parse <100ms, LLM ~2-5s
    },
  },
};

/**
 * action_pdf_generate — genera un PDF da titolo + sezioni + tabella.
 *
 * Use case primario: cataloghi prodotti, fatture, DDT, ricevute, report PDF
 * stampabile da inviare via email (collegabile a `action_send_email`
 * `attachmentsJson`). Niente template Word/InDesign — layout flessibile via
 * input strutturato (sections + table).
 *
 * Implementazione: pdfkit (gia\` dep del portal per fatture PayPal). Lazy import
 * nell'executor server-only — il bundle browser dell'editor NON include
 * pdfkit (~1.5MB) perche\` il NodeDef qui e\` solo metadata UI.
 *
 * Output:
 *   - `filename` (string): nome file proposto (default "document.pdf")
 *   - `base64` (string): contenuto PDF in base64 (usabile direttamente come
 *     `attachmentsJson` in `action_send_email`: `[{filename, content: base64, encoding: 'base64'}]`)
 *   - `sizeBytes` (number): dimensione binaria
 *   - `pageCount` (number): n pagine generate
 *
 * NOMI CAMPI: devono matchare ESATTAMENTE i `config.X` letti dall'executor
 * `pdfGenerateExecutor` in `apps/engine/src/executors/pdf.ts`.
 */
export const pdfGenerateNode: NodeModule = {
  def: {
    id: 'action_pdf_generate',
    type: 'action',
    label: 'PDF: Genera documento',
    icon: 'file-plus',
    color: '#ef4444',
    description:
      'Generatore enterprise di documenti PDF stampabili partendo da componenti structured (titolo, sezioni ' +
      'testuali multi-paragrafo, tabella dati opzionale, intestazione/piè di pagina branded, immagini logo) — ' +
      'la primitiva di tutti i workflow che producono output cartaceo/print-ready destinati a clienti, partner, ' +
      'team interno, archivio compliance. Built su libreria pdfkit Node.js (battle-tested 12M+ downloads/anno, ' +
      'genera PDF 1.7 valid e compatibile con qualsiasi reader: Adobe Acrobat, Preview macOS, Foxit, browser ' +
      'embedded viewer, mobile reader). ' +
      'Componenti del documento configurabili dall\'editor visuale: titolo principale (heading 24pt, ' +
      'centrato di default, customizable font + size + color), sezioni testuali multi-paragrafo con ' +
      'support a markdown subset (bold, italic, underline, link cliccabili), tabella optional con colonne ' +
      'configurate da header array + righe da array di array (column auto-width oppure fixed width esplicito ' +
      'per controllo layout, alternating row color zebra-stripe per readability, header bold + colored background ' +
      'per separation visiva), intestazione/piè di pagina ricorrente con logo aziendale (caricato come ' +
      'base64 da action_file_read upstream), paginazione automatica con conteggio "Pagina X di Y", marche di ' +
      'separazione tra sezioni. ' +
      'Layout pulito di default Helvetica (cross-platform standard, no font embed required = file size piccolo); ' +
      'override possibile con font custom embeddable (Roboto, OpenSans, Inter, Times New Roman per documenti ' +
      'legali) — il customer può uploadare TTF/OTF nel vault asset del tenant e referenziarlo nel config. ' +
      'Output: base64 string (pronta da collegare direttamente al campo attachmentsJson di action_send_email ' +
      'per inviarlo come allegato senza passare per filesystem intermedio) oppure save su disco nel sandbox del ' +
      'tenant (per documenti destinati a download UI later). Output structure: { base64, size_bytes, ' +
      'page_count, path?, fileName, mimeType: "application/pdf" }. ' +
      'Compliance enterprise: i PDF generati sono PDF/A-2u valid quando enableArchive=true (subset PDF/A per ' +
      'long-term archival con embed di tutti i font necessari + no encryption + metadata XMP standard), pattern ' +
      'critico per archivio fiscale italiano dove la conservazione a norma DPCM 2014 richiede PDF/A — abbinato ' +
      'con action_pec_legal_archive completa il flow legale. ' +
      'Use case: catalogo prodotti settimanale spedito via email ai venditori del territorio con foto, ' +
      'descrizione, prezzo netto, sconto applicabile per categoria cliente; fattura/preventivo generato ' +
      'post-checkout PayPal/Stripe con i dettagli ordine + dati fiscali + footer con condizioni di vendita; ' +
      'report mensile metriche business allegato a riunione management con chart embedded (generati da ' +
      'generateChart upstream + embed come immagine PNG nel PDF); ricevuta automatic dopo registrazione ' +
      'form/evento (Calendly, Typeform, trigger_form) con QR code embed per check-in scanning all\'evento; ' +
      'contratto pre-compilato con dati cliente per onboarding nuovi clienti SaaS (pdf prepared, customer ' +
      'firma con DocuSign downstream); certificato di partecipazione corso formazione con nome + data + firma ' +
      'CEO embedded per training programs aziendali.',
    configFields: [
      {
        key: 'title',
        label: 'Titolo principale',
        type: 'text',
        required: true,
        placeholder: 'es. Catalogo Prodotti 2026',
        help: 'Comparira\\` in alto su ogni pagina (intestazione) + come prima riga in grande sulla prima pagina. Supporta {{espressioni}}.',
      },
      {
        key: 'subtitle',
        label: 'Sottotitolo (opzionale)',
        type: 'text',
        required: false,
        placeholder: 'es. Listino aggiornato al {{$today}}',
        help: 'Riga in piccolo sotto il titolo nella prima pagina. Vuoto = nessun sottotitolo.',
      },
      {
        key: 'sectionsJson',
        label: 'Sezioni di testo (JSON array)',
        type: 'expression',
        required: false,
        placeholder: '[{"heading":"Descrizione","body":"Testo lungo..."},{"heading":"Termini","body":"..."}]',
        help: 'Array JSON di oggetti `{heading, body}`. heading = titolo sezione (bold), body = paragrafo. ' +
          'Le sezioni vengono renderizzate in ordine. Lascia vuoto per saltare. Tipico: si compone con `{{$node.X.json}}` o `{{vars.descrizione}}`.',
      },
      {
        key: 'tableJson',
        label: 'Tabella dati (JSON array di righe)',
        type: 'expression',
        required: false,
        placeholder: '[{"Prodotto":"Olio","Prezzo":"12.00"},{"Prodotto":"Pasta","Prezzo":"3.50"}]',
        help: 'Array JSON di oggetti. Le chiavi del primo oggetto diventano intestazioni della tabella. ' +
          'Tutte le righe devono avere le stesse chiavi (le mancanti rendono cella vuota). Numeri sono formattati ' +
          'a destra, testo a sinistra. Per cataloghi/listini, ideale insieme a `action_xlsx_parse` upstream che ' +
          'ti dà il JSON da un .xlsx.',
      },
      {
        key: 'footer',
        label: 'Testo piè di pagina',
        type: 'text',
        required: false,
        placeholder: '© 2026 La tua Azienda — Pagina {page} di {total}',
        help: 'Riga in fondo a ogni pagina. Placeholder `{page}` e `{total}` vengono sostituiti automaticamente. ' +
          'Vuoto = nessun footer.',
      },
      {
        key: 'pageSize',
        label: 'Formato pagina',
        type: 'select',
        required: false,
        options: ['A4', 'A5', 'LETTER', 'LEGAL'],
        defaultValue: 'A4',
        help: 'A4 standard EU. LETTER standard US. A5 mezza-pagina per ricevute compatte.',
      },
      {
        key: 'orientation',
        label: 'Orientamento',
        type: 'select',
        required: false,
        options: ['portrait', 'landscape'],
        defaultValue: 'portrait',
        help: 'portrait = verticale (default). landscape = orizzontale (utile per tabelle larghe).',
      },
      {
        key: 'filename',
        label: 'Nome file proposto',
        type: 'text',
        required: false,
        placeholder: 'catalogo-{{$today}}.pdf',
        help: 'Nome file restituito in output (per allegato email o salvataggio). Default: "document.pdf". ' +
          'Estensione .pdf aggiunta se manca.',
      },
    ],
    // REF-PRIMARIO: l'output binario è SEMPRE un handle `binary` (ref content-
    // addressed con store, inline senza). Niente più `base64` nel JSON.
    outputs: ['filename', 'binary', 'sizeBytes', 'pageCount', 'mimeType'],
    vendor: 'flowforge',
    version: '1.0.0',
    cost: {
      costPerCall: 0,    // pdfkit locale, no API esterna
      typicalLatencyMs: 150, // ~50ms small, ~500ms 50-row table
    },
  },
};
