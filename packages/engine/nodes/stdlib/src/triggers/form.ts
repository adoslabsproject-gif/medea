import type { NodeModule } from '../types.js';

/**
 * Form trigger — auto-generates an HTML form at /forms/:workflowId/:token
 * Submission body becomes triggerInput.
 */
export const formTriggerNode: NodeModule = {
  def: {
    id: 'trigger_form',
    type: 'trigger',
    label: 'Form Submission',
    icon: 'clipboard-list',
    color: '#22c55e',
    description:
      'Generatore di form HTML pubblico no-code enterprise — il classico "drop a form on your website" feature ' +
      'che rende possibile collezionare input da audience esterna (clienti, prospect, candidati, segnalanti) ' +
      'senza richiedere account FlowForge né uno sviluppatore frontend per costruire HTML/JS form a mano. Il ' +
      "drag&drop fields builder dell'editor permette al business user (commercialista, marketing manager, HR " +
      'recruiter) di comporre il form in 2 minuti scegliendo tipi di campo con configurazione visuale (label, ' +
      'placeholder, required, validation regex, default, opzioni select), preview real-time del risultato HTML ' +
      "finale, e l'expression di pubblicazione genera un URL univoco di tipo " +
      'https://<tenant>.app.automazionezeli.com/forms/<workflowId>/<publicToken> che può essere embedded in ' +
      'iframe sul sito esterno, condiviso come link sui social, allegato in email marketing, stampato su ' +
      'volantini come QR code. ' +
      'Ogni submission completata triggera un nuovo run del workflow con un input strutturato { fieldKey: ' +
      'value (mapping di tutti i field secondo il config), _meta: { ip (anonimizzato per GDPR per gli ultimi ' +
      '16 bit IPv4 o 80 bit IPv6), userAgent (normalizzato a famiglia browser per analytics non-PII), ' +
      'submittedAt (ISO 8601 UTC), referer (URL referrer pagina origine del traffic), country (GeoIP-derived ' +
      'dal Cloudflare CF-IPCountry header), formVersion (per A/B testing) } }. ' +
      'Field types supportati copertura completa: text (single line, max length config), textarea (multi-line ' +
      'con limite caratteri visible), email (validation HTML5 + DNS MX lookup opt-in via integrazione ' +
      'action_email_validate_mx downstream), number (with min/max, step decimale), date (datepicker browser ' +
      'nativo con range cap), select (dropdown con opzioni statiche o dinamiche da DB query), checkbox (multi ' +
      'selection), file (upload con allowlist MIME e cap dimensione default 10MB), hidden (passthrough di ' +
      'parametri injected via query string per tracking source/campaign). ' +
      'Validation a doppio strato: client-side HTML5 native + JavaScript per UX immediata, server-side rigorosa ' +
      'per security (NIENTE trust al client malevolo che bypassa il JS). ' +
      'Anti-spam multi-layer: honeypot field (campo invisible che solo i bot riempono — il workflow rigetta ' +
      'le submission che lo hanno valorizzato), rate-limit per IP (default 5 submission/min stessa IP, configurable), ' +
      'Sentinel WAF integration per detection di pattern brute-force, opzionale reCAPTCHA v3 invisibile per ' +
      'submission ad alto-volume. ' +
      'Use case: lead capture da landing page marketing — il form embedded sul sito raccoglie nome+email+azienda ' +
      'e il workflow downstream fa upsert in HubSpot + invio email benvenuto + creazione card Trello per ' +
      'follow-up commerciale; ticketing customer support — form con priority+category+description triggera ' +
      'workflow di creazione issue GitHub + notifica Slack al team competente; sondaggi audience per market ' +
      'research con multi-step form e logica condizionale; data-collection da non-utenti FlowForge (candidati ' +
      'di una posizione lavorativa, clienti che chiedono preventivo, partecipanti a evento webinar); ' +
      'registrazione utenti a community con verifica email automatica downstream.',
    configFields: [
      {
        key: 'title',
        label: 'Titolo del form',
        type: 'text',
        required: true,
        defaultValue: 'Nuova segnalazione',
        help: 'Mostrato in testa alla pagina pubblica del form e nel tab del browser.',
      },
      {
        key: 'fieldsJson',
        label: 'Campi del form',
        type: 'form-fields',
        required: true,
        defaultValue: '[]',
        help: 'Trascina per riordinare, clicca + Campo per aggiungere. Tipi disponibili: text, email, number, textarea, select, checkbox, date, file.',
      },
      {
        key: 'publicToken',
        label: 'Token pubblico (auto-generato)',
        type: 'text',
        required: true,
        help: "Token segreto che protegge l'URL pubblico del form. Senza questo token, l'URL /forms/<workflowId>/<token> non funziona. Il token viene generato automaticamente al primo salvataggio — NON modificarlo a mano se hai già condiviso il link. Per invalidare l'URL vecchio: cancella il token e salva (ne verrà generato uno nuovo).",
      },
      {
        key: 'submitLabel',
        label: 'Testo bottone invio',
        type: 'text',
        required: false,
        defaultValue: 'Invia',
        help: 'Etichetta del bottone di submit (es. "Invia", "Conferma", "Procedi").',
      },
      {
        key: 'successMessage',
        label: 'Messaggio di conferma',
        type: 'rich-text',
        required: false,
        defaultValue: 'Grazie! La tua segnalazione è stata ricevuta.',
        help: "Mostrato all'utente dopo l'invio. Supporta formattazione (grassetto, link, liste).",
      },
      {
        key: 'rateLimitPerMin',
        label: 'Rate limit per IP/minuto',
        type: 'number',
        required: false,
        defaultValue: '10',
        help: 'Massimo numero di submit dallo stesso IP al minuto. 0 = nessun limite (sconsigliato per form pubblici).',
      },
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

/**
 * File watch trigger — uses chokidar in the runtime to fire on file
 * created/modified/deleted within an allowlisted directory.
 */
export const fileWatchTriggerNode: NodeModule = {
  def: {
    id: 'trigger_file_watch',
    type: 'trigger',
    label: 'File Watch',
    icon: 'folder-open',
    color: '#22c55e',
    description:
      'Watcher filesystem enterprise basato su chokidar (battle-tested in Webpack, Parcel, Vite e altri 100M+ ' +
      'downloads/anno) che firma il workflow quando un file viene creato (add), modificato (change), o cancellato ' +
      '(unlink) in una directory monitorata del volume persistente del tenant — il modulo "Drop folder" tipico ' +
      'di gestionali Italiani, dove un operatore "lascia cadere" un PDF/CSV/XLS nella cartella di rete e il ' +
      'sistema lo processa automaticamente entro pochi secondi senza richiedere upload via UI. ' +
      'Implementazione: chokidar usa fs.watch nativo di Node.js con fallback su polling per filesystem che non ' +
      'supportano inotify (es. mount NFS, container Docker overlay2 in alcune config Kubernetes), garantendo ' +
      'cross-platform consistency (Linux inotify, macOS FSEvents, Windows ReadDirectoryChangesW). Debounce ' +
      "configurabile (default 300ms) per evitare event flood quando un'applicazione scrive il file a chunks " +
      '(es. SFTP upload progressivo, browser drag-drop multi-MB) — il trigger attende stabilità della dimensione ' +
      'prima di firmare il workflow, evitando di processare file half-written. ' +
      'Sicurezza: path allowlist obbligatorio (root path della cartella + descendant), NO escape verso /etc o ' +
      '/proc, NO symlink resolution (se la cartella contiene link simbolici, vengono ignorati per evitare path ' +
      'traversal); ownership check verifica che il file appartenga al tenant utente; cap su dimensione massima ' +
      'configurabile (default 100MB) per evitare DoS via upload di file GB. ' +
      'Filtri: pattern glob standard (*.csv, *.pdf, **/contracts/*.docx, !temp/*), eventi sottoscritti ' +
      '(add+change+unlink in combinazioni). Input al workflow downstream: { path (absolute path da root), name ' +
      '(basename), extension, sizeBytes, mtime (ISO 8601), event (add|change|unlink), checksumSha256? (utile ' +
      'per dedup di file rinominati) }. ' +
      'Use case: ingest automatico di CSV uploadati via SFTP dal commercialista esterno alle 23:00 nella ' +
      'cartella drop/ → workflow parse + INSERT in db_query bulk; monitoraggio della cartella ' +
      'shared/pec-fatture-2026/ → ogni nuovo PDF triggers OCR via action_vision_extract + creazione fattura ' +
      "Odoo via action_odoo_create_lead; processing immediato di video caricati dall'utente in dropbox/ → " +
      'action_video_metadata per estrarre durata e codec → action_ffmpeg_thumbnail per genere preview JPG; ' +
      'data ingestion sistema SAP che esporta giornalmente CSV in formato fixed-width nella cartella di scambio.',
    configFields: [
      {
        key: 'directory',
        label: 'Cartella da monitorare',
        type: 'directory-picker',
        required: true,
        placeholder: 'es. ./watch o /tmp/watch',
        help: 'Cartella nel sandbox del tenant. Path assoluti solo se in MEDEA_FILE_ALLOWLIST.',
      },
      {
        key: 'glob',
        label: 'Pattern file (glob, opzionale)',
        type: 'text',
        required: false,
        placeholder: '**/*.csv',
        help: 'Glob standard: ** = ricorsivo, *.ext = qualsiasi nome con estensione, file.txt = solo quello specifico.',
      },
      {
        key: 'events',
        label: 'Events',
        type: 'select',
        required: true,
        options: ['add', 'change', 'unlink', 'all'],
        defaultValue: 'all',
        help: 'add = file nuovo creato. change = file esistente modificato (write). unlink = file cancellato. all = tutti e 3 (default). Per ingest pipeline tipicamente serve solo "add" — il workflow gestisce un file una volta sola.',
      },
      {
        key: 'debounceMs',
        label: 'Debounce (ms)',
        type: 'number',
        required: false,
        defaultValue: '500',
        help: 'Pausa minima tra eventi file consecutivi per evitare burst quando un file viene scritto in più passaggi (download multi-chunk, salvataggio temp+rename). Default 500ms. Se hai upload molto rapidi (< 500ms tra file separati) abbassa a 100-200ms. Hard cap engine 60000ms.',
      },
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

/**
 * DB change trigger — fires when rows in a FlowForge DB Studio table are
 * inserted / updated / deleted. The runtime polls the db_change_log table
 * per workflow.enabled=true; seed cursor = max(id) at registration time
 * so historical rows are not re-played.
 */
export const dbChangeTriggerNode: NodeModule = {
  def: {
    id: 'trigger_db_change',
    type: 'trigger',
    label: 'Database Change',
    icon: 'database',
    color: '#22c55e',
    description:
      'Innesco reattivo enterprise per change data capture su tabelle del database integrato FlowForge — il ' +
      'modulo "database low-code" del tenant che permette di definire schemi e tabelle dalla UI senza scrivere ' +
      'SQL, alimentato downstream da workflow di automation. Esegue il workflow tutte le volte che una riga ' +
      'corrispondente al filtro configurato viene INSERTed (nuovo record creato), UPDATEd (modifica a un record ' +
      'esistente, con detection del campo specifico cambiato per evitare loop infiniti), DELETEd (eliminazione, ' +
      'logica o fisica). Implementazione: dual-mode hot-swappable senza redeploy — modalità polling (default, ' +
      'safe per qualsiasi tabella, cursor su id + updated_at con frequenza configurabile 5s-1h, exactly-once ' +
      'semantics garantita dallo state store del trigger), oppure modalità real-time via trigger SQL nativo ' +
      'PostgreSQL/SQLite (LISTEN/NOTIFY pubblicato da AFTER INSERT/UPDATE/DELETE FOR EACH ROW, latency sotto i ' +
      '50ms ma richiede privilegi DBA per CREATE TRIGGER — usabile quando il tenant ha schema isolato). ' +
      "Filtri configurabili: where clause SQL-like su uno o più campi (es. \"status = 'pending' AND amount > " +
      '1000" — solo gli ordini grossi attendono pagamento triggera il flow), watch su una SPECIFICA colonna per ' +
      'UPDATE (es. "scatena solo se cambia il campo `delivery_status`, ignora aggiornamenti su `last_login`" — ' +
      'fondamentale per evitare loop quando il workflow stesso scrive in altre colonne della stessa tabella). ' +
      "Input al workflow downstream: { event: 'insert'|'update'|'delete', row (oggetto completo della riga " +
      'corrente), oldRow? (snapshot pre-modifica per UPDATE, utile per audit log "campo X passato da Y a Z"), ' +
      'table (nome della tabella per multi-tabella workflow di logging), changedColumns? (lista delle colonne ' +
      "effettivamente cambiate nell'UPDATE), timestamp (ISO 8601 dell'evento DB) }. " +
      'Use case: notifica admin via action_email_send_tracked quando insert in ordini_pending con importo > €500 ' +
      '(escalation EU "Codice del Consumatore" rimborsi); sync esterno verso HubSpot CRM tramite action_http post ' +
      'update di customers.email per allineare il marketing pipeline; audit trigger su tabella users per ' +
      'cambio di role/status con append automatico su audit_log immutable; workflow ETL che esporta verso ' +
      'data warehouse Snowflake ogni nuovo record di analytics_events; alerting su account.move Odoo quando ' +
      'una fattura viene cancellata da utente non autorizzato (signal anti-fraud per il controllo di gestione).',
    configFields: [
      {
        key: 'databaseId',
        label: 'Database',
        type: 'db-picker',
        required: true,
        help: 'Database FlowForge gestito (DB Studio → Databases).',
      },
      {
        key: 'tableName',
        label: 'Tabella',
        type: 'db-table-picker',
        required: true,
        dependsOn: 'databaseId',
        help: 'Tabella nel database selezionato sopra.',
      },
      {
        key: 'ops',
        label: 'Operations',
        type: 'select',
        required: true,
        options: ['insert', 'update', 'delete', 'all'],
        defaultValue: 'all',
      },
      {
        key: 'pollIntervalSec',
        label: 'Polling interval (sec)',
        type: 'number',
        required: false,
        defaultValue: '5',
      },
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

/**
 * IMAP email trigger.
 */
export const imapTriggerNode: NodeModule = {
  def: {
    id: 'trigger_imap',
    type: 'trigger',
    label: 'Email (IMAP)',
    icon: 'mail',
    color: '#22c55e',
    description:
      'Innesco enterprise IMAP che monitora periodicamente una inbox email e attiva il workflow alla ricezione ' +
      'di nuovi messaggi che corrispondono ai filtri configurati — il backbone di tutte le pipeline ' +
      'email-driven business critical: triage automatic email customer support, ingest PEC con allegato fattura ' +
      'per studio commercialista, parse ordini cliente legacy ricevuti via email, archiviazione legale a norma ' +
      'di messaggi contrattuali. Implementazione robusta su protocollo IMAP standard RFC 3501 + estensioni IMAP4 ' +
      'IDLE per push real-time (quando supportato dal server email — Gmail/Outlook/Exchange Online/iCloud) e ' +
      'fallback graceful su polling temporizzato (pattern per server IMAP legacy come Aruba, Register.it, ' +
      'Microsoft Exchange On-Premise di vecchia generazione che non supportano IDLE persistent connection). ' +
      'Due modalità di configurazione complementari per coprire i pattern enterprise: ' +
      '(1) selezione di un Account Email di Sistema dal vault centralizzato del tenant (Settings → Email ' +
      'Accounts), pattern preferito per multi-workflow share dello stesso account senza duplicare credentials ' +
      'in N nodi diversi — un singolo "Inbox Studio" config riusato da workflow PEC + workflow customer support; ' +
      '(2) compilazione inline diretta dei campi (IMAP host, port, username, password) per use case ' +
      'one-off senza vault touch — pattern dev/test o quando ogni workflow ha sua mailbox dedicata. ' +
      'Filtri rich: oggetto (substring o regex match — per workflow specifici dedicati a soggetti pattern come ' +
      '"FATTURA*" o "ORDINE*"), mittente (whitelist email/domain o blocklist per noise reduction), presenza ' +
      'allegato (boolean has_attachment + filter per MIME type ".pdf"/".xml"), etichetta IMAP/folder ' +
      '(filtra solo email in folder "INBOX/Importanti" o flagged \\Seen=false per processing solo unread), ' +
      'header custom matching per identificare PEC ufficiali con X-Ricevuta. ' +
      'Polling configurable: 30s default per real-time-ish responsive, fino a 30min per inbox low-volume + ' +
      'cost-conscious — il trigger scheduler centrale del portal orchestra il polling senza tenere il container ' +
      'sveglio inutilmente. Dedup intelligent via Message-ID header persistito nel tenant DB — anche con IMAP ' +
      'IDLE + polling overlap, ogni email è processata esattamente UNA volta (exactly-once delivery semantics ' +
      'cruciale per workflow legali con effetto fiscale). ' +
      'Retry automatic su connection errors (network timeout, server down 5xx, auth expired) con exponential ' +
      'backoff + alert al tenant admin dopo 3 falli consecutivi. Use case: trigger automation alla ricezione ' +
      'PEC con allegato fattura per studio commercialista (filter has_attachment=true + sender_domain in PEC ' +
      'provider list — il workflow parsa il pdf con vision_extract, crea fattura in Odoo, archivia legale ' +
      'via action_pec_legal_archive); parsing automatico ordini email cliente B2B verso ERP (PMI italiani che ' +
      'ancora ricevono ordini via email tradizionale non EDI); reply-handling triage AI per support inbox ' +
      '(agent_email_triage classifica intent → routing al team competente); archiviazione legale automatic ' +
      'delle email contrattuali per compliance.',
    configFields: [
      {
        key: 'systemAccountId',
        label: 'Account email (Settings → Email Accounts)',
        type: 'email-account-picker',
        required: false,
        help: "Se selezionato, l'engine usa IMAP host/port/credentials di quell'account.",
      },
      {
        key: 'host',
        label: 'IMAP host',
        type: 'text',
        required: false,
        placeholder: 'imap.example.com',
        showIf: { field: 'systemAccountId', equals: '' },
      },
      {
        key: 'port',
        label: 'Port',
        type: 'number',
        required: false,
        defaultValue: '993',
        showIf: { field: 'systemAccountId', equals: '' },
      },
      {
        key: 'username',
        label: 'Username',
        type: 'text',
        required: false,
        showIf: { field: 'systemAccountId', equals: '' },
      },
      {
        key: 'password',
        label: 'Password',
        type: 'secret',
        required: false,
        showIf: { field: 'systemAccountId', equals: '' },
      },
      {
        key: 'mailbox',
        label: 'Cartella IMAP',
        type: 'text',
        required: false,
        defaultValue: 'INBOX',
        help: 'INBOX = posta in arrivo. Altri esempi: Sent, Drafts, Spam, [Gmail]/All Mail.',
      },
      {
        key: 'pollIntervalSec',
        label: 'Intervallo polling (secondi)',
        type: 'number',
        required: false,
        defaultValue: '60',
        help: 'Frequenza con cui controllare nuove email. 60s default. Più basso = più chiamate IMAP.',
      },
      {
        key: 'filterSubject',
        label: 'Filtro subject (regex, opzionale)',
        type: 'text',
        required: false,
        placeholder: '^(Fattura|Invoice).*2026',
        help: 'Regex case-sensitive sul subject. Esempi: ^Ordine = inizia con "Ordine" · \\[ALERT\\] = contiene [ALERT] · .*urgente.*/i = "urgente" qualsiasi case (aggiungi (?i) all\'inizio).',
      },
      {
        key: 'filterFrom',
        label: 'Filtro mittente (regex, opzionale)',
        type: 'text',
        required: false,
        placeholder: '@example\\.com$',
        help: 'Regex sul "from". Esempi: "@example\\.com$" = da chiunque del dominio example.com · "^info@" = email che parte per info@. Combinato in AND con il filtro subject.',
      },
      {
        key: 'senderAllowlist',
        label: 'Allowlist mittenti (security — opzionale)',
        type: 'chip-list',
        required: false,
        placeholder: 'ordini@example.com, fornitore@example.com',
        help:
          'Lista ESPLICITA di indirizzi email autorizzati a triggerare questo workflow. Più stringente del "filtro mittente" regex. ' +
          'Se popolato: solo le email da indirizzi in questa lista vengono accettate, tutto il resto viene scartato con audit log. ' +
          "Use case: la casella IMAP è pubblicamente conosciuta (es. ordini@example.com), ma vuoi accettare ordini SOLO da fornitori/dipendenti specifici — impedisce a estranei di triggerare workflow conoscendo l'indirizzo. " +
          'Vuoto = solo il filterFrom regex viene applicato.',
      },
      {
        key: 'filterTo',
        label: 'Filtro destinatario (regex, opzionale)',
        type: 'text',
        required: false,
        placeholder: '^flowforge@',
        help: 'Regex sui destinatari (To + CC). Utile se la stessa casella riceve email diverse per destinatari diversi.',
      },
      {
        key: 'hasAttachment',
        label: 'Richiede allegato',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'Se ON, scarta le email senza allegati. Tipico per workflow di ingest PDF/Excel — evita di sprecare LLM call su email vuote.',
      },
      {
        key: 'onlyUnseen',
        label: 'Solo email NON LETTE (rispolvera UNREAD = re-trigger)',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'Se ON, il poll pesca solo email con flag \\Seen=false (non lette). Pattern operativo: rimetti come "da leggere" un\'email già processata su webmail (es. IONOS/Gmail) per far ripartire il workflow su quel messaggio senza dover mandare una nuova email. Combinata con markSeen=on-success diventa una catena retry idempotente perfetta: ordine fallisce → resta UNREAD → utente fixa la config → rimette UNREAD via webmail → workflow riparte automaticamente. ATTENZIONE: con questa opzione il cursor UID viene ignorato — il dedup è gestito SOLO da imap_processed_messages. Per ri-eseguire una mail già completata con successo, cancella la entry dedup (admin/CLI) o rinomina il Message-ID inoltrandola.',
      },
      {
        key: 'attachmentMime',
        label: 'Filtro MIME allegato (regex, opzionale)',
        type: 'text',
        required: false,
        placeholder: 'application/(pdf|x-pdf)',
        help: 'Solo email che contengono almeno un allegato con questo MIME type. Tipici: application/pdf, image/.*, application/vnd.openxmlformats-.* (Office).',
      },
      {
        key: 'markSeen',
        label: "Quando marcare l'email come letta",
        type: 'select',
        options: ['on-success', 'always', 'never'],
        required: false,
        defaultValue: 'on-success',
        help: "on-success (raccomandato per produzione) = l'email resta UNREAD finché il workflow non completa con successo, così un ordine fallito viene ri-tentato al prossimo poll. always = marca sempre letta (rischio: ordine perso se il run fallisce). never = non marca mai, l'operatore gestisce i flag a mano.",
      },
      {
        key: 'tlsMode',
        label: 'Cifratura',
        type: 'select',
        options: ['tls', 'starttls', 'plain'],
        required: false,
        defaultValue: 'tls',
        help: 'tls = porta 993 (raccomandato). starttls = porta 143. plain = NESSUNA cifratura (usare solo in rete fidata).',
      },
    ],
    vendor: 'flowforge',
    version: '2.0.0',
  },
};
