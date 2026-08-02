import type { NodeModule } from '../types.js';

/**
 * action_xlsx_parse — legge un file Excel (.xlsx) e ritorna le righe come
 * array di oggetti. Tipico uso: ricevi un Excel via email IMAP / form upload
 * → estrai le righe → ciclo con Loop → DB insert.
 *
 * IMPORTANTE: i nomi dei campi devono matchare ESATTAMENTE quelli letti
 * dall'executor `xlsxParseExecutor` in `apps/runtime/src/executors/excel.ts`.
 */
export const xlsxParseNode: NodeModule = {
  def: {
    id: 'action_xlsx_parse',
    type: 'action',
    label: 'Excel: Parse (xlsx → array)',
    icon: 'table',
    color: '#10b981',
    description:
      'Parser enterprise per file Microsoft Excel formato .xlsx (Office Open XML SpreadsheetML, lo standard ' +
      'Excel 2007+ universalmente usato nei workflow business italiani: commercialisti, controlling, sales ' +
      'reporting, magazzino, ordini, fatturazione, riconciliazione bancaria, anagrafica clienti/fornitori). ' +
      'Trasforma il binario Excel in un dataset processabile come array di oggetti JavaScript pronto per loop, ' +
      'filter, sync, ingest in DB o pipeline downstream. La prima riga del foglio è interpretata di default ' +
      'come header (intestazioni colonne) e le righe successive diventano oggetti dove ogni cella corrisponde ' +
      "al valore del campo identificato dall'header — pattern naturale per non-developer che esportano CRM/" +
      'ERP/gestionali in Excel e vogliono manipolare i dati programmaticamente. ' +
      'Input duale per coprire i pattern di provenienza file Excel reali in workflow business: input da disco ' +
      '(path nel sandbox del tenant, es. file uploadato via SFTP, scritto da action_file_write upstream, ' +
      'droppato da trigger_file_watch nella cartella shared) oppure input da base64 (la rappresentazione ' +
      'string-encoded del binario, formato canonico per attachment di trigger_imap email, body di webhook ' +
      'multipart upload via trigger_form, payload API con file embedded). Auto-detect del formato di input. ' +
      'Multi-foglio support: il workbook Excel può contenere N fogli (sheet) — il nodo permette di selezionare ' +
      'uno specifico per nome ("Ordini", "Listino", "Fatture") o per indice (0-based), oppure di iterare ' +
      'tutti i fogli ed emettere array consolidato (utile per Excel con multi-mese in fogli separati "2026-01", ' +
      '"2026-02", ecc.). ' +
      'HeaderRow configurabile: per file Excel "professionali" con titolo + logo aziendale + metadata nelle ' +
      'prime righe (pattern comune nei file da gestionali italiani come Sage, Zucchetti, TeamSystem), la riga ' +
      'di header è alla riga 5 o 7, non alla riga 1 — il parametro headerRow (default 1, 1-based) skippa le ' +
      'righe iniziali decorative. ' +
      'Type preservation: numeri restano numeric (non stringificati con perdita di precisione), date Excel ' +
      'serial number convertite in Date object JavaScript (con timezone corretta), booleani come true/false, ' +
      'celle vuote come null (consistenza per filter downstream). ' +
      "Cap di sicurezza: max 1M rows per evitare OOM su file enormi (l'Excel format supporta 1M+ righe ma " +
      'lavorarci in JavaScript pratico < 100k), warning se headerRow > 100 (probabile sbaglio di config). ' +
      'Output: { rows (array di oggetti, un campo per header), sheetName, totalRows, columns, columnCount, ' +
      'headerRow, emptyCellsCount, truncated }. ' +
      'Use case: ingest ordini da allegato Excel di una email IMAP cliente B2B (cliente legacy che ancora ' +
      'manda ordini via Excel anziché EDI) → parse → loop su rows → action_odoo_create_lead per ogni riga; ' +
      "import lead da export CRM xlsx caricato dall'utente via trigger_form upload → loop → upsert HubSpot; " +
      'parse listino prezzi fornitore aggiornato periodicamente (trigger_file_watch + action_xlsx_parse + ' +
      'sync DB pricing); batch update di anagrafica clienti da spreadsheet di riconciliazione contabile mensile ' +
      'del commercialista; processing di export Salesforce SOQL salvato come Excel per dashboard custom; ' +
      'estrazione di righe specifiche da modulo F24 in formato Excel per tracking pagamenti tributi.',
    configFields: [
      {
        key: 'path',
        label: 'File Excel sul disco (opzionale)',
        type: 'file-picker',
        required: false,
        placeholder: 'es. import.xlsx o {{input.attachmentPath}}',
        help: 'Path nel sandbox del tenant. Se vuoto, l\'engine cerca i bytes in "Base64" qui sotto. Uno dei due è obbligatorio.',
      },
      {
        key: 'base64',
        label: 'Base64 dei bytes Excel (opzionale)',
        type: 'expression',
        required: false,
        placeholder: '{{$node.ImapTrigger.json.attachment[0].base64}}',
        help: 'Stringa base64 dei bytes del file. Usato tipicamente per parsare allegati ricevuti via email/webhook senza salvarli su disco.',
      },
      {
        key: 'sheetName',
        label: 'Nome foglio (opzionale)',
        type: 'expression',
        required: false,
        placeholder: 'es. Ordini o Sheet1',
        help: "Nome del foglio da leggere. Vuoto = primo foglio del workbook. Se sbagli il nome, l'engine ti dice nei suoi errori quali fogli ci sono.",
      },
      {
        key: 'headerRow',
        label: 'Riga header',
        type: 'number',
        required: false,
        defaultValue: '1',
        help: "1 = prima riga è l'header (default, formato Excel standard). 0 = nessun header, righe come array posizionali (col_1, col_2, …). N = la riga N è l'header (utile per file con titolo/logo nelle prime righe).",
      },
    ],
    outputs: [
      'rows',
      'sheetName',
      'totalRows',
      'columns',
      'columnCount',
      'headerRow',
      'emptyCellsCount',
      'truncated',
    ],
    vendor: 'flowforge',
    version: '1.1.0',
  },
};

