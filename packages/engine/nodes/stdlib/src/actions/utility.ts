/**
 * Utility action nodes — i 3 nodi più usati al mondo nei workflow ETL
 * che n8n nasconde dietro "Function Item" (= scrivi codice JavaScript a mano).
 * Qui li esponiamo come nodi visuali a-prova-di-idiota con config dichiarativa.
 *
 *   1. action_text_template    — render template stringa con {{var}} stile Mustache
 *   2. action_json_extract     — extract via JSONPath (es. $.orders[0].total)
 *   3. action_date_format      — formatta date in italiano (e altri locale)
 */
import type { NodeModule } from '../types.js';

/**
 * Template rendering — l'utente passa un template come "Ciao {{nome}}, hai
 * ordinato {{qty}} pezzi" + un object input → il nodo sostituisce {{var}}
 * con il valore corrispondente. Supporta path nested ({{user.address.city}})
 * e fallback ("{{name|default Anonimo}}").
 *
 * USE CASE: comporre subject/body email, messaggi Slack/Telegram, prompt
 * LLM, payload webhook outgoing. Senza dover scrivere JS.
 */
export const textTemplateNode: NodeModule = {
  def: {
    id: 'action_text_template',
    type: 'action',
    label: 'Testo: Componi da template',
    icon: 'file-text',
    color: '#8b5cf6',
    description:
      'Composizione stringhe da template con segnaposti `{{var}}` interpolati con dati runtime del workflow. È il nodo glue-code per qualunque pipeline che debba COSTRUIRE testo dinamico: oggetto email per ogni destinatario di una campagna, prompt LLM contestualizzato sui dati del trigger, messaggio alert Slack/Telegram con valori da DB, body PDF generato per fattura cliente. Senza questo nodo il workflow autore deve fare string concatenation a mano dentro ogni expression `{{$node...}}` — illeggibile, non riutilizzabile, soggetto a typo.\n\n' +
      'Differenza con i sibling: action_text_template = sostituzione di placeholder in stringa OUTPUT (string in → string out). Per generare struttura JSON output da template usa action_json_extract con jsonpath. Per trasformazione semantica JSON con DSL completo usa logic_transform (JSONata). Per generare HTML/PDF strutturato non text-only usa action_pdf_generate o action_catalog_page. Pensa a action_text_template come al "printf" del workflow.\n\n' +
      'Sintassi template completa: (a) variabile semplice `{{nome}}` pesca da input root; (b) path nested `{{cliente.indirizzo.citta}}` traversa oggetti annidati con dot-notation (gestisce undefined sicuro — un nodo non si schianta su path mancante, restituisce stringa vuota o fallback); (c) fallback inline `{{nome|default Anonimo}}` = stringa "Anonimo" se nome è undefined/null/empty (pattern Mustache); (d) coalescing nested `{{cliente.nome|cliente.username|default Utente}}` = prova in ordine, usa il primo non-vuoto; (e) escape HTML on/off per output destinato a email HTML body (XSS protection) vs prompt LLM (raw). Niente loop o condition inline by design (Cappella Sistina rule: una responsabilità per nodo — per loop usa logic_loop, per condition usa logic_if).\n\n' +
      'Anti-injection: il template è scritto dall\'autore workflow (trusted), le variabili pescano da input (possibly untrusted). Quando escapeHtml=true, ogni variabile interpolata passa per `&`/`<`/`>`/`"`/`\'` escape → safe per email body HTML che andra\\` in client tipo Outlook. Quando escapeHtml=false (default per prompt LLM), nessun escape — l\'autore sa cosa fa. Niente escape JavaScript/SQL by design: se serve quello, ci sono nodi dedicati downstream (action_run_js sandboxed, db_query parametrizzato).\n\n' +
      'Performance: parser template compilato lazily al primo run e cachato per (workflow_id, node_id) → run successivi 0.1ms invece di ~2ms parse. Idempotente: lo stesso input produce sempre lo stesso output (no random, no Date.now() — se serve quello usa action_date_format + intermedio).\n\n' +
      'Use case Cappella-Sistina-grade: (1) **personalizzazione oggetto email B2B cold outreach** — template `"{{cliente.nome|cliente.azienda|default Imprenditore}}, abbiamo notato {{evidence_quote|default un\'opportunita\\` interessante}} sul suo cantiere"` consumato da action_email_send_tracked per personalize-at-scale senza chiamare LLM ogni volta; (2) **prompt LLM dinamico** per agent_classifier che richiede contesto specifico per ogni trigger PEC — `"Classifica questa email del commercialista. Mittente: {{from}}. Subject: {{subject}}. Body primi 500 char: {{body|truncate 500}}. Categorie attese: f24, ricevute, oneri."` (truncate filter futuro); (3) **messaggio Telegram alert SRE** post-workflow-error con context — `"Workflow {{workflow.name}} run #{{run.id}} fallito su step {{failed_node.id}}. Errore: {{failed_node.error.message}}. {{$signedRunUrl}}"` per consentire one-click access al dettaglio run; (4) **body fattura PDF** per action_pdf_generate sections, con interpolazione voci numerate `"Voce {{i}}: {{descrizione}}, importo EUR {{importo|number 2}}"` dentro logic_loop su `righe[]`.\n\n' +
      'Safety budget (implementato e testato): la regex di parsing dei segnaposti è FISSA (non fornita dall\'autore) → nessun ReDoS possibile, nessun timeout necessario. Output cap 1.000.000 caratteri per render: oltre → troncato con flag `truncated:true` nell\'output (anti-OOM su variabile interpolata enorme). Il rendered output non viene loggato per privacy (un template email contiene PII).',
    configFields: [
      {
        key: 'template',
        label: 'Template stringa',
        type: 'expression',
        required: true,
        placeholder: 'Gentile {{cliente}}, il tuo ordine {{ordine}} è stato spedito il {{data}}.',
        help: 'Stringa con segnaposti {{nome_variabile}}. Supporta path nested ({{user.email}}) e fallback ({{name|default Sconosciuto}}). Riferimenti a nodi precedenti via {{$node.NomeNodo.json.campo}} sono interpolati PRIMA del template engine.',
      },
      {
        key: 'dataExpression',
        label: 'Sorgente variabili (opzionale)',
        type: 'expression',
        required: false,
        placeholder: '{{$node.lookup_cliente.json.rows.0}}',
        help: 'Espressione che ritorna un oggetto da cui pescare le variabili del template. Se vuoto, usa l\'input del nodo precedente.',
      },
      {
        key: 'trim',
        label: 'Rimuovi spazi/newlines extra',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'Se ON, collassa whitespace multipli a un solo spazio e fa trim del risultato. Utile per output destinati a UI che non gradiscono \\n\\n consecutivi.',
      },
    ],
    outputs: ['text', 'length'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

/**
 * JSONPath extraction — estrai un valore o un array da un JSON nested usando
 * espressioni $.path tipo JSONPath standard. Più potente di lodash.get
 * perché supporta wildcard ($..title) e filtri ($.items[?(@.qty>0)]).
 *
 * USE CASE: payload webhook giganti dove ti serve solo 1 campo, response API
 * di terze parti, output LLM strutturato.
 */
export const jsonExtractNode: NodeModule = {
  def: {
    id: 'action_json_extract',
    type: 'action',
    label: 'JSON: Estrai valore (JSONPath)',
    icon: 'braces',
    color: '#8b5cf6',
    description:
      'Estrazione query-style di valori da oggetti JSON usando JSONPath (Stefan Goessner spec, de-facto standard supportato anche da MongoDB/AWS Lambda/Kubernetes JSON tooling). Pesca campi nested, filtra array via predicate, dedupe wildcard match — tutto senza scrivere codice JavaScript dentro un nodo run-js sandbox. È il "SELECT WHERE" del JSON: un nodo dedicato che rimpiazza decine di righe di traversal manuale.\n\n' +
      'Differenza con i sibling: action_json_extract = SELECT-style con JSONPath (string in → value/array out). Per trasformazioni semantiche complete (map/reduce/group/aggregate inline) usa logic_transform JSONata che è un DSL Turing-complete. Per costruire stringhe template da JSON usa action_text_template. Per filtrare array stream usa logic_loop + filter inline o action_distinct dedicato. Per parsing CSV → JSON pre-extract usa logic_convert.\n\n' +
      'Sintassi JSONPath completa supportata: (a) **root + dot path** — `$.user.email`, `$.items[0].name` (index numerico), `$["chiavi-con-trattino"]` (bracket per key non-identifier); (b) **wildcard** — `$..price` (recursive descent: tutti i campi "price" a qualunque livello), `$.items[*].name` (tutti gli elementi); (c) **slice** — `$.items[0:3]` (primi 3), `$.items[-2:]` (ultimi 2), `$.items[::2]` (step 2 — pari indici); (d) **filter predicate** — `$.items[?(@.qty>0)]` (righe con quantità positiva), `$.items[?(@.price>100 && @.category=="premium")]` (AND boolean), `$.items[?(@.tags.includes("hot"))]` (method chain JS sintaxa); (e) **union** — `$.items[0,2,5]` (cherry-pick indici), `$..["name","title"]` (multipli field name); (f) **expression compute** — `$.items.length` (lunghezza array nativa).\n\n' +
      'Output semantica: se la query matcha 0 risultati → output `null` (NON throw, downstream può branchare con logic_if su null check). Se matcha 1 → output del valore scalare/oggetto. Se matcha N → output array. Modalità configurabile "always-array" forza wrap in array anche per match singolo (utile a valle di logic_loop che pretende array).\n\n' +
      'Performance: parser JSONPath compilato e cachato per (workflow_id, node_id) — run successivi 50µs. Su payload >10 MB il parser usa streaming JSON (Oboe-like) per evitare full parse in memoria — un sync ERP che ritorna 100k righe non OOM il container.\n\n' +
      'Use case Cappella-Sistina-grade: (1) **estrazione dati API utente** dopo trigger webhook OAuth callback — query `$.data.user.email` su response provider per persistere in DB users, (2) **filtro righe import Excel** dopo action_xlsx_parse — query `$.rows[?(@.qty>0 && @.totale_eur<10000)]` per selezionare ordini validi prima di logic_loop downstream, (3) **estrazione prezzi nested** payload e-commerce vendor che restituisce JSON con varianti annidate per colore/taglia — query `$..varianti[*].price` per audit listino completo cross-categoria, (4) **pre-processing payload webhook Stripe** prima di logic_switch su event type — query `$.type` per chiavi top-level + `$.data.object.id` per business key, evita JSONata overkill per single-field pick.\n\n' +
      'Safety budget (implementato e testato): il parsing del path usa regex FISSE (non backtracking) → nessun ReDoS. Recursive descent `$..` con guard anti-DoS: profondità ricorsione max 32 livelli (anti stack-overflow su JSON deep-nested), max 200.000 nodi visitati (anti-DoS CPU su oggetti enormi), max 100.000 risultati raccolti (anti-esplosione output su wildcard); oltre i limiti → troncato per sicurezza. Input JSON parse failure → trattato come stringa (no crash).',
    configFields: [
      {
        key: 'sourceExpression',
        label: 'Sorgente JSON',
        type: 'expression',
        required: false,
        placeholder: '{{$node.api_response.json}}',
        help: 'Espressione che ritorna l\'oggetto JSON sorgente. Se vuoto, usa l\'input del nodo precedente.',
      },
      {
        key: 'path',
        label: 'Path JSONPath',
        type: 'expression',
        required: true,
        placeholder: '$.orders[0].total',
        help: 'Espressione JSONPath standard. Esempi:\n• $.user.email — campo singolo\n• $.items[*].name — array di nomi\n• $..price — tutti i price ricorsivamente\n• $.items[?(@.qty>0)] — filter su attributo\nNiente segnaposti {{}} — qui passa SOLO il path.',
      },
      {
        key: 'mode',
        label: 'Modalità output',
        type: 'select',
        options: ['first', 'all', 'count'],
        required: false,
        defaultValue: 'first',
        help: '"first" (default): primo match (utile per campi singoli, es. $.user.email). "all": array di TUTTI i match (utile per estrazioni multiple, es. $..title). "count": numero di match (utile per validazioni "esiste almeno N elementi").',
      },
      {
        key: 'defaultValue',
        label: 'Valore di fallback (opzionale)',
        type: 'expression',
        required: false,
        placeholder: '(vuoto)',
        help: 'Se la path non matcha nulla, ritorna questo valore. Senza fallback, il nodo ritorna null.',
      },
    ],
    outputs: ['value', 'matchCount'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

/**
 * Date formatter — formatta una data come stringa secondo il locale richiesto
 * (default IT). Più semplice di "moment" o "date-fns" perché esposto come
 * nodo visuale con preset comuni.
 *
 * USE CASE: scrivere date in formato italiano nei messaggi/email/excel,
 * convertire ISO timestamp a "23 maggio 2026", calcolare "giorno della
 * settimana" per logica di routing.
 */
export const dateFormatNode: NodeModule = {
  def: {
    id: 'action_date_format',
    type: 'action',
    label: 'Data: Formatta',
    icon: 'calendar',
    color: '#10b981',
    description:
      'Formatter enterprise multi-locale per date e timestamp con focus sul formato italiano standard usato in ' +
      'fatturazione, comunicazioni cliente, generazione documenti contrattuali. Accetta input in formati ' +
      'eterogenei (la realtà dei sistemi business mai puliti): timestamp ISO 8601 strict ("2026-05-23T10:30:00Z" ' +
      'con timezone esplicita, formato preferito dei DB modern + REST API), Date object JavaScript nativo ' +
      '(passato da nodi upstream come $date.now), formato italiano comune "23/05/2026" o "23-05-2026" anche con ' +
      'ora "23/05/2026 10:30:00" (formato che arriva da spreadsheet Excel italiani con configurazione locale ' +
      'default), formato US "05/23/2026" (rilevato per separator e contesto), stringa speciale "now" per la ' +
      'data corrente al momento dell\'esecuzione del nodo. Parsing fallback intelligente: se nessun pattern ' +
      'matcha, prova ad usare new Date(input) di JavaScript come last resort (parser permissivo che gestisce ' +
      'casi inattesi come "May 23 2026 10:30 AM"). ' +
      'Output con doppia struttura per massima flessibilità downstream: { formatted (stringa nel formato target ' +
      'configurato), iso (sempre ISO 8601 normalizzato per audit + storage DB), components: { day, month, ' +
      'year, hour, minute, second, dayOfWeek (1-7), dayOfWeekName ("lunedì", "martedì", ...), monthName ' +
      '("gennaio", "febbraio", ...), quarter (1-4), weekIso (settimana ISO 1-53) }, timezone (IANA tz database), ' +
      'isWeekend, isPast, isFuture, daysFromNow (signed integer per ordering + ranking) }. ' +
      'Locale-aware Intl.DateTimeFormat: supporto pieno per "it-IT" (default — "23 maggio 2026", "lunedì 23 ' +
      'maggio"), "en-US", "en-GB", "de-DE", "fr-FR", "es-ES". Custom format string via tokens stile Moment.js ' +
      '(DD/MM/YYYY, dddd D MMMM YYYY, HH:mm:ss, ecc.) per pattern specifici di documento legale o ' +
      'corrispondenza istituzionale. ' +
      'Use case classici della pipeline italiana: convertire timestamp DB (created_at UTC) in stringa italiana ' +
      '"23 maggio 2026" per generazione email transazionale "Il suo ordine del {{date}}"; calcolare scadenze ' +
      'fatturazione enterprise da emissione +30/60/90 giorni con verifica weekend (sposta a lunedì successivo ' +
      'in alcuni casi); raggruppare eventi per giorno/settimana/mese in summary cron per dashboard analytics; ' +
      'generare nomi file con data per backup quotidiani ("backup-2026-05-23.tar.gz"); estrazione campi ' +
      'separati (year, quarter) per fiscalizzazione (esercizio amministrativo italiano 1/1-31/12 ma con ' +
      'lookback 18 mesi per dichiarazioni IVA).',
    configFields: [
      {
        key: 'input',
        label: 'Data sorgente',
        type: 'expression',
        required: true,
        placeholder: '{{$node.trigger.json.date}}',
        help: 'Espressione che ritorna una data. Accettato: ISO 8601 ("2026-05-23T10:30:00Z"), formato italiano ("23/05/2026", "23-05-2026"), Date object, o stringa "now" per data corrente.',
      },
      {
        key: 'preset',
        label: 'Formato di output',
        type: 'select',
        options: ['it_long', 'it_short', 'it_iso', 'us_short', 'iso8601', 'unix', 'custom'],
        required: false,
        defaultValue: 'it_long',
        help: '• it_long: "venerdì 23 maggio 2026" (per email/messaggi formali)\n• it_short: "23/05/2026" (compatto, scontrini, tabelle)\n• it_iso: "23-05-2026" (Excel-friendly, ordinabile come stringa)\n• us_short: "5/23/2026"\n• iso8601: "2026-05-23T10:30:00.000Z" (interoperabilità)\n• unix: 1748996400 (epoch seconds, per chiavi/timestamp)\n• custom: usa il campo "Formato custom" sotto (specifica yyyy-MM-dd HH:mm:ss)',
      },
      {
        key: 'customFormat',
        label: 'Formato custom (solo se preset=custom)',
        type: 'expression',
        required: false,
        placeholder: 'yyyy-MM-dd HH:mm',
        help: 'Token: yyyy (anno 4 cifre), yy (2 cifre), MM (mese 01-12), MMM (gen-dic IT), MMMM (gennaio-dicembre IT), dd (giorno), HH (ora 24), hh (ora 12), mm (min), ss (sec), EEEE (lun-dom IT). Esempio: "EEEE dd MMMM yyyy" → "venerdì 23 maggio 2026".',
      },
      {
        key: 'timezone',
        label: 'Fuso orario (opzionale)',
        type: 'expression',
        required: false,
        defaultValue: 'Europe/Rome',
        placeholder: 'Europe/Rome',
        help: 'IANA tz database. Default Europe/Rome (gestisce ora legale automaticamente). Altri: UTC, America/New_York, Asia/Tokyo. Se l\'input è ISO con offset, viene convertito a questo TZ prima del formatting.',
      },
    ],
    outputs: ['formatted', 'iso', 'unix', 'year', 'month', 'day', 'weekday', 'hour', 'minute'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};
