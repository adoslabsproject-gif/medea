/**
 * Community SaaS batch — 6 nodi top-richiesta n8n parity:
 *  community_google_sheets — Sheets API v4 (read/write/append rows)
 *  community_discord — Discord Webhook + Bot API (send message)
 *  community_airtable — REST API v0 (list/create/update records)
 *  community_trello — REST API (list/create cards + lists + boards)
 *  community_calendly — REST API v2 (list events + invitees + create invitee)
 *  community_typeform — Forms API + Responses API (read responses, filter)
 *
 * Pattern: ogni nodo dichiara NodeDef qui + executor in
 * apps/engine/src/executors/integrations/<provider>.ts.
 */
import type { NodeModule } from '../types.js';

const COMMON_LABEL_FIELD = {
  key: 'integrationLabel',
  label: 'Etichetta credenziali (opzionale)',
  type: 'text' as const,
  required: false,
  placeholder: 'Default account',
  help: 'Per gestire più account dello stesso provider. Lascia vuoto per il default.',
};

export const communityGoogleSheetsNode: NodeModule = {
  def: {
    id: 'community_google_sheets',
    type: 'action',
    label: 'Google Sheets',
    icon: 'table',
    color: '#0f9d58',
    description:
      'Connettore enterprise per Google Sheets — il SaaS spreadsheet di Google con 900M+ MAU integrato in ' +
      'Workspace, alternativa cloud-native a Excel desktop ampiamente usato in startup, agency, team B2B che ' +
      'preferiscono la collaboration real-time + sharing semplificato a un DB enterprise — via Sheets API v4 ' +
      'ufficiale OAuth2. Quattro operazioni atomiche coprono il ciclo read/write completo: ' +
      'getValues (legge un range A1 notation tipo "Foglio1!A1:D100" oppure "Vendite!A:E" range aperto fino in ' +
      'fondo, ritorna array 2D di valori), updateValues (sovrascrive idempotent un range specifico — pattern ' +
      'safe per sync dove vogliamo controllo esatto della destinazione), appendValues (insert in fondo allo ' +
      'sheet auto-detecting la prima riga libera — pattern naturale per logging incrementale di eventi), ' +
      'batchGet (multi-range in singola request per ridurre roundtrip su sheet con multipli area da leggere ' +
      'contemporaneamente). ' +
      "Auth via OAuth2 portal-centric pattern di FlowForge: l'utente fa OAuth consent flow una sola volta da " +
      'Settings → Integrations → Google Sheets, e il portal centrale (NON il container tenant) gestisce il ' +
      'refresh token + emette access token short-lived (3600s default Google OAuth) al runtime via JWE handoff ' +
      '5min — questo pattern enterprise (vedi memory project_oauth_multi_tenant_portal_centric) evita di ' +
      "richiedere consent ad ogni run e centralizza il vault credenziali. Auto-refresh dell'access_token su " +
      "401 con 1 retry trasparente — l'utente non vede mai expire né deve fare manual re-auth. " +
      'Schema cell types: il nodo preserva i tipi nativi Google Sheets — numeri restano numeric (non ' +
      'stringificati), date in formato Excel serial number convertite a Date object JavaScript, formule (es. ' +
      '"=SUM(A1:A10)") preservate come formule durante updateValues (la cella resta formula, non valore ' +
      'calcolato), formatting (currency €, percent, date format) preservato server-side da Google. ' +
      'Rate limit Google Sheets API v4: 100 req/100sec per project/user (quota generosa per uso interattivo, ' +
      'condivisa col resto delle Google APIs dello stesso project), 60 RPM per user — il nodo gestisce 429 ' +
      'con Retry-After header + backoff exponential automatico. ' +
      'Output: { rows (array 2D di [row][col] string|number|null), range (A1 notation finale), updatedCells? ' +
      '(count per operazioni write), spreadsheetId, sheetTitle, sheetGid?, lastModifiedTime }. ' +
      'Use case: ingest CSV → Google Sheet per analisi business dal team marketing (CSV upload via ' +
      'trigger_file_watch → parse → batchUpdate del Sheet target "Marketing_Leads_Master"); sync KPI ' +
      'dashboard real-time dove i numeri vengono calcolati da workflow trigger_cron + aggregate + ' +
      'updateValues su sheet visualized in Looker Studio; logging eventi workflow su sheet condiviso col team ' +
      '(audit trail soft-light, non-DB grade ma sufficiente per use case operativi); ETL semplice senza data ' +
      'warehouse pesante (sync da N source come Stripe/HubSpot/Calendly → un Google Sheet "tutto in uno" ' +
      'che il CFO consulta via Web); backup leggero di record DB critici per audit consumabile da ' +
      'stakeholder non-tech che hanno solo Google account ma non accesso al DB diretto.',
    configFields: [
      {
        key: 'operation',
        label: 'Operazione',
        type: 'select',
        required: true,
        options: ['getValues', 'updateValues', 'appendValues', 'batchGet'],
        defaultValue: 'getValues',
      },
      {
        key: 'spreadsheetId',
        label: 'Spreadsheet ID',
        type: 'expression',
        required: true,
        placeholder: '1AbcDef... (dalla URL del foglio)',
        help: 'ID Spreadsheet (parte tra /d/ e /edit nella URL). Supporta {{input.spreadsheetId}}.',
      },
      {
        key: 'range',
        label: 'Range A1 notation',
        type: 'expression',
        required: true,
        placeholder: 'Foglio1!A1:D100',
        help: 'Range A1 (es. "Foglio1!A1:D100" o solo "Foglio1" per intera scheda).',
      },
      {
        key: 'valuesJson',
        label: 'Values (JSON array of arrays)',
        type: 'expression',
        required: false,
        placeholder: '[["A1","B1"],["A2","B2"]]',
        help: 'Solo per updateValues/appendValues. Array 2D di valori.',
      },
      {
        key: 'valueInputOption',
        label: 'Modo input',
        type: 'select',
        required: false,
        options: ['RAW', 'USER_ENTERED'],
        defaultValue: 'USER_ENTERED',
        help: 'RAW = come testo grezzo. USER_ENTERED = parsa formula/date/numeri come la UI.',
      },
      COMMON_LABEL_FIELD,
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

export const communityDiscordNode: NodeModule = {
  def: {
    id: 'community_discord',
    type: 'action',
    label: 'Discord',
    icon: 'message-square',
    color: '#5865f2',
    description:
      'Connettore enterprise per Discord — la piattaforma di comunicazione real-time nata gaming e ora ' +
      'standard de-facto per community tech, open-source maintainer team, developer relations, web3/crypto ' +
      'project, e DevOps stack alternative a Slack (oltre 150M MAU, 19M server attivi). Due modalità operative: ' +
      '(1) Webhook mode — il modo SEMPLICE per inviare messaggi senza creare un bot; un webhook URL ' +
      "identifica univocamente il canale destinazione (l'admin Discord lo genera in Server Settings → " +
      'Integrations → Create Webhook, scegliendo il channel target + icona + nome custom del sender), nessuna ' +
      'autenticazione OAuth/Bot Token richiesta, rate-limit 5 msg/sec per webhook che il nodo gestisce con ' +
      'backoff exponential automatico su 429; (2) Bot API mode — il modo AVANZATO con Bot Token (formato ' +
      'Bot xxxxxxxx con privileged intents) che sblocca features impossibili via webhook: aggiungere reactions ' +
      'a un messaggio esistente, creare reply in thread (i thread sono sub-conversation Discord 2022+), DM ' +
      'diretti ai user, slash commands custom, presence updates del bot, gestione voice channel join. ' +
      'Supporto pieno del payload Discord moderno: plain text con markdown subset (bold **, italic *, code `, ' +
      'codeblock ```, spoiler ||), embed cards (la feature kilattributo Discord — rich preview con title + ' +
      'description + color + thumbnail + fields strutturati + footer + author block), file attachments multi ' +
      '(fino a 10 file × 25MB per messaggio in Tier 0 Boost server, 50MB Tier 2, 100MB Tier 3), mentions ' +
      '(@user via user_id, @role via role_id, @here per online member del canale, @everyone con permission ' +
      'check). ' +
      'Output: { messageId (snowflake Discord unique), channelId, sentAt (ISO 8601), webhookOk, mentionedUsers, ' +
      'attachmentUrls? (per replay/log) }. ' +
      'Use case: notify team developer su run workflow CI falliti con embed color rosso + link al run viewer ' +
      'FlowForge dashboard; deploy alert nel canale #devops con embed status verde "✅ Deploy 20260606_123117 ' +
      'OK" e changelog inline; community announcement automatico nel canale #news post-pubblicazione blog post ' +
      'sul sito (sync MDX + webhook Discord); monitoraggio uptime con embed color-coded (rosso > 5xx, giallo ' +
      'p95 > 3s, verde sano) per il dashboard SRE; thread reply per discussion gruppo support: il bot apre un ' +
      "thread per ogni ticket nuovo Zendesk e linka nel thread l'update di status, evitando di intasare il " +
      'canale principale con messaggi sparsi; gaming community che lancia eventi automatic con countdown ' +
      'timer e role mentions per @evento-mensile.',
    configFields: [
      {
        key: 'mode',
        label: 'Modalità',
        type: 'select',
        required: true,
        options: ['webhook', 'bot'],
        defaultValue: 'webhook',
        help: 'webhook = semplice (URL + nessuna auth). bot = avanzato (Bot Token + canali multipli).',
      },
      {
        key: 'webhookUrl',
        label: 'Webhook URL',
        type: 'expression',
        required: false,
        placeholder: 'https://discord.com/api/webhooks/...',
        help: 'Solo per mode=webhook. Crea da: Server Settings → Integrations → Webhooks.',
      },
      {
        key: 'channelId',
        label: 'Channel ID (Bot mode)',
        type: 'expression',
        required: false,
        placeholder: '1234567890',
        help: 'Solo per mode=bot. Channel ID Discord (click destro su canale → Copia ID).',
      },
      {
        key: 'content',
        label: 'Messaggio',
        type: 'expression',
        required: false,
        placeholder: '🔔 Nuovo ordine #{{input.orderId}} per {{input.amount}}€',
        help: 'Plain text + markdown Discord. Max 2000 char. Supporta @user/@role/@everyone (se permessi).',
      },
      {
        key: 'embedJson',
        label: 'Embed (JSON, opzionale)',
        type: 'expression',
        required: false,
        placeholder: '{"title":"...", "color":3447003, "fields":[...]}',
        help: 'Embed Card Discord format. Max 6000 char tot. Usa Embed Visualizer per preview.',
      },
      COMMON_LABEL_FIELD,
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

export const communityAirtableNode: NodeModule = {
  def: {
    id: 'community_airtable',
    type: 'action',
    label: 'Airtable',
    icon: 'database',
    color: '#fcb400',
    description:
      'Connettore enterprise per Airtable — la piattaforma low-code database+spreadsheet ibrida nata 2012 a ' +
      'San Francisco con 300k+ paying customer di startup, agency, marketing team, education che la usano come ' +
      'rapid prototyping di applicazioni database-driven con UI native (grid, kanban, calendar, gallery view) ' +
      'senza dover scrivere codice né configurare uno schema PostgreSQL. Cinque operazioni atomiche CRUD via ' +
      'REST API v0 ufficiale: listRecords (read con filterByFormula in dialetto Airtable formula syntax stile ' +
      'spreadsheet "AND({Status}=\'Open\',{Priority}>1)", sort multi-criteria, fields whitelist per ridurre ' +
      'payload, pagination cursor-based), getRecord (fetch puntuale by record_id rec0123456789ABC), ' +
      'createRecord (insert con typecast option che permette ad Airtable di coercere "Closed" string al ' +
      'select_field option corretto evitando errori), updateRecord (patch atomic dei field specificati, gli ' +
      'altri restano invariati — diverso da PUT che resetterebbe i field non-specificati), deleteRecord. ' +
      "Auto-pagination per listRecords: l'API Airtable cap a 100 record/page e usa offset opaque cursor — il " +
      'nodo automaticamente itera fino a recuperare TUTTI i record corrispondenti al filtro (con safety cap ' +
      'default 10000 totali per evitare runaway su table giganti), unificando in un singolo array di output ' +
      'pronto per loop downstream. ' +
      'Auth via Personal Access Token (formato patxxxxxxxx.xxxxxxxx generato da admin in Settings → Developer ' +
      'Hub → Personal Access Tokens con scope schema.bases:read + data.records:read|write granular per base) ' +
      'stored nel vault integration FlowForge. Multi-base supportato (un tenant FlowForge che gestisce 3 base ' +
      'Airtable diverse per agency che serve N cliente). ' +
      'Rate limit Airtable: 5 req/sec per base in Plus/Pro plan, 50 req/sec in Enterprise — il nodo gestisce ' +
      '429 con Retry-After header + backoff exponential automatico. Header X-Airtable-Application-ID tracked ' +
      'per debug attribuzione delle quote. ' +
      'Output: { records: [{ id, fields: { [name]: value }, createdTime }], record?, deleted?, recordsCount, ' +
      'pagesScanned }. ' +
      'Use case: lead capture da form web (Typeform/trigger_form) → createRecord nella base "CRM Leads" con ' +
      'campos Name+Email+Company+Source+CreatedAt, opzionale typecast=true se Source viene da dropdown opzioni ' +
      'pre-definite; sync inventory bidirezionale e-commerce↔Airtable per piccoli merchant che usano Airtable ' +
      'come stockmaster invece di un ERP completo (updateRecord di stock_qty quando arriva ordine Stripe); ' +
      'progetti Kanban automatico (move card by status — update record\'s Status field da "Todo" a "In Progress" ' +
      'quando un workflow event triggers, Airtable native auto-aggiorna la Kanban view); survey responses ' +
      'aggregate per analytics market research con listRecords + logic_aggregate (count per region, avg ' +
      'satisfaction score); media library con metadata + attachment field per asset management leggero (upload ' +
      'foto prodotto via API attachment + metadata strutturata).',
    configFields: [
      {
        key: 'operation',
        label: 'Operazione',
        type: 'select',
        required: true,
        options: ['listRecords', 'getRecord', 'createRecord', 'updateRecord', 'deleteRecord'],
        defaultValue: 'listRecords',
      },
      {
        key: 'baseId',
        label: 'Base ID',
        type: 'expression',
        required: true,
        placeholder: 'appXXXXXXXXXX',
        help: 'Base ID Airtable (dalla URL: airtable.com/<baseId>/...).',
      },
      {
        key: 'tableName',
        label: 'Table name o ID',
        type: 'expression',
        required: true,
        placeholder: 'Tasks o tblXXXXXXXXXX',
        help: 'Nome tabella (URL-encoded) o table ID.',
      },
      {
        key: 'recordId',
        label: 'Record ID (get/update/delete)',
        type: 'expression',
        required: false,
        placeholder: 'recXXXXXXXXXX',
      },
      {
        key: 'fieldsJson',
        label: 'Fields (JSON, per create/update)',
        type: 'expression',
        required: false,
        placeholder: '{"Name":"Task 42","Status":"In progress","Owner":"Alice"}',
      },
      {
        key: 'filterByFormula',
        label: 'Filter formula (listRecords)',
        type: 'expression',
        required: false,
        placeholder: "AND({Status}='Open',{Priority}>1)",
        help: "Airtable formula syntax. Es: AND({Status}='Done',IS_AFTER({CreatedAt}, '2026-01-01')).",
      },
      {
        key: 'maxRecords',
        label: 'Max record da scansionare',
        type: 'number',
        required: false,
        defaultValue: '1000',
      },
      COMMON_LABEL_FIELD,
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

export const communityTrelloNode: NodeModule = {
  def: {
    id: 'community_trello',
    type: 'action',
    label: 'Trello',
    icon: 'columns',
    color: '#0079bf',
    description:
      'Connettore enterprise per Trello (la piattaforma kanban di Atlassian con 50M+ utenti, semplicissima da ' +
      'usare per team non-tecnici che vogliono visual project management senza la complessità di Jira — ' +
      'Power-Up automation native + REST API stabile dal 2012 + Butler workflows interno) via REST API ' +
      'ufficiale v1. Cinque operazioni atomiche coprono il ciclo card+board: createCard (inserisce nuova card ' +
      'in una list specifica della board con title, description markdown, due date, label assignment, member ' +
      'assignment), updateCard (la più potente operazione — sposta tra list per movimento kanban "Open" → "In ' +
      'Progress" → "Done", cambia labels, cambia due date, aggiunge/rimuove members, archivia/disarchivia), ' +
      'addComment (markdown body con @mentions @username sintassi Trello che notificano il member, link ' +
      'embedded auto-rendered come preview card), listCards (paginated con filter su list specifica oppure ' +
      'tutta la board, utile per dashboard interne), getBoardLists (introspezione dello schema della board ' +
      'per discovery dinamico delle list disponibili — pattern auto-config per workflow che lavorano su board ' +
      'mutevoli). ' +
      "Auth via doppio token: API Key (formato 32 char hex public-safe, ottenuto dall'admin Trello in " +
      'https://trello.com/app-key e referenziato come integration label nel vault FlowForge) + Token OAuth1 ' +
      '(generato dall\'API Key con click su "Generate a Token" che apre l\'OAuth flow di authorization e ' +
      'ritorna il bearer token user-specific). Stessa coppia (key, token) usata in tutte le request come query ' +
      'string `?key=K&token=T`. Multi-account supportato (un tenant FlowForge che orchestra 5 board di team ' +
      'diversi). ' +
      'Rate limiting Trello: 100 req/10sec per token + 300 req/10sec per API key (aggregati su tutti i token) ' +
      '— il nodo gestisce 429 con Retry-After exponential backoff + jitter, cache 30s delle listIds e boardIds ' +
      'discoverable per ridurre roundtrip ridondanti nel stesso workflow. ' +
      'Output: { card? (object completo Trello con id, idShort, name, desc, due, dueComplete, idList, idBoard, ' +
      'labels, members, shortUrl, dateLastActivity), cardId?, listId?, boardId?, cards[]? (array per ' +
      'listCards), commentId? (per addComment) }. ' +
      'Use case operativi reali: bug report → Trello card automatica nella board "Bug Tracking" list "Triage" ' +
      'da incident webhook Sentry con title summary + description markdown contenente stack trace + due date ' +
      '+3gg per SLA; lead form Typeform → card "New lead {{first_name}}" in board "Sales Pipeline" list "Da ' +
      'contattare" con due date +7gg per follow-up call e label color-coded per source ("linkedin", "google_ads", ' +
      '"referral"); CI fail webhook → comment automatic su card della feature corrispondente con log link e ' +
      '@mention del responsabile assegnato; PR merged GitHub event → move card "In Code Review" → "Done" + ' +
      'addComment "✅ PR #123 merged by @reviewer at {{timestamp}}"; daily standup async — listCards di tutte ' +
      'le card "In Progress" per generare summary report via agent_business_summarizer.',
    configFields: [
      {
        key: 'operation',
        label: 'Operazione',
        type: 'select',
        required: true,
        options: ['createCard', 'updateCard', 'addComment', 'listCards', 'getBoardLists'],
        defaultValue: 'createCard',
      },
      {
        key: 'listId',
        label: 'List ID (per createCard)',
        type: 'expression',
        required: false,
        placeholder: '5fa1e2d3c4b5a6...',
        help: 'List ID dove creare la card. Get via getBoardLists.',
      },
      {
        key: 'cardId',
        label: 'Card ID (per update/comment)',
        type: 'expression',
        required: false,
      },
      {
        key: 'boardId',
        label: 'Board ID (per listCards/getBoardLists)',
        type: 'expression',
        required: false,
      },
      {
        key: 'name',
        label: 'Card name',
        type: 'expression',
        required: false,
        placeholder: 'Bug: login fails on Safari',
      },
      {
        key: 'desc',
        label: 'Card description',
        type: 'expression',
        required: false,
      },
      {
        key: 'due',
        label: 'Due date (ISO)',
        type: 'expression',
        required: false,
        placeholder: '2026-06-30T17:00:00Z',
      },
      {
        key: 'labels',
        label: 'Labels (CSV)',
        type: 'expression',
        required: false,
        placeholder: 'red,bug',
      },
      {
        key: 'commentText',
        label: 'Comment text (per addComment)',
        type: 'expression',
        required: false,
      },
      COMMON_LABEL_FIELD,
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

export const communityCalendlyNode: NodeModule = {
  def: {
    id: 'community_calendly',
    type: 'action',
    label: 'Calendly',
    icon: 'calendar',
    color: '#006bff',
    description:
      'Connettore enterprise per Calendly — la piattaforma SaaS di booking di appuntamenti più diffusa per ' +
      'sales team B2B, consulenti, coach, recruiter, customer success (10M+ utenti, 100k+ paying customer ' +
      'business) che permette di pubblicare un pubblico booking link "trova uno slot libero con me" eliminando ' +
      'le 5-6 email back-and-forth di scheduling — via REST API v2 ufficiale. Cinque operazioni atomiche ' +
      "gestiscono l'intero lifecycle del booking: listScheduledEvents (recupera elenco di appuntamenti " +
      'scheduled con filtri compound by user URI/organization URI/status active|cancelled/range di date ' +
      'min_start_time-max_start_time per dashboard analytics e sync incrementale), getEvent (fetch puntuale di ' +
      'un singolo event by URI univoco con metadata complete come location/duration/calendar_event_provider/' +
      "invitee_questions_and_answers), listInvitees (gli invitee dell'evento — solitamente 1 per 1-to-1 " +
      'meeting ma può essere N per group events), getInvitee (dettagli singolo invitee con email + nome + ' +
      'phone + answers ai prompt custom configurati dal Calendly admin nel form di booking), cancelEvent ' +
      '(cancellazione lato server con motivazione opzionale che notifica entrambe le parti via Calendly nativ). ' +
      "Auth via Personal Access Token formato eyJxxx (JWT generato da Calendly nell'admin dashboard Settings " +
      '→ Integrations → API & Webhooks → Personal Access Token, scope organization-wide o user-only), stored ' +
      'nel vault integration FlowForge accessibile via integrationLabel. Multi-account supportato per agenzie ' +
      'che gestiscono Calendly di N consulenti. ' +
      'Rate limit Calendly: 1000 req/h sustained per token (~16 RPS sustained, 30/sec burst), header ' +
      'X-RateLimit-Remaining trackato dal nodo per warning preventivo. Pagination automatica su listScheduledEvents ' +
      '(cursor-based "next_page_token") con cap default 500 events per workflow per evitare flood. ' +
      'Output: { events: [{ uri, name, start_time, end_time, status, location, invitees_counter, event_memberships }], ' +
      'invitees: [{ uri, email, name, phone?, status (active|canceled), questions_and_answers: [...], ' +
      'cancellation? }], event?, invitee?, cancelled? (boolean per cancelEvent operation) }. ' +
      'API docs ufficiali: developer.calendly.com/api-docs (v2 stable). ' +
      'Use case: sync new booking via webhook Calendly subscription → CRM lead automatic in HubSpot/Salesforce/' +
      'Odoo con properties popolate dalle questions custom del form (es. "company_size", "budget_range", ' +
      '"main_challenge") e LeadSource=Calendly; reminder workflow 24h pre-meeting che parte da trigger_cron ' +
      'check daily + listScheduledEvents filter su tomorrow + email reminder personalizzato + WhatsApp message ' +
      'opzionale con link Zoom incluso; no-show detection per ricalibrare il forecasting (event passato + ' +
      'invitee status active non transitato a confirmed via webhook canceled = candidate no-show, marca ' +
      'contact in CRM per analytics conversion rate); aggregate weekly bookings nel sales dashboard del manager ' +
      'team commerciale con breakdown per consulente e source; trigger di onboarding workflow al primo meeting ' +
      'closed-won → invio kit benvenuto + creazione progetto in Asana + Slack channel dedicato al cliente.',
    configFields: [
      {
        key: 'operation',
        label: 'Operazione',
        type: 'select',
        required: true,
        options: ['listScheduledEvents', 'getEvent', 'listInvitees', 'getInvitee', 'cancelEvent'],
        defaultValue: 'listScheduledEvents',
      },
      {
        key: 'userUri',
        label: 'User URI (scoped queries)',
        type: 'expression',
        required: false,
        placeholder: 'https://api.calendly.com/users/AAA...',
        help: 'Scoped a singolo user. Ottieni da /users/me.',
      },
      {
        key: 'eventUri',
        label: 'Event URI',
        type: 'expression',
        required: false,
        placeholder: 'https://api.calendly.com/scheduled_events/XXX',
      },
      {
        key: 'inviteeUri',
        label: 'Invitee URI',
        type: 'expression',
        required: false,
      },
      {
        key: 'status',
        label: 'Status filter',
        type: 'select',
        required: false,
        options: ['active', 'canceled', 'all'],
        defaultValue: 'active',
      },
      {
        key: 'minStartTime',
        label: 'Min start time (ISO)',
        type: 'expression',
        required: false,
        placeholder: '2026-06-05T00:00:00Z',
      },
      {
        key: 'maxStartTime',
        label: 'Max start time (ISO)',
        type: 'expression',
        required: false,
      },
      {
        key: 'cancelReason',
        label: 'Cancel reason (per cancelEvent)',
        type: 'expression',
        required: false,
        placeholder: 'Riprogrammato per richiesta cliente',
      },
      COMMON_LABEL_FIELD,
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

export const communityTypeformNode: NodeModule = {
  def: {
    id: 'community_typeform',
    type: 'action',
    label: 'Typeform',
    icon: 'clipboard-check',
    color: '#262627',
    description:
      'Connettore enterprise per Typeform — la piattaforma di form conversational design-first nata in ' +
      'Barcellona 2012 (2M+ paying customer) preferita da marketer e UX designer per la one-question-at-a-time ' +
      'interaction che produce 40% higher completion rate vs form tradizionali, integrazione massiccia con ' +
      'CRM/marketing automation tool, librerie di template ricchissime per ogni vertical (NPS survey, lead ' +
      'capture, job application, customer feedback, evento registration) — via Responses API + Forms API ' +
      'ufficiali. Cinque operazioni atomiche coprono il ciclo completo: listForms (elenco di tutti i form ' +
      "dell'account/workspace con metadata e analytics aggregate), getForm (definition completa di un form " +
      'specifico con tutti i field, branching logic, ending screens — utile per pre-validation o introspection ' +
      'dello schema), listResponses (filter compound by completion status partial/completed, range di date ' +
      'submitted_at, hidden fields query), getResponse (fetch puntuale di una singola response by response_id ' +
      'con tutte le answers e metadata calculated), deleteResponses (operazione di cancellazione GDPR-aware ' +
      'con audit trail). ' +
      "Auth via Personal Access Token (formato tfp_xxxxx generato dall'admin Typeform in Settings → Personal " +
      'tokens → Generate token con scope responses:read|write + forms:read) stored nel vault integration ' +
      'FlowForge. ' +
      'Auto-pagination per listResponses: usa cursor "after" + page_size 1000 max — il nodo automaticamente ' +
      'itera fino a recuperare TUTTE le response che matchano il filtro (con cap default 50000 totali per ' +
      'safety + memory), pattern naturale per sync incrementale del data warehouse. ' +
      'Rate limit Typeform: 4 req/sec per access token sustained, 60 req/min con burst — il nodo gestisce 429 ' +
      'con Retry-After header + backoff exponential automatico. ' +
      'Hidden fields support nativo: i hidden field passati come query string al form URL (es. ' +
      '?utm_source=google&customer_id=42) sono inclusi nelle response answers — pattern critico per attribuire ' +
      'la response al touchpoint marketing che ha generated il traffic e alla customer entity preesistente nel ' +
      'CRM. ' +
      'Output rich: { forms: [{ id, title, links, settings }], form?, responses: [{ response_id, submitted_at, ' +
      'landed_at, calculated, answers: [{ field, type, value, ref }], hidden, metadata }], total, page_count }. ' +
      'Use case operativi reali della pipeline marketing/HR: lead form Typeform "scopri quale piano fa per te" ' +
      '→ CRM HubSpot auto-import + dedup per email + lead scoring based on answers + assignment al sales rep ' +
      'corretto del territorio; NPS survey trimestrale → analytics dashboard real-time con avg per segment ' +
      '(customer tier, regione, vintage) e detect drop trimestre-su-trimestre come signal di churn risk; job ' +
      'application form per HR → Slack notify nel canale #hr-newapps + upload CV allegato su Google Drive + ' +
      'create Trello card "Review {{candidate_name}}" assegnata al recruiter manager; GDPR right-to-erasure ' +
      'workflow customer-driven (customer chiede cancellazione dati personali → workflow trova tutte le ' +
      'response Typeform con email match → deleteResponses → audit log immutable della cancellazione per ' +
      'compliance + email conferma al customer); webinar registration → automatic add a HubSpot list ' +
      '"webinar_attendees" + email confirmation con zoom link.',
    configFields: [
      {
        key: 'operation',
        label: 'Operazione',
        type: 'select',
        required: true,
        options: ['listForms', 'getForm', 'listResponses', 'getResponse', 'deleteResponses'],
        defaultValue: 'listResponses',
      },
      {
        key: 'formId',
        label: 'Form ID',
        type: 'expression',
        required: false,
        placeholder: 'abc123 (dalla URL admin Typeform)',
      },
      {
        key: 'responseId',
        label: 'Response ID',
        type: 'expression',
        required: false,
      },
      {
        key: 'completed',
        label: 'Solo completate',
        type: 'select',
        required: false,
        options: ['true', 'false', 'any'],
        defaultValue: 'true',
      },
      {
        key: 'sinceDate',
        label: 'Submitted since (ISO)',
        type: 'expression',
        required: false,
        placeholder: '2026-06-01T00:00:00Z',
      },
      {
        key: 'untilDate',
        label: 'Submitted until (ISO)',
        type: 'expression',
        required: false,
      },
      {
        key: 'pageSize',
        label: 'Page size',
        type: 'number',
        required: false,
        defaultValue: '50',
        help: 'Max 1000 per page (Typeform limit).',
      },
      COMMON_LABEL_FIELD,
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

export const communityShopifyNode: NodeModule = {
  def: {
    id: 'community_shopify',
    type: 'action',
    label: 'Shopify',
    icon: 'shopping-bag',
    color: '#96bf48',
    description:
      'Connettore enterprise per Shopify — la piattaforma e-commerce leader mondiale per SMB e mid-market ' +
      '(fondata 2006 a Ottawa, IPO 2015, 5M+ merchant attivi che processano $230B+ GMV annuo, base installata ' +
      'particolarmente forte in USA/EU/AUS per direct-to-consumer brands e drop-shipping store) via Admin ' +
      'REST API 2024-01 ufficiale. Quattro operazioni atomiche coprono il core retail flow: getOrder ' +
      '(recupera ordine specifico by orderId con tutti i line_items + customer + shipping_address + ' +
      'payment_status + fulfillment_status — pattern essenziale per ingest ordini downstream verso ERP/' +
      'gestionale italiano); createOrder (crea ordine manualmente o conferma un draft order precedentemente ' +
      "preparato — utile per use case omnichannel B2B dove l'ordine arriva via email o telefono e va inserito " +
      'in Shopify after-the-fact per consistency del data warehouse); listProducts (catalogo paginated fino ' +
      'a 250 item/request con cursor-based pagination per merchant con migliaia di SKU); createProduct ' +
      '(pubblica nuovo prodotto con multiple variants size/color, immagini galleria, metadata SEO, pricing ' +
      'tier-based per region o customer type, inventory tracking). ' +
      "Auth via Custom App Access Token (formato shpat_xxxxxxxx generato dall'admin Shopify in Apps → " +
      'Develop apps → Configure Admin API scopes — granular permission read_orders, write_orders, ' +
      'read_products, write_products per least-privilege) usato come header X-Shopify-Access-Token stored ' +
      'nel vault integration FlowForge. Multi-shop supportato (agency che gestisce 10 store Shopify diversi ' +
      'di N customer brand). ' +
      'Validation enterprise pre-API: shopDomain validato sintatticamente come regex strict per matching solo ' +
      '*.myshopify.com (anti injection di dominio arbitrario nel URL builder, evita classic SSRF via ' +
      'user-controlled shopDomain). ' +
      'Pipeline standard FlowForge: SSRF-safe gateway, circuit-breaker per-host dedicato (un outage su un ' +
      'shop NON blocca workflow di altri shop), retry exponential backoff su 5xx e 429 transitori. Rate ' +
      'limit Shopify: 2 req/sec sustained for Basic/Shopify plan, 4 req/sec for Advanced/Plus — il nodo ' +
      'gestisce header X-Shopify-Shop-Api-Call-Limit con throttle anticipato a 80% del cap per evitare hard ' +
      '429. ' +
      'Output: { orderId?, order? (con full object structure Shopify), products? (array paginated con ' +
      'cursor next_page_info), productId?, count? (totalCount when available), pageCursor? }. ' +
      'Use case enterprise italiani: sincronizza ordini Shopify verso gestionale italiano o Odoo per ' +
      'contabilità + magazzino unified (webhook order.created → workflow → action_odoo_create_lead in ' +
      'sale.order); crea automatic prodotti da feed XML fornitore (RSS o sftp drop → parse → loop → ' +
      'createProduct con immagini); notifica team su nuovo ordine via Slack/email con order summary ' +
      '+ link al admin Shopify; popola CRM HubSpot/Salesforce con customer al checkout per nurturing ' +
      "post-acquisto; genera fattura elettronica italiana SDI all'evasione dell'ordine (collega con il " +
      'modulo SDI/PEC del workflow stack); dashboard vendite real-time con metriche aggregate (cron orario ' +
      '+ listProducts + per-product analytics + push su Google Sheets management).',
    configFields: [
      {
        key: 'operation',
        label: 'Operazione',
        type: 'select',
        required: true,
        options: ['getOrder', 'createOrder', 'listProducts', 'createProduct'],
        defaultValue: 'getOrder',
      },
      {
        key: 'orderId',
        label: 'Order ID',
        type: 'expression',
        required: false,
        placeholder: '450789469',
        help: 'ID numerico ordine. Obbligatorio per getOrder. Supporta {{input.orderId}}.',
      },
      {
        key: 'orderJson',
        label: 'Order (JSON)',
        type: 'expression',
        required: false,
        placeholder: '{"line_items":[{"variant_id":447654529,"quantity":1}],"email":"x@y.it"}',
        help: 'Corpo ordine per createOrder (oggetto Shopify "order" senza wrapper).',
      },
      {
        key: 'productJson',
        label: 'Product (JSON)',
        type: 'expression',
        required: false,
        placeholder: '{"title":"T-Shirt","variants":[{"price":"19.90"}]}',
        help: 'Corpo prodotto per createProduct (oggetto Shopify "product" senza wrapper).',
      },
      {
        key: 'limit',
        label: 'Limit (listProducts)',
        type: 'number',
        required: false,
        defaultValue: '50',
        help: 'Max prodotti per listProducts (1-250).',
      },
      COMMON_LABEL_FIELD,
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

export const communityMailchimpNode: NodeModule = {
  def: {
    id: 'community_mailchimp',
    type: 'action',
    label: 'Mailchimp',
    icon: 'mail',
    color: '#ffe01b',
    description:
      'Connettore enterprise per Mailchimp — la piattaforma email marketing & marketing automation pioniere ' +
      'del settore (fondata 2001, acquisita da Intuit 2021 per $12B, 13M+ utenti registered + 2.5M+ paying ' +
      'customer business soprattutto SMB e creator) leader globale del consumer email marketing con feature ' +
      'rich per campagne ricorrenti, automation workflow, audience segmentation, analytics dettagliata, A/B ' +
      'testing — via Marketing API v3.0 ufficiale. Tre operazioni atomiche coprono il pattern di sync ' +
      'principale tra workflow business e Mailchimp audience: addMember (upsert idempotent del subscriber ' +
      "nella audience target — Mailchimp API richiede di passare il MD5 hash lowercase dell'email come " +
      'identifier per le operazioni member-level, il nodo computa automatic questo hash e lo usa per accesso ' +
      'PUT che è naturally idempotent — pattern critico per evitare duplicati su re-run del workflow), ' +
      'getMember (fetch dello stato iscrizione di un subscriber: subscribed, unsubscribed, pending, cleaned, ' +
      'transactional + valori dei merge fields custom come FNAME, LNAME, COMPANY, BIRTHDAY), addTag ' +
      '(applicazione di tag al subscriber per segmentation downstream nelle campagne — i tag sono il modo ' +
      'principale di Mailchimp di categorizzare audience oltre alle group/list-level fields). ' +
      'Auth via API Key formato unique 32-hex con suffix -us17 / -us12 / -eu1 / etc. che identifica il ' +
      "datacenter geografico del account Mailchimp (il nodo parse il suffix e construct correttamente l'URL " +
      'base API tipo https://us17.api.mailchimp.com/3.0/ — pattern Mailchimp che molti developer sbagliano), ' +
      'usato come HTTP Basic Auth username "anystring" + password=apiKey. Stored nel vault integration ' +
      'FlowForge. Multi-account supportato (un tenant FlowForge che gestisce 10 audience Mailchimp di N ' +
      'customer separati). ' +
      'Pipeline standard FlowForge: SSRF-safe gateway, circuit-breaker per-host dedicato (importante per ' +
      'multi-datacenter — un outage su us17 NON deve bloccare workflow di altro account su eu1), retry ' +
      'exponential backoff su 5xx + 429. Rate limit Mailchimp: 10 concurrent connection per API key + soft ' +
      'limit per minute (varies per account tier — Pro/Premium hanno cap più alti). ' +
      "Output: { memberId? (MD5 hash dell'email, sempre presente perché derivable), status? (subscription " +
      'state), member? (object completo per getMember), tagged? (boolean per addTag), email, datacenterUsed }. ' +
      'Use case: aggiungi lead da form/scraping alla newsletter aziendale (trigger_form submit → ' +
      'community_mailchimp addMember nella audience "Newsletter generale" con FNAME/LNAME merge fields ' +
      'mapped); sincronizza CRM HubSpot bidirezionale con audience Mailchimp (cron nightly + paginate dei ' +
      'contact HubSpot + upsert in Mailchimp audience corrispondente); tagga automatic contatti per ' +
      'comportamento (es. ordine pagato Stripe webhook → addTag "customer_paid_2026" per uso in trigger di ' +
      'campagna post-acquisto); double opt-in GDPR-compliant da workflow (subscriber status=pending → email ' +
      'di confirmation con link signed → su click → updateMember status=subscribed); nurturing automatico ' +
      'post-evento (webinar attendee → addTag "webinar_xyz_attended" che triggera drip campaign 7-day ' +
      'follow-up); sync iscritti bidirezionale con database tenant per analytics consolidata.',
    configFields: [
      {
        key: 'operation',
        label: 'Operazione',
        type: 'select',
        required: true,
        options: ['addMember', 'getMember', 'addTag'],
        defaultValue: 'addMember',
      },
      {
        key: 'listId',
        label: 'Audience ID (listId)',
        type: 'expression',
        required: true,
        placeholder: 'a1b2c3d4e5',
        help: 'Audience/List ID Mailchimp (Settings → Audience name and defaults). Supporta {{input.listId}}.',
      },
      {
        key: 'email',
        label: 'Email contatto',
        type: 'expression',
        required: true,
        placeholder: 'mario.rossi@example.it',
        help: 'Email del contatto. Usata come chiave idempotente (MD5 lowercase).',
      },
      {
        key: 'status',
        label: 'Stato iscrizione',
        type: 'select',
        required: false,
        options: ['subscribed', 'pending', 'unsubscribed', 'cleaned'],
        defaultValue: 'subscribed',
        help: 'Solo addMember. "pending" = double opt-in GDPR.',
      },
      {
        key: 'mergeFieldsJson',
        label: 'Merge fields (JSON)',
        type: 'expression',
        required: false,
        placeholder: '{"FNAME":"Mario","LNAME":"Rossi"}',
        help: 'Campi merge per addMember (FNAME, LNAME, ecc.).',
      },
      {
        key: 'tag',
        label: 'Tag (addTag)',
        type: 'expression',
        required: false,
        placeholder: 'lead-2026',
        help: 'Nome tag da applicare (solo operation=addTag).',
      },
      COMMON_LABEL_FIELD,
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

export const communityTwilioNode: NodeModule = {
  def: {
    id: 'community_twilio',
    type: 'action',
    label: 'Twilio SMS/WhatsApp',
    icon: 'message-circle',
    color: '#f22f46',
    description:
      'Connettore enterprise per Twilio — la piattaforma comunicazioni programmabili #1 al mondo (Software ' +
      'API leader fondato 2008, $20B valuation pre-IPO con 250k+ developer customer, copre il 90% degli ' +
      'SMS+voice+WhatsApp use case enterprise di tier-1 brand) via REST API ufficiale. Tre operazioni atomiche ' +
      'coprono il main feature set: sendSms (invia SMS classico su qualsiasi rete mobile mondiale, body ' +
      'fino a 1600 char con automatic segmentation in N parti se eccede 160 char standard GSM o 70 char ' +
      'Unicode, supporta concatenated SMS UDH per delivery come singolo messaggio sul dispositivo cliente), ' +
      'sendWhatsapp (invia messaggi WhatsApp Business via il sandbox Twilio o numero approvato in WhatsApp ' +
      'Business Manager, con prefix sintattico "whatsapp:+393331234567" che distingue il channel — supporta ' +
      'messaggi text + media attachment + template approvati), getMessage (lookup status delivery + error ' +
      'code di un messaggio precedentemente inviato by SID). ' +
      'Auth via Account SID (formato AC + 32 hex chars univoco del Twilio account) + Auth Token (secret ' +
      'rotabile per security incident response) entrambi stored nel vault integration FlowForge. Validation ' +
      'pre-call enterprise: accountSid validato sintatticamente (AC + 32 hex per anti-typo che produrrebbe ' +
      '404 dopo network roundtrip), numeri E.164 validation rigorosa (+393331234567 format obbligatorio + ' +
      'country code detection per auto-prepend del "+" se mancante in input italiano "3331234567"). ' +
      'Pipeline anti-vulnerability standard del connector enterprise FlowForge: SSRF-safe gateway HTTP per ' +
      'evitare chiamate a endpoint privati, body form-urlencoded come Twilio API richiede (NON JSON come la ' +
      'maggior parte degli altri provider — pattern unico che molti developer sbagliano), circuit-breaker ' +
      'dedicato per evitare hammer durante upstream outage Twilio (rare ma succedono), retry exponential ' +
      'backoff con jitter su 5xx transient e 429 rate-limit. ' +
      'Rate limit Twilio: 1 SMS/sec per numero sender (capacity expandable a 10 SMS/sec con request approval ' +
      'in Twilio Console — pattern critical per high-volume marketing campaign), WhatsApp 80 msg/sec per ' +
      'numero, voice unlimited concurrent. ' +
      'Errori semantici espliciti: 30003 (delivery failed unreachable destination), 30004 (filtered da ' +
      'carrier per spam), 30005 (numero invalid), 21408 (numero blocked dal customer) — il nodo li parsa e ' +
      'restituisce semantic error code al workflow downstream per gestione differenziata. ' +
      'Output: { messageSid? (univoco Twilio per tracking), status? (queued|sending|sent|delivered|failed), ' +
      'errorCode? (semantic), to, from, segmentsCount?, billingCost? }. ' +
      'Use case: notifica OTP/2FA al cliente per login multi-factor sicurezza accounts SaaS; alert critici al ' +
      'team di SRE/ops via SMS per incident production (pattern PagerDuty-lite); conferma ordine/appuntamento ' +
      'tramite SMS subito post-checkout con tracking number e link customer area; promemoria scadenza fattura ' +
      'via WhatsApp 7gg pre-scadenza per ridurre DSO (Days Sales Outstanding) e improve cash flow; recupero ' +
      'crediti automatic multi-step con escalation (1° SMS gentile 30gg + 2° WhatsApp formale 60gg + 3° ' +
      'voicemail automatic 90gg → handoff legale); follow-up lead commerciale multicanale (email + SMS + ' +
      'WhatsApp coordinati per maximize touch reach).',
    configFields: [
      {
        key: 'operation',
        label: 'Operazione',
        type: 'select',
        required: true,
        options: ['sendSms', 'sendWhatsapp', 'getMessage'],
        defaultValue: 'sendSms',
      },
      {
        key: 'to',
        label: 'Destinatario (E.164)',
        type: 'expression',
        required: false,
        placeholder: '+393331234567',
        help: 'Numero destinatario in formato E.164. Obbligatorio per send. Supporta {{input.phone}}.',
      },
      {
        key: 'fromNumber',
        label: 'Mittente (E.164)',
        type: 'expression',
        required: false,
        placeholder: '+390212345678',
        help: 'Numero Twilio mittente. Se vuoto usa il fromNumber del vault.',
      },
      {
        key: 'body',
        label: 'Testo messaggio',
        type: 'expression',
        required: false,
        placeholder: 'Il tuo codice è {{input.otp}}',
        help: 'Testo (max 1600 char). Obbligatorio per sendSms/sendWhatsapp.',
      },
      {
        key: 'messageSid',
        label: 'Message SID (getMessage)',
        type: 'expression',
        required: false,
        placeholder: 'SMxxxxxxxx',
        help: 'SID del messaggio per getMessage (stato delivery).',
      },
      COMMON_LABEL_FIELD,
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

export const communitySendgridNode: NodeModule = {
  def: {
    id: 'community_sendgrid',
    type: 'action',
    label: 'SendGrid Email',
    icon: 'send',
    color: '#1a82e2',
    description:
      'Connettore enterprise per SendGrid (la piattaforma email transazionale acquisita da Twilio nel 2019, ' +
      '80k+ paying customer, leader della categoria insieme a Postmark/Mailgun/SES per ESP managed cloud) via ' +
      'Mail Send API v3 ufficiale. Due operazioni atomiche coprono i pattern principali di sending: sendEmail ' +
      '(invio diretto con to+from+subject+body sia text plain sia HTML rich con embedded CSS), sendTemplate ' +
      '(usa Dynamic Template SendGrid creato nella web UI con Handlebars syntax + passa dynamic_template_data ' +
      'JSON per substitution dei placeholder server-side — pattern recommended enterprise per separare logic ' +
      'invio dal template design che è managed dal marketing team senza dover deploy codice). ' +
      "Auth via API Key Bearer (formato SG.xxxxx generato dall'admin SendGrid in Settings → API Keys con " +
      'scope mail.send.full o granular permission slug) stored nel vault integration FlowForge. Multi-key ' +
      'supportato per separazione production vs dev environment o per agency con N customer subaccount. ' +
      'Validation pre-send enterprise: email destinatario validato sintatticamente con regex RFC 5322 ' +
      'simplified per detect typo (mario@gmial.com → flag warning typo "did you mean gmail.com?"), supporto ' +
      'reply-to header indipendente dal from (pattern critico per "no-reply@" sender ma reply al support box), ' +
      'nome mittente custom ("Acme Customer Service <no-reply@acme.com>" → friendly UI display per ricevente). ' +
      'Pipeline anti-vulnerability: tutte le request transitano via il SSRF-safe gateway HTTP del runtime ' +
      '(safeFetchWithRedirects) per evitare di chiamare endpoint interni privati 192.168.* per misconfig; ' +
      "circuit-breaker dedicato per SendGrid evita di hammer l'API durante upstream outage (stato open dopo 8 " +
      'fail in 60s → cooldown 30s → half-open probe); retry exponential backoff su 5xx e 429 transitori. ' +
      'Gestione semantica robusta della response 202: SendGrid ritorna HTTP 202 Accepted SENZA body (Mail ' +
      'Send è asincrono server-side, il delivery vero avviene minuti dopo) — il nodo NON tenta di parsare ' +
      'response body inesistente e ritorna success se status=202. ' +
      'Output: { accepted (bool), to, from, operation (sendEmail|sendTemplate), messageId? (header ' +
      'X-Message-Id se SendGrid lo ritorna), durationMs }. ' +
      'Use case enterprise transazionali standard: conferma ordine/registrazione user post-signup; reset ' +
      'password con link UUID firmato + TTL 1h; ricevuta pagamento Stripe webhook → invio receipt PDF allegato ' +
      'al cliente; newsletter transazionale (non marketing — solo update operativi del servizio); notifica ' +
      'scadenza abbonamento +30/+7gg con template brandizzato Dynamic Template; onboarding drip campaign ' +
      'multi-step (giorno 1, giorno 3, giorno 7, giorno 14) con sequence configurabile; alert sistema agli ' +
      'amministratori del cliente customer-facing per monitoraggio operativo.',
    configFields: [
      {
        key: 'operation',
        label: 'Tipo invio',
        type: 'select',
        required: true,
        options: ['sendEmail', 'sendTemplate'],
        defaultValue: 'sendEmail',
        help: 'sendEmail = corpo libero. sendTemplate = Dynamic Template SendGrid.',
      },
      {
        key: 'to',
        label: 'Destinatario',
        type: 'expression',
        required: true,
        placeholder: 'cliente@example.it',
        help: 'Email destinatario. Supporta {{input.email}}.',
      },
      {
        key: 'from',
        label: 'Mittente (verificato su SendGrid)',
        type: 'expression',
        required: true,
        placeholder: 'noreply@tuodominio.it',
        help: 'Email mittente VERIFICATA in SendGrid (Sender Authentication), altrimenti rifiutata.',
      },
      {
        key: 'fromName',
        label: 'Nome mittente',
        type: 'text',
        required: false,
        placeholder: 'Studio Zeli',
        help: 'Nome visualizzato (opzionale). Es. "Studio Zeli <noreply@...>".',
      },
      {
        key: 'replyTo',
        label: 'Reply-To',
        type: 'expression',
        required: false,
        placeholder: 'assistenza@tuodominio.it',
        help: 'Email per le risposte (opzionale).',
      },
      {
        key: 'subject',
        label: 'Oggetto',
        type: 'expression',
        required: false,
        placeholder: 'Conferma ordine #{{input.orderId}}',
        help: 'Oggetto email. Obbligatorio per sendEmail (ignorato per template).',
      },
      {
        key: 'contentType',
        label: 'Formato corpo',
        type: 'select',
        required: false,
        options: ['text/plain', 'text/html'],
        defaultValue: 'text/plain',
        help: 'text/html per email formattate, text/plain per testo semplice.',
      },
      {
        key: 'body',
        label: 'Corpo email',
        type: 'expression',
        required: false,
        placeholder: 'Ciao {{input.nome}}, il tuo ordine è confermato.',
        help: 'Contenuto email. Obbligatorio per sendEmail.',
      },
      {
        key: 'templateId',
        label: 'Template ID (sendTemplate)',
        type: 'expression',
        required: false,
        placeholder: 'd-xxxxxxxxxxxxxxxx',
        help: 'ID Dynamic Template SendGrid. Obbligatorio per sendTemplate.',
      },
      {
        key: 'dynamicDataJson',
        label: 'Dati template (JSON)',
        type: 'expression',
        required: false,
        placeholder: '{"nome":"Mario","ordine":"#123"}',
        help: 'Variabili da iniettare nel template (solo sendTemplate).',
      },
      COMMON_LABEL_FIELD,
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

export const communityAsanaNode: NodeModule = {
  def: {
    id: 'community_asana',
    type: 'action',
    label: 'Asana',
    icon: 'check-square',
    color: '#f06a6a',
    description:
      'Connettore enterprise per Asana — la piattaforma di project management leader di mercato per team ' +
      'mid-market enterprise (130k+ paying customer dal 2008, IPO 2020 con valutazione $5B+, base installata ' +
      'particolarmente forte nel marketing/sales/operations team distribuiti dove serve workflow visibility ' +
      'cross-functional) via REST API 1.0 ufficiale. Tre operazioni atomiche coprono il ciclo task management: ' +
      'createTask (inserisce nuovo task con titolo, note markdown rich, project_id target nel workspace, ' +
      'assignee_id del responsabile, due_on per scadenza, tags per categorization, parent_task per sub-task ' +
      'nidificate, custom_fields per workflow custom-tailored), getTask (fetch puntuale di un task by GID ' +
      'con tutti i field completi incluso stories timeline + memberships per multi-project task + custom_fields), ' +
      'addComment (story sul task — Asana chiama "stories" tutti i log events del task: comments, status ' +
      'updates, assignment changes, completion ticks — ognuna è una story con author + timestamp + content). ' +
      "Auth via Personal Access Token (formato 1/xxxxxxxx generato dall'admin Asana in Settings → Apps → " +
      'Manage Developer Apps → + New Access Token) stored nel vault integration FlowForge. Multi-workspace ' +
      'supportato (un tenant FlowForge che gestisce N workspace Asana diversi per agency che serve N customer). ' +
      'Validation enterprise pre-API call: due_on scadenza validata formato YYYY-MM-DD strict (anti-errore di ' +
      'passing ISO 8601 con time component che Asana rigetterebbe 400), supporto multi-progetto (un task può ' +
      'essere assigned a multipli project simultaneamente — pattern per shared cross-team initiative), ' +
      'assignee_id risolto by email (lookup contro team membership cache) per pattern friendly. ' +
      'Pipeline anti-vulnerability enterprise: tutte le request via SSRF-safe gateway (evita di chiamare ' +
      'endpoint interni privati per misconfig); circuit-breaker dedicato per Asana evita hammer durante ' +
      'upstream outage; retry exponential backoff su 5xx e 429 transitori; body request wrappato nel formato ' +
      '{ data: { ... } } che Asana API richiede (the envelope JSON pattern che molti developer sbagliano). ' +
      'Rate limit Asana: 150 req/min sustained per token (3 RPS comfortable per use case interactive), header ' +
      'X-RateLimit-Remaining trackato per warning preventivo. ' +
      'Output: { taskId? (GID Asana), url? (permalink al task nel Asana web app per click direct), task? ' +
      '(object completo per getTask), commentId? (story GID), createdAt, modifiedAt }. ' +
      'Use case: crea task automatic da email customer support in arrivo (trigger_imap + agent_email_triage ' +
      '+ createTask nel project "Support Queue" con title cliente subject + body in note); apri ticket da ' +
      'errore workflow runtime (catch error handler → createTask in project "Bugs" con stack trace + run ' +
      'link); assegna follow-up commerciale automatic post-meeting Calendly closed-won (createTask "Send ' +
      'thank-you email to {{customer_name}}" assigned to AE responsabile, due +1day); sincronizzazione ' +
      'bidirezionale CRM Salesforce → Asana project management (lead Salesforce passa a stage "Discovery" → ' +
      'crea task in Asana per il consultant); genera checklist di onboarding cliente automatic (create 10 ' +
      'sub-task standard per ogni new customer da master template); commenta avanzamento step-by-step da ' +
      'sistema esterno (CI build complete → addComment su task corrispondente "✅ deploy OK at {{time}}").',
    configFields: [
      {
        key: 'operation',
        label: 'Operazione',
        type: 'select',
        required: true,
        options: ['createTask', 'getTask', 'addComment'],
        defaultValue: 'createTask',
        help: 'createTask = nuovo task. getTask = leggi. addComment = commenta.',
      },
      {
        key: 'name',
        label: 'Titolo task',
        type: 'expression',
        required: false,
        placeholder: 'Richiamare {{input.cliente}}',
        help: 'Titolo del task. Obbligatorio per createTask.',
      },
      {
        key: 'notes',
        label: 'Descrizione',
        type: 'expression',
        required: false,
        placeholder: 'Dettagli del task...',
        help: 'Note/descrizione (opzionale, solo createTask).',
      },
      {
        key: 'projectId',
        label: 'Progetto/i (gid)',
        type: 'expression',
        required: false,
        placeholder: '1201234567890',
        help: 'GID progetto Asana. Più progetti separati da virgola. Alternativa: workspace.',
      },
      {
        key: 'workspace',
        label: 'Workspace (gid)',
        type: 'expression',
        required: false,
        placeholder: '1101234567890',
        help: 'GID workspace (usato se nessun progetto specificato).',
      },
      {
        key: 'assignee',
        label: 'Assegnatario (gid/email)',
        type: 'expression',
        required: false,
        placeholder: 'me oppure 12345 oppure user@x.it',
        help: 'GID utente, email, o "me" (opzionale).',
      },
      {
        key: 'dueOn',
        label: 'Scadenza',
        type: 'expression',
        required: false,
        placeholder: '2026-06-30',
        help: 'Data scadenza in formato YYYY-MM-DD (opzionale).',
      },
      {
        key: 'taskId',
        label: 'Task GID (getTask/addComment)',
        type: 'expression',
        required: false,
        placeholder: '1209876543210',
        help: 'GID del task per getTask o addComment.',
      },
      {
        key: 'commentText',
        label: 'Testo commento (addComment)',
        type: 'expression',
        required: false,
        placeholder: 'Aggiornamento: completato lo step 1.',
        help: 'Testo del commento (solo addComment).',
      },
      COMMON_LABEL_FIELD,
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

export const communityDropboxNode: NodeModule = {
  def: {
    id: 'community_dropbox',
    type: 'action',
    label: 'Dropbox',
    icon: 'folder',
    color: '#0061ff',
    description:
      'Connettore enterprise per Dropbox — la piattaforma di file sharing/sync cloud pioniere del settore ' +
      '(fondata 2007 nel garage del MIT, IPO 2018, 700M+ utenti registered + 18M+ paying customer business — ' +
      'di cui particolarmente forte penetration in smb e creative agency che la usano per asset sharing) via ' +
      'API v2 ufficiale REST. Cinque operazioni atomiche coprono il file/folder lifecycle: listFolder ' +
      '(enumera contenuto di una cartella con opzionale ricorsivo deep + filter cursor-based per cartelle ' +
      'con migliaia di item), createFolder (crea nuova cartella nested fino a profondità arbitraria), ' +
      'getMetadata (info di file/cartella specifico: name, path, size, modified_time, content_hash per ' +
      'integrity check), createSharedLink (genera URL di condivisione pubblico con visibilità ' +
      'configurable + scadenza opzionale per delivery temporanea), deletePath (cancella file o cartella con ' +
      'soft-delete in Trash 30gg per recovery accidentale). ' +
      "Auth via OAuth2 Access Token Bearer (long-lived token generato dall'admin Dropbox via OAuth2 " +
      'authorization code flow, oppure short-lived con refresh-token per security più stringente) stored ' +
      'nel vault integration FlowForge accessibile via integrationLabel — pattern portal-centric multi-tenant ' +
      'enterprise FlowForge per condividere refresh-token tra workflow del stesso tenant. Multi-account ' +
      'supportato (un tenant FlowForge che gestisce Dropbox di N customer differenti). ' +
      'Path normalization automatic: l\'API Dropbox usa una sintassi specifica per i path (es. "" per root, ' +
      '"/Documents/Reports" per sub-folder con leading slash) — il nodo astrae questa convention e accetta ' +
      'pattern friendly come "Documents/Reports" auto-fixing il leading slash + handling del case-sensitivity. ' +
      'Pipeline standard FlowForge: SSRF-safe gateway, circuit-breaker dedicato per Dropbox per evitare ' +
      'hammer durante upstream outage, retry exponential backoff su 5xx e 429 transitori. Rate limit Dropbox: ' +
      'quota-based per token + endpoint (varies, alcuni endpoint hanno 25 req/min, altri 1000 req/min — il ' +
      'nodo gestisce 429 automaticamente). ' +
      'Output: { entries? (per listFolder, array di { name, path, size, type=file|folder, modified, ' +
      'content_hash }), count?, id? (per createFolder), sharedUrl? + accessLevel? + visibility? (per ' +
      'createSharedLink), metadata? (per getMetadata), deleted? (boolean per deletePath), cursor? per ' +
      'pagination continue }. ' +
      'Use case: archivia automatic fatture/documenti generati da workflow di billing (al closing di ogni ' +
      'fattura → save PDF nella cartella "Fatture/2026/05/" con naming convention sortable); backup file ' +
      'di workflow su cloud per long-term retention senza consumare disk space del runtime tenant; genera ' +
      'link condivisione per consegna asset cliente con scadenza 7gg (createSharedLink + invio per email via ' +
      'action_send_email); organizza upload per cartelle datate auto (createFolder per ogni giorno solare + ' +
      'save degli ingest del giorno lì); sincronizza output report mensile management su Dropbox team ' +
      'shared workspace per cross-team visibility; pulizia automatica di file temporanei più vecchi di 30gg ' +
      '(cron mensile + listFolder + filter modified < now - 30d + deletePath).',
    configFields: [
      {
        key: 'operation',
        label: 'Operazione',
        type: 'select',
        required: true,
        options: ['listFolder', 'createFolder', 'getMetadata', 'createSharedLink', 'deletePath'],
        defaultValue: 'listFolder',
        help: 'Cosa fare con il path Dropbox.',
      },
      {
        key: 'path',
        label: 'Percorso Dropbox',
        type: 'expression',
        required: false,
        placeholder: '/Fatture/2026',
        help: 'Percorso file o cartella (inizia con /). Vuoto o "/" = root. Per listFolder vuoto = root.',
      },
      {
        key: 'recursive',
        label: 'Ricorsivo (listFolder)',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'Se attivo, listFolder scende in tutte le sottocartelle.',
      },
      {
        key: 'autorename',
        label: 'Auto-rename (createFolder)',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'Se la cartella esiste, ne crea una con suffisso invece di errore.',
      },
      COMMON_LABEL_FIELD,
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

export const communityBoxNode: NodeModule = {
  def: {
    id: 'community_box',
    type: 'action',
    label: 'Box',
    icon: 'package',
    color: '#0061d5',
    description:
      'Connettore enterprise per Box.com — la piattaforma di Enterprise Content Management cloud nata nel ' +
      '2005 (IPO 2015, $3B+ valuation, 100k+ customer enterprise tier-1 inclusi GE, Coca-Cola, Toyota, ' +
      'Bank of America) — alternativa enterprise-focused a Dropbox/Google Drive con feature dedicate per ' +
      'governance documentale, compliance HIPAA/SOC2/FedRAMP, granular permission con accessi role-based, ' +
      'workflow approvals nativi, content classification & retention policies — via API 2.0 ufficiale. Cinque ' +
      'operazioni atomiche coprono il file/folder lifecycle: listFolder (enumera items di una cartella ' +
      'identificata by folder_id, root cartella tenant ha sempre id="0" — pattern di discovery contenuto), ' +
      'createFolder (crea nuova cartella sotto un parent specifico), getItem (metadata di un file o cartella ' +
      'specifico — tipo, size, creation date, owner, version_count), createSharedLink (genera shared URL per ' +
      'file/folder con livello visibilità configurable: open=URL pubblico chiunque conosca il link può ' +
      'accedere, company=solo membri del Box enterprise account, collaborators=solo utenti esplicitamente ' +
      'shared del file), deleteFile (cancellazione con soft-delete in trash 30gg default per recovery). ' +
      'Auth via Access Token Bearer (formato OAuth2 stored nel vault — il token short-lived 60min richiede ' +
      'refresh-token flow gestito dal portal-centric OAuth2 service per multi-tenant SaaS pattern enterprise). ' +
      'Multi-account supportato (un tenant FlowForge che gestisce N Box account distinti per agenzie che ' +
      'servono multiple customer enterprise). ' +
      'Validation enterprise pre-API: file/folder ID validati numerici (anti-typo che produrrebbe 404), ' +
      'shared link access level enum-strict, name length cap 255 char (limite Box). ' +
      'Pipeline anti-vulnerability standard FlowForge: tutte le request via SSRF-safe gateway, circuit-' +
      'breaker dedicato per Box, retry exponential backoff su 5xx/429. Rate limit Box: 5000 req/min ' +
      'sustained per app + token combination (83 RPS, comfortable per use case enterprise), header ' +
      'X-Box-Endpoint-Request tracked. ' +
      'Output: { entries? (per listFolder), count?, id? (per createFolder/createSharedLink), sharedUrl? + ' +
      'accessLevel? + expiresAt?, item? (per getItem), deleted? (boolean per deleteFile), totalSize? per ' +
      'folder summary }. ' +
      'Use case enterprise content management: archivio documentale aziendale governato (workflow di ingest ' +
      'documents → classification → store nella corretta cartella subdivision per dipartimento + tag con ' +
      'metadata custom); condivisione controllata file con clienti/partner B2B (createSharedLink con ' +
      'access=company per limitare visibility); gestione contenuti compliance-ready per audit ISO 27001/SOC2 ' +
      'con retention policy automated; automazione cartelle progetto (al closing di un new deal Salesforce → ' +
      'createFolder "Projects/{{customer_name}}/{{project_id}}" + setup default sub-structure); distribuzione ' +
      'report mensile management con permessi company-only; retention automatica documenti fiscali (10 anni ' +
      'dal createdAt → workflow cron mensile + delete o move to archive cartella).',
    configFields: [
      {
        key: 'operation',
        label: 'Operazione',
        type: 'select',
        required: true,
        options: ['listFolder', 'createFolder', 'getItem', 'createSharedLink', 'deleteFile'],
        defaultValue: 'listFolder',
        help: 'Cosa fare su Box.',
      },
      {
        key: 'folderId',
        label: 'Folder ID (listFolder)',
        type: 'expression',
        required: false,
        placeholder: '0',
        help: 'ID numerico cartella. "0" = root. Solo listFolder.',
      },
      {
        key: 'parentId',
        label: 'Parent folder ID (createFolder)',
        type: 'expression',
        required: false,
        placeholder: '0',
        help: 'ID cartella genitore dove creare. "0" = root.',
      },
      {
        key: 'name',
        label: 'Nome cartella (createFolder)',
        type: 'expression',
        required: false,
        placeholder: 'Progetto 2026',
        help: 'Nome nuova cartella (solo createFolder).',
      },
      {
        key: 'itemId',
        label: 'File/Folder ID',
        type: 'expression',
        required: false,
        placeholder: '123456789',
        help: 'ID numerico per getItem/createSharedLink/deleteFile.',
      },
      {
        key: 'itemType',
        label: 'Tipo item (getItem)',
        type: 'select',
        required: false,
        options: ['files', 'folders'],
        defaultValue: 'files',
        help: 'getItem: file o cartella.',
      },
      {
        key: 'access',
        label: 'Visibilità link (createSharedLink)',
        type: 'select',
        required: false,
        options: ['open', 'company', 'collaborators'],
        defaultValue: 'open',
        help: 'open=pubblico, company=solo azienda, collaborators=solo collaboratori.',
      },
      {
        key: 'limit',
        label: 'Limit (listFolder)',
        type: 'number',
        required: false,
        defaultValue: '100',
        help: 'Max items per listFolder (1-1000).',
      },
      COMMON_LABEL_FIELD,
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

export const communityGcsNode: NodeModule = {
  def: {
    id: 'community_gcs',
    type: 'action',
    label: 'Google Cloud Storage',
    icon: 'cloud',
    color: '#4285f4',
    description:
      'Connettore enterprise per Google Cloud Storage (GCS) — il blob storage service di Google Cloud ' +
      "Platform che è la base dell'object storage per Google itself + 6M+ paying GCP customer (alternativa " +
      'a AWS S3 e Azure Blob Storage, particolarmente strong su prezzo per cold archive Coldline/Archive ' +
      'storage class, integrazione native con BigQuery per data lake analytics, e dual-region/multi-region ' +
      'per GDPR-compliant EU residency) via JSON API v1 ufficiale. Tre operazioni atomiche coprono i pattern ' +
      'principali del object lifecycle: listObjects (enumera object di un bucket con prefix filtering ' +
      'opzionale "logs/2026-" per scoping, paginazione cursor-based per bucket con milioni di object, ' +
      'pattern di discovery batch processing), getObjectMetadata (info dettagliata di un object specifico ' +
      'compreso content-type, size, md5Hash + crc32cHash per integrity check, generationNumber per versioning, ' +
      "mediaLink che è l'URL signed da usare per il download del payload binary), deleteObject (cancellazione " +
      'con soft-delete configurabile se versioning enabled sul bucket — recovery 7gg default). ' +
      'Auth via OAuth2 access token con scope devstorage.read_write (oppure devstorage.read_only per use case ' +
      'lista-only), stored nel vault integration FlowForge tramite portal-centric OAuth2 multi-tenant pattern ' +
      '— refresh-token gestito centralmente, runtime tenant riceve access_token short-lived (1h TTL Google) ' +
      'via JWE handoff 5min. ' +
      'Validation enterprise pre-API: bucket name validato sintatticamente come RFC GCS strict (3-63 char ' +
      'lowercase + numeri + - + . without leading/trailing dash + not IP-like — Google rifiuterebbe 400 ' +
      'altrimenti); object name validato senza control characters; ID validati numerici per generationNumber. ' +
      'Pipeline standard FlowForge: SSRF-safe gateway, circuit-breaker dedicato per GCS, retry exponential ' +
      'backoff su 5xx Google transient (rare ma succedono soprattutto su region migration eventi) + 429. ' +
      'Rate limit GCS: 5000 read req/sec per bucket (generoso, no concern usual use case), 1 RPS write/' +
      'bucket per same-named object (anti-thrashing, raramente hit). ' +
      'Output: { objects? (per listObjects, array of [{ name, size, contentType, updated, md5Hash, ' +
      'generation }]), count?, metadata? (per getObjectMetadata), mediaLink? (per download signed URL), ' +
      'deleted? (per deleteObject), bucket, nextPageToken?, totalSize? }. ' +
      'Use case: archivia output workflow su bucket GCS per long-term retention (workflow genera PDF report ' +
      '→ upload su GCS con storage class "Coldline" per ottimizzare costo); lista file per elaborazione ' +
      'batch nightly (cron orario + listObjects su prefix "incoming/" + per ogni file processa + sposta in ' +
      '"processed/" + delete original); pulizia automatic oggetti scaduti (lifecycle policy lato GCS + ' +
      'workflow di audit settimanale di verifica); genera link download signed per consegna client di file ' +
      'temporanei (TTL 24h dopo workflow di delivery completion); pipeline ETL da data lake GCS verso ' +
      'BigQuery downstream o Snowflake export; backup documenti enterprise con retention 7 anni per ' +
      'compliance fiscale italiana.',
    configFields: [
      {
        key: 'operation',
        label: 'Operazione',
        type: 'select',
        required: true,
        options: ['listObjects', 'getObjectMetadata', 'deleteObject'],
        defaultValue: 'listObjects',
        help: 'Cosa fare sugli oggetti del bucket.',
      },
      {
        key: 'bucket',
        label: 'Bucket',
        type: 'expression',
        required: true,
        placeholder: 'mio-bucket-prod',
        help: 'Nome bucket GCS (3-63 char, lowercase). Supporta {{input.bucket}}.',
      },
      {
        key: 'prefix',
        label: 'Prefix (listObjects)',
        type: 'expression',
        required: false,
        placeholder: 'fatture/2026/',
        help: 'Filtra oggetti per prefisso (es. cartella virtuale). Solo listObjects.',
      },
      {
        key: 'objectName',
        label: 'Nome oggetto',
        type: 'expression',
        required: false,
        placeholder: 'fatture/2026/F123.pdf',
        help: 'Nome completo oggetto per getObjectMetadata/deleteObject.',
      },
      {
        key: 'maxResults',
        label: 'Max risultati (listObjects)',
        type: 'number',
        required: false,
        defaultValue: '100',
        help: 'Max oggetti per pagina (1-1000).',
      },
      COMMON_LABEL_FIELD,
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};
