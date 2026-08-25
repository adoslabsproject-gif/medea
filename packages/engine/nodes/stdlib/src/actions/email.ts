import type { NodeModule } from '../types.js';

/**
 * action_send_email — invio email SMTP enterprise.
 *
 * Standard 2026 conforme (vedi docs/NODE_STANDARD_2026.md):
 *  - description in 3 paragrafi (cosa fa / esempi d'uso / sicurezza)
 *  - help su OGNI singolo configField (24 totali)
 *  - defaultValue sensati su tutti i field opzionali
 *  - showIf condizionali per ridurre cognitive load
 *  - Pre-flight DKIM/SPF/DMARC check opzionale
 *  - Inline images via CID, attachments via base64/URL/path
 *
 * Provider testati: Gmail / Workspace, SendGrid, Mailgun, Postmark, IONOS,
 * Aruba SMTP, Orion (FlowForge default), Office 365, Amazon SES.
 */
export const sendEmailNode: NodeModule = {
  def: {
    id: 'action_send_email',
    type: 'action',
    label: 'Send Email (SMTP)',
    // "manda una mail": 'mail' non è un token di 'email' (tokenizer word-based).
    searchAliases: ['mail', 'posta'],
    icon: 'send',
    color: '#3b82f6',
    description:
      "Invia un'email transazionale via SMTP RFC 5321. Compatibile con qualunque server conforme: Gmail/Workspace (XOAUTH2 supportato via Gmail OAuth node), SendGrid, Mailgun, Postmark, IONOS, Aruba PEC, Office 365, Amazon SES, server self-hosted (Postfix/Exim).\n\n" +
      'Differenza con i sibling: action_send_email = invio singolo con full feature set (CC/BCC, threading, allegati, inline images, DKIM). Per invio TRACKED (open/click) usa action_email_send_tracked; per BATCH mass-mailing usa action_email_send_tracked_batch (worker pool + rate limit). Per Gmail OAuth dedicato vedi pipeline Gmail OAuth XOAUTH2.\n\n' +
      'Feature complete: threading via In-Reply-To/References (reply email ricomincia il thread Gmail/Outlook), priorità X-Priority header, header custom, allegati base64/URL/path (max 25 MB combinati), immagini inline via Content-ID (CID), firma DKIM inline opzionale per dominio terzo (se SMTP non firma).\n\n' +
      "Sicurezza + deliverability: credenziali cifrate via Settings → Email Accounts (vault per-tenant). Pre-flight check SPF/DKIM/DMARC selezionabile (deliverabilityCheck: off/warn/strict) — strict consigliato per cold outreach (senza autenticazione DNS ~60% finisce spam Gmail/Outlook), warn esegue il check e lo riporta ma invia comunque. Header X-FlowForge NON aggiunto (privacy-by-default, nessuna telemetria leak). Il messageId SMTP reale è nell'output del nodo (per trace/correlazione).\n\n" +
      'Use case: (1) ricevuta acquisto post-checkout PayPal/Stripe con PDF fattura allegato, (2) notifica password reset con link signed expires-2h, (3) reply automatico su PEC ricevuta con threading In-Reply-To corretto, (4) digest settimanale management con dati DB embedded inline.\n\n' +
      'Safety budget: SSRF guard sugli allegati-da-URL (no fetch verso IP interni/metadata), subject sanitizzato (no CRLF injection, RFC 5322), credenziali dal vault per-tenant. Il retry è responsabilità del workflow/engine (un solo livello, niente retry interno nascosto che lo raddoppi).',
    configFields: [
      // ─── Account / SMTP ─────────────────────────────────────────────
      {
        key: 'systemAccountId',
        label: 'Account email (Settings → Email Accounts)',
        type: 'email-account-picker',
        required: false,
        help: 'Account SMTP preconfigurato dal tab "Email Accounts" di Settings. Credentials cifrate, share tra tutti i workflow del tenant. Se selezionato, i 5 campi SMTP sotto vengono IGNORATI. Raccomandato vs configurazione manuale.',
      },
      {
        key: 'host',
        label: 'SMTP host (override)',
        type: 'text',
        required: false,
        placeholder: 'smtp.gmail.com / smtp.sendgrid.net / smtp.example.com',
        help: 'Hostname del server SMTP. Tipici: smtp.gmail.com:465, smtp.sendgrid.net:587, smtp.office365.com:587, smtp-mail.outlook.com:587. Solo se NON usi un account preconfigurato.',
        showIf: { field: 'systemAccountId', equals: '' },
      },
      {
        key: 'port',
        label: 'SMTP port',
        type: 'number',
        required: false,
        defaultValue: '465',
        help: '465 = SMTPS (TLS implicito, default). 587 = STARTTLS (upgrade da plain). 25 = plain (sconsigliato, spesso bloccato dai provider cloud). Verifica nella doc del tuo provider quale supporta.',
        showIf: { field: 'systemAccountId', equals: '' },
      },
      {
        key: 'security',
        label: 'Security',
        type: 'select',
        options: ['tls', 'starttls', 'plain'],
        required: false,
        defaultValue: 'tls',
        help: "tls = TLS immediato all'handshake (port 465, default). starttls = upgrade da connessione plain via comando STARTTLS (port 587). plain = nessuna cifratura (port 25, INSICURO — solo per server locali in rete fidata).",
        showIf: { field: 'systemAccountId', equals: '' },
      },
      {
        key: 'username',
        label: 'SMTP username',
        type: 'text',
        required: false,
        placeholder: 'mario.rossi@example.com / apikey (SendGrid) / postmaster (Mailgun)',
        help: 'Utente per l\'autenticazione SMTP. Per Gmail: indirizzo completo. Per SendGrid: stringa letterale "apikey" (poi password = API key). Per Postmark: lo stesso token serve come user + password.',
        showIf: { field: 'systemAccountId', equals: '' },
      },
      {
        key: 'password',
        label: 'SMTP password / API key',
        type: 'secret',
        required: false,
        help: 'Password account o API key del provider. NON la metti qui in chiaro: usa {{secrets.SMTP_PASSWORD}} con valore configurato in Credentials. Gmail richiede App Password (no password account dal 2022). In modalità OAuth2 questo campo è ignorato.',
        showIf: { field: 'systemAccountId', equals: '' },
      },

      // ─── OAuth2 (XOAUTH2) — alternativa a user/password ─────────────
      {
        key: 'authMode',
        label: 'Autenticazione',
        type: 'select',
        options: ['password', 'oauth2'],
        defaultValue: 'password',
        required: false,
        help: "password = SMTP user/pass (per Gmail: App Password). oauth2 = XOAUTH2 con refresh token (CONSIGLIATO Gmail/Workspace: niente App Password, token revocabile, scope minimale gmail.send). nodemailer ricava da solo l'access token dal refresh token.",
        showIf: { field: 'systemAccountId', equals: '' },
      },
      {
        key: 'oauthUser',
        label: 'OAuth — indirizzo email',
        type: 'text',
        required: false,
        placeholder: 'mario.rossi@gmail.com / {{secrets.GMAIL_USERNAME}}',
        help: 'Indirizzo email mittente (lo "user" XOAUTH2). Deve coincidere con l\'account che ha emesso il refresh token. Se vuoto usa lo SMTP username. Per Gmail OAuth: host smtp.gmail.com, port 465, security tls.',
        showIf: { field: 'authMode', equals: 'oauth2' },
      },
      {
        key: 'oauthClientId',
        label: 'OAuth — Client ID',
        type: 'secret',
        required: false,
        help: "Client ID dell'app OAuth (Google Cloud Console → Credentials). Usa {{secrets.GMAIL_OAUTH_CLIENT_ID}} — niente in chiaro.",
        showIf: { field: 'authMode', equals: 'oauth2' },
      },
      {
        key: 'oauthClientSecret',
        label: 'OAuth — Client Secret',
        type: 'secret',
        required: false,
        help: "Client Secret dell'app OAuth. Usa {{secrets.GMAIL_OAUTH_CLIENT_SECRET}}.",
        showIf: { field: 'authMode', equals: 'oauth2' },
      },
      {
        key: 'oauthRefreshToken',
        label: 'OAuth — Refresh Token',
        type: 'secret',
        required: false,
        help: 'Refresh token con scope gmail.send (emesso via Settings → Email Accounts → Gmail OAuth). Long-lived: nodemailer lo scambia per un access token a ogni invio. Usa {{secrets.GMAIL_OAUTH_REFRESH_TOKEN}}.',
        showIf: { field: 'authMode', equals: 'oauth2' },
      },

      // ─── Recipients ────────────────────────────────────────────────
      {
        key: 'from',
        label: 'From (override account)',
        type: 'text',
        required: false,
        placeholder: 'Mario Rossi <noreply@example.com>',
        help: 'Mittente visibile al destinatario. Lascia vuoto per usare il from dell\'account selezionato. Formato: "Nome <email@dominio>" oppure solo email. ATTENZIONE: il dominio in "from" deve essere autorizzato dall\'SMTP (SPF) — altrimenti rifiutato o spam.',
      },
      {
        key: 'replyTo',
        label: 'Reply-To',
        type: 'text',
        required: false,
        placeholder: 'support@example.com',
        help: 'Indirizzo a cui il destinatario risponderà cliccando "Rispondi". Diverso da From — utile per inviare da un service account (noreply@) e ricevere risposte su una casella reale (support@, info@).',
      },
      {
        key: 'to',
        label: 'To (separati da virgola)',
        type: 'text',
        required: true,
        placeholder: 'alice@example.com, bob@example.com, {{$node.trigger.json.email}}',
        help: 'Destinatari principali (campo To). Separati da virgola. Supporta espressioni {{$node.X.json.field}} per destinatari dinamici. Max 50 destinatari per messaggio (limite Gmail/Outlook anti-spam).',
      },
      {
        key: 'cc',
        label: 'CC (separati da virgola)',
        type: 'text',
        required: false,
        placeholder: 'manager@example.com',
        help: 'Destinatari in copia carbone (visibili a tutti). Tipicamente per "knowledge sharing" o approvazione. NON usare per liste grandi — preferisci BCC per privacy.',
      },
      {
        key: 'bcc',
        label: 'BCC (separati da virgola)',
        type: 'text',
        required: false,
        placeholder: 'archivio@example.com',
        help: 'Destinatari in copia nascosta (invisibili agli altri destinatari). Usa per archiviazione/audit o mailing list. NIENTE leak di indirizzi tra destinatari (GDPR-safe).',
      },

      // ─── Threading ─────────────────────────────────────────────────
      {
        key: 'inReplyTo',
        label: 'In-Reply-To (Message-ID originale)',
        type: 'text',
        required: false,
        placeholder: '<msgid-of-original@example.com>',
        help: "Per rispondere ad un'email esistente. Mette il messaggio nello stesso thread per il destinatario (in Gmail compare nella stessa conversazione). MANTIENI le parentesi angolari < >. Esempio: <CABw7+UeXt9pXY9@mail.gmail.com>.",
      },
      {
        key: 'references',
        label: 'References (Message-ID separati da spazio)',
        type: 'text',
        required: false,
        placeholder: '<orig1@x.com> <orig2@x.com>',
        help: 'Catena cronologica di Message-ID precedenti del thread. Tipicamente: il References originale + spazio + il Message-ID a cui rispondi. Mantiene la conversazione intera nei client che supportano threading (Gmail/Outlook/Thunderbird).',
      },

      // ─── Subject / Body ────────────────────────────────────────────
      {
        key: 'subject',
        label: 'Subject',
        type: 'text',
        required: true,
        placeholder: 'Conferma ordine #{{input.orderId}}',
        help: 'Oggetto del messaggio. Supporta espressioni {{...}}. Mantieni 30-60 caratteri per leggibilità su mobile. EVITA: ALL CAPS, troppi punti esclamativi, parole spam-trigger (gratis/win/click). Limite 998 char (RFC).',
      },
      {
        key: 'bodyType',
        label: 'Body type',
        type: 'select',
        options: ['text', 'html', 'markdown'],
        required: true,
        defaultValue: 'html',
        help: "text = plain text puro (massima deliverability, nessuna formattazione). html = formattato (link/grassetto/colori, default). markdown = scrivi in markdown, l'engine converte in HTML server-side (per template AI-generated).",
      },
      {
        key: 'body',
        label: 'Body',
        type: 'rich-text',
        required: true,
        placeholder: 'Ciao {{input.name}}, il tuo ordine #{{input.orderId}} è in elaborazione…',
        help: 'Editor visuale (grassetto/corsivo/liste/link/img). Switcha "HTML" nella barra per editare il sorgente HTML. Supporta espressioni {{...}} per contenuto dinamico. Se Body type = "text", il contenuto viene inviato come plain text strippato.',
      },

      // ─── Headers / Priority ────────────────────────────────────────
      {
        key: 'priority',
        label: 'Priorità',
        type: 'select',
        options: ['normal', 'high', 'low'],
        required: false,
        defaultValue: 'normal',
        help: 'high = X-Priority: 1 + Importance: High (icona "!" in alcuni client). low = X-Priority: 5 + Importance: Low. normal = nessuno header (default). NON è un canale prioritario reale — i server SMTP non accelerano per priorità.',
      },
      {
        key: 'headersJson',
        label: 'Header personalizzati',
        type: 'key-value',
        required: false,
        help: 'Header custom da aggiungere al messaggio. Esempi tipici: X-Mailer=FlowForge (identifica origine), List-Unsubscribe=<mailto:unsub@x.com> (CAN-SPAM + Gmail bulk-sender 2026 obbligatorio), Auto-Submitted=auto-generated (RFC 3834 per bot reply).',
      },

      // ─── Deliverability pre-flight check (SPF/DKIM/DMARC) ─────────
      {
        key: 'deliverabilityCheck',
        label: 'Pre-flight deliverability (SPF/DKIM/DMARC)',
        type: 'select',
        options: ['off', 'warn', 'strict'],
        required: false,
        defaultValue: 'off',
        help:
          'Verifica i record DNS del dominio mittente PRIMA di inviare. Senza autenticazione DKIM/SPF, ~60% delle email finisce in spam (Gmail/Outlook bulk-sender 2026).\n\n' +
          '• off (default): nessun check, back-compat.\n' +
          '• warn: esegue check, logga warning + lo include nei result.warnings, MA invia comunque.\n' +
          '• strict: esegue check, FALLISCE il nodo se SPF/DKIM/DMARC mancanti. CONSIGLIATO per cold outreach + workflow lead-gen dove deliverability è critica.\n\n' +
          'Cache 1h sul fromAddress → costo DNS ~0 in produzione. Output del nodo include sempre il report quando il check è attivo (visibile nel RunInspector).',
      },

      // ─── Attachments + inline images ───────────────────────────────
      {
        key: 'attachmentsJson',
        label: 'Allegati',
        type: 'attachments',
        required: false,
        help: "File allegati. 3 modalità: upload (base64 inline, max 10MB consigliato), URL pubblico (l'engine scarica e allega), path filesystem server. File > 10MB → preferisci URL per evitare timeout SMTP.",
      },
      {
        key: 'inlineImagesJson',
        label: 'Immagini inline (CID)',
        type: 'attachments',
        required: false,
        help:
          'Immagini referenziate nel body HTML con src="cid:<nome>". Esempio: carichi qui un file "logo.png", poi nel body usi <img src="cid:logo.png" />. ' +
          'A differenza degli allegati normali NON appaiono come file scaricabili ma sono renderizzate dentro il messaggio (loghi email branded, signature, banner promo).',
      },

      // ─── DKIM signing (advanced) ───────────────────────────────────
      {
        key: 'dkimDomain',
        label: 'DKIM domain (opzionale)',
        type: 'text',
        required: false,
        placeholder: 'example.com',
        help: 'Se valorizzato: firma il messaggio con DKIM (header DKIM-Signature). Devi anche compilare selector + private key sotto. Lascia VUOTO se il provider SMTP firma per te (SendGrid, Postmark, Amazon SES, Mailgun, Gmail con DKIM key pubblicata). Doppia firma = quasi sempre inutile.',
      },
      {
        key: 'dkimSelector',
        label: 'DKIM selector',
        type: 'text',
        required: false,
        defaultValue: 'default',
        placeholder: 'default / s1 / mail / dkim2024',
        help: 'Stringa "label" del record DNS DKIM. Deve corrispondere al record DNS pubblico <selector>._domainkey.<domain> TXT. Default convenzionale è "default" ma molti usano "s1", "mail", "dkim2024". Verifica con `dig TXT default._domainkey.tuodominio.com`.',
        showIf: { field: 'dkimDomain', truthy: true },
      },
      {
        key: 'dkimPrivateKey',
        label: 'DKIM private key (PEM)',
        type: 'secret',
        required: false,
        help: 'Chiave privata RSA in formato PEM. Tipicamente -----BEGIN RSA PRIVATE KEY----- ... -----END RSA PRIVATE KEY-----. La chiave PUBBLICA corrispondente deve essere pubblicata in <selector>._domainkey.<domain> TXT del DNS. Usa {{secrets.DKIM_PRIVATE_KEY}} per non leak in plain text.',
        showIf: { field: 'dkimDomain', truthy: true },
      },
    ],
    outputContract: {
      notes: '`accepted` e `rejected` sono la verita` sulla consegna: il nodo riesce anche quando il server rifiuta ALCUNI destinatari, quindi una lista `rejected` non vuota va controllata. Il rapporto `deliverability` c\'e` solo se il controllo SPF/DKIM/DMARC e` acceso.',
      fields: [
        { name: 'messageId', type: 'string', desc: 'Il Message-ID assegnato: serve a ritrovare il messaggio e a correlare le risposte.' },
        { name: 'accepted', type: 'array', desc: 'I destinatari che il server ha accettato.' },
        { name: 'rejected', type: 'array', desc: 'Quelli che ha rifiutato. Vuoto quando e` andato tutto bene.' },
        { name: 'response', type: 'string', desc: 'L\'ultima risposta del server SMTP, testuale.' },
        { name: 'deliverability', type: 'object', desc: 'L\'esito dei controlli SPF, DKIM e DMARC. Presente solo col controllo acceso.' },
      ],
    },
    vendor: 'flowforge',
    version: '2.2.0',
  },
};