/**
 * action_xlsx_build — genera un file Excel (.xlsx) da un array di oggetti.
 * Tipico uso: ricevi righe dal DB → genera template Excel → allega ad email
 * verso il fornitore/cliente.
 */
export const xlsxBuildNode: NodeModule = {
  def: {
    id: 'action_xlsx_build',
    type: 'action',
    label: 'Excel: Build (array → xlsx)',
    icon: 'file-spreadsheet',
    color: '#10b981',
    description:
      'Generator enterprise di file Excel formato .xlsx (Office Open XML SpreadsheetML, lo standard Microsoft ' +
      'Excel 2007+ universalmente compatibile con Excel desktop Windows/Mac, Excel Web, LibreOffice Calc, ' +
      'OpenOffice Calc, Google Sheets import, Numbers Mac) — la controparte inversa di action_xlsx_parse, ' +
      'fondamentale per output di report del workflow business verso destinatari non-tecnici che usano Excel ' +
      'come ambiente nativo di consumo dati. Trasforma un array di oggetti JavaScript (pipe naturale da ' +
      'db_query, paginate, listScheduledEvents Calendly, queryDatabase Notion, qualsiasi data source upstream) ' +
      'in un file Excel pronto da scaricare, allegare a email transazionale, archiviare su S3 per long-term ' +
      'compliance, condividere via OneDrive con il team management. ' +
      "Output disponibile in due forme per coprire i pattern d'uso reali: base64 string (pronto per allegato " +
      'in action_send_email tramite il campo attachments senza dover passare per il filesystem intermedio — il ' +
      'pattern più comune per report inviati via email) oppure save su disco nel sandbox del tenant ' +
      '(scrittura atomica write+rename, pattern per workflow di archivio long-term o per file destinati a ' +
      'download successivo via UI tenant). ' +
      'Customization rich del file output: header row personalizzabile (le intestazioni colonne possono ' +
      'differire dai field name JavaScript — es. "first_name" come field interno ma "Nome" come visualizzazione ' +
      'utente in Excel), formattazione colonne type-aware (numero con decimal places, percentage con simbolo %, ' +
      'valuta con simbolo € e separator italiano "1.234,56", data con formato locale "DD/MM/YYYY", text plain), ' +
      'foglio nominato (default "Sheet1", configurable a "Ordini", "Cedolini", "Riconciliazione" per ' +
      'self-documenting workbook), auto-width colonne basato sul contenuto massimo per evitare il classico ' +
      '"#####" su numeri grossi che non entrano, freeze panes per la prima riga (header always visibile in ' +
      'scroll). ' +
      'Type preservation reverse del parse: number JavaScript → numeric cell Excel (con precision), Date → ' +
      'Excel serial number con timezone preservation, boolean → "TRUE"/"FALSE" string canonica Excel, null → ' +
      'empty cell (no string "null" che inquinerebbe), array/object → JSON serialized in singola cell come ' +
      'string. ' +
      'Cap di sicurezza: max 1M rows per workbook (limit hard Excel), cap su dimensione file output 50MB per ' +
      'evitare OOM su workflow generando file giganti. ' +
      'Output: { binary (handle file pronto per gli attachments), path? (se salvato su disco), ' +
      'fileName, sheetName, rowsWritten, sizeBytes, contentType }. ' +
      'Il contentType è "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet". ' +
      'Use case: report settimanale vendite allegato a email management ogni lunedì 09:00 (trigger_cron + ' +
      'db_query + xlsx_build + send_email con base64 attachment); export ordini CRM HubSpot verso fornitore ' +
      'B2B EDI-less in formato xlsx settimanale con calcolo prezzi netti+IVA; backup quotidiano di tabella DB ' +
      'critica in spreadsheet archiviato su S3 con retention 7 anni per compliance fiscale; generazione di ' +
      'template fattura/preventivo riempito con dati cliente da Odoo per stampa controllo prima emissione SDI; ' +
      'analytics dashboard "scaricabile" per CEO che preferisce Excel a Looker con drill-down formule pivotabili.',
    configFields: [
      {
        key: 'sheetName',
        label: 'Nome foglio',
        type: 'expression',
        required: false,
        defaultValue: 'Sheet1',
        placeholder: 'es. Ordini, Cedolini, RighiOrdine',
        help: 'Nome del foglio nel workbook generato. Default "Sheet1".',
      },
      {
        key: 'dataExpression',
        label: 'Sorgente righe (opzionale)',
        type: 'expression',
        required: false,
        placeholder: '{{$node.extract_of.json.lines}}',
        help: "Espressione che ritorna l'array di oggetti riga (es. {{$node.NomeNodo.json.lines}}). Se vuoto, l'engine usa l'input del nodo precedente. Utile quando il nodo precedente NON è la sorgente dati (es. dopo db_insert_batch che ritorna solo {headerId}).",
      },
      {
        key: 'groupByKey',
        label: 'Raggruppa per (multi-scheda)',
        type: 'text',
        required: false,
        placeholder: 'es. supplier_name',
        help: 'Nome del campo per cui raggruppare. Crea UNA SCHEDA Excel per ogni valore distinto. Esempio: groupByKey="supplier_name" → un foglio per fornitore. Lascia vuoto per un singolo foglio con tutte le righe.',
      },
      {
        key: 'columns',
        label: 'Colonne (opzionale)',
        type: 'text',
        required: false,
        placeholder: 'data:Data:date_dmy,prezzo:Prezzo:eur_4,sconto:Sconto:percent_2',
        help: 'Sintassi "key:Label:formato,..." (formato è opzionale). Senza formato i valori vengono scritti come arrivano. Formati disponibili (mostrati con LOCALE ITALIANA):\n• text → testo grezzo (es. codici con zeri iniziali "001234")\n• integer → 1.234\n• number_2 → 1.234,56\n• number_4 → 1.234,5678\n• eur_2 → 1.234,56 €\n• eur_4 → 1.234,5678 €\n• percent_2 → 10,00%\n• date_dmy → 23-05-2026\n• datetime → 23-05-2026 14:30\n\nEsempio Ordini Fornitori: "nr_ordine:NR.ORDINE:text,data:DATA:date_dmy,descr:DESCRIZIONE,qta:QTA:integer,prezzo:PREZZO UNITARIO:eur_4,sconto:SCONTO:percent_2,totale:TOTALE RIGA:eur_2".\n\nIl nodo: 1) coerce stringhe italiane "10,50" → numero 10.5; 2) auto-fit larghezza colonne; 3) header bold + sfondo grigio + prima riga frozen; 4) auto-filter su tutte le colonne. Federico-grade out of the box.',
      },
      {
        key: 'freezeHeader',
        label: 'Blocca riga header durante scroll',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help: "Quando l'utente scrolla verso il basso, la riga header rimane visibile. Disabilita SOLO se serve compatibilità con un tool antiquato che non gestisce frozen panes.",
      },
      {
        key: 'autoFilter',
        label: 'Aggiungi filtri colonna (frecce dropdown)',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help: 'Aggiunge un menu a tendina su ogni colonna header per filtrare/ordinare. Standard in Excel/LibreOffice. Disabilita per export "scheda stampa" senza interazione.',
      },
      {
        key: 'forceItalianStrings',
        label: 'Forza formato italiano universale (consigliato)',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help: 'ON (default): i valori numerici (€, %, decimali) vengono scritti come STRINGHE già formattate in italiano (es. "1.234,56 €", "0,00%"). Funziona su QUALUNQUE viewer (Excel Android, Google Sheets, Numbers macOS, LibreOffice). Trade-off: perdi ordering/sum numerico Excel-side. OFF: usa numFmt con LCID [$-410]: il viewer deve riconoscere il LCID italiano (Excel Office IT ok, Numbers macOS no, Excel Android no). Lascia ON se il tuo cliente apre il file con Excel mobile, Google Sheets o Numbers.',
      },
      {
        key: 'path',
        label: 'Salva su disco (opzionale)',
        type: 'file-picker',
        required: false,
        placeholder: 'es. output/{{$today}}/ordini.xlsx',
        help: "Path nel sandbox del tenant dove salvare il file. Se vuoto, il file NON viene salvato — l'output ritorna come base64, ideale per allegato Send Email node.",
      },
    ],
    outputs: ['path', 'binary', 'fileName', 'sheetName', 'rowsWritten', 'sizeBytes', 'contentType'],
    vendor: 'flowforge',
    version: '1.1.0',
  },
};
