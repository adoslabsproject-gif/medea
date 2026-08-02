/**
 * `action_email_send_tracked` — NodeDef (UI metadata).
 *
 * Pattern: every config field has a `help` line written for a non-engineer
 * — explicit unit, explicit consequence of changing it, real example.
 * Defaults are chosen so a brand-new user can drag the node, fill three
 * fields (to / subject / body), and it works.
 *
 * @module actions/email_send_tracked/definition
 */

import type { NodeDef } from '@medea/engine-core-schema';

export const emailSendTrackedNodeDef: NodeDef = {
  id: 'action_email_send_tracked',
  type: 'action',
  label: 'Email: invia con tracking',
  icon: 'mail',
  color: '#0ea5e9',
  description:
    'Estende action_send_email con tracking comportamentale GDPR-safe: ogni email in uscita viene arricchita ' +
    'con un pixel di apertura 1x1 PNG trasparente servito da un endpoint HTTP del tenant (URL univoco per ' +
    'messaggio, no cookie) e tutti i link cliccabili nel body HTML vengono riscritti in URL di redirect tracciato ' +
    '/email-tracking/r/<token>?u=<dest> che logga il click e poi 302 verso la destinazione originale. Apertura e ' +
    'click finiscono nella tabella interactions del database tenant con timestamp, IP truncato (ultimi 64 bit ' +
    'zerati per GDPR pseudonimizzazione), user-agent normalizzato (categoria browser/email-client invece di string ' +
    'completa), e contesto del workflow (workflow_id, run_id, recipient_email_hash). Il dataset è immediatamente ' +
    'pronto come signal di lead-scoring: chi apre più volte = engagement alto; chi clicca su un link specifico ' +
    'di tariffario = intent commerciale forte; chi non apre dopo 7 giorni = candidato follow-up. ' +
    'Sicurezza: token HMAC-SHA256 firmato con chiave del tenant — impossibile per terzi forgiare apri/click ' +
    'fittizi anche con accesso all\'URL; URL di click validati prima del redirect contro una whitelist di host ' +
    'derivata dal body originale (defense-in-depth contro open-redirect injection da workflow malformato); ' +
    'bot-UA noti (Googlebot, Slack Linkbot, Twitter Cardbot, OutlookOWASafelink, Microsoft Safelinks, Mimecast, ' +
    'Proofpoint) filtrati lato endpoint per evitare di contare "aperture" automatiche di security gateway nelle ' +
    'metriche reali. ' +
    'GDPR (artt. 6 + 7 e-Privacy): se requireConsent=true (default) e l\'input upstream non porta esplicitamente ' +
    'consentVerified=true (bool), il nodo RIFIUTA l\'invio con errore "MISSING_TRACKING_CONSENT" prevenendo ' +
    'invio inadvertente che esporrebbe a sanzioni Garante; consentEvidence (es. "form_signup_2026-01-15") può ' +
    'essere passato per audit log GDPR. Per email transazionali (conferma ordine, fattura, password reset) il ' +
    'consenso non è richiesto per legge (Considerando 47) ma il tracking sì — disable requireConsent solo per ' +
    'communications transazionali; per marketing newsletter MAI farlo. ' +
    'Output: { ok, messageId, trackingIds: { open, click }, pixelUrl, openTokens, clickTokens, recipients, ' +
    'consentEvidence }. ' +
    'Use case: studio commercialista invia preventivo personalizzato a 30 prospect — il dashboard mostra chi ha ' +
    'aperto due volte e cliccato il link al pacchetto, candidati ideali per follow-up telefonico nelle 24h ' +
    'successive; SaaS B2B invia drip campaign di onboarding e identifica utenti "dormienti" (zero apertura dopo ' +
    'email 3 di 5) per intervento sales; e-commerce dopo richiesta info → tracking apertura conferma + click sul ' +
    'link prodotto, dato che alimenta abandoned-cart workflow successivo; servizio professionale invia ricordo ' +
    'scadenza appuntamento, alerting se non aperto entro 4h dalla data prenotata (probabile no-show).',

  configFields: [
    // ────────── Sender ──────────
    {
      key: 'systemAccountId',
      label: 'Account email di sistema',
      type: 'email-account-picker',
      required: false,
      help: 'Scegli un account configurato in Settings → Email accounts (con Gmail OAuth ' +
        'o SMTP). Se lasciato vuoto puoi configurare host/porta/username/password qui sotto, ' +
        'ma e\\` sconsigliato — gli account di sistema gestiscono refresh OAuth e cifratura ' +
        'password at-rest.',
    },
    {
      key: 'host', label: 'SMTP host (override)', type: 'text', required: false,
      placeholder: 'smtp.gmail.com',
      help: 'Manuale: solo se non usi un account di sistema. Tipico: smtp.gmail.com / smtp.office365.com.',
      showIf: { field: 'systemAccountId', equals: '' },
    },
    {
      key: 'port', label: 'SMTP porta', type: 'number', required: false,
      defaultValue: '587',
      help: '587 = STARTTLS (default moderno). 465 = TLS implicito. 25 = legacy non cifrato.',
      showIf: { field: 'systemAccountId', equals: '' },
    },
    {
      key: 'security', label: 'Sicurezza connessione', type: 'select', required: false,
      options: ['starttls', 'tls', 'none'], defaultValue: 'starttls',
      help: 'starttls = porta 587 (default). tls = porta 465. none = solo dev.',
      showIf: { field: 'systemAccountId', equals: '' },
    },
    {
      key: 'username', label: 'SMTP username', type: 'text', required: false,
      help: 'Per Gmail: l\\\'indirizzo email completo. Per Office365: idem.',
      showIf: { field: 'systemAccountId', equals: '' },
    },
    {
      key: 'password', label: 'SMTP password / app password', type: 'secret', required: false,
      help: 'Per Gmail: usa una App Password (Account Google → Sicurezza). Per Office365: la password account.',
      showIf: { field: 'systemAccountId', equals: '' },
    },

    // ────────── Envelope ──────────
    {
      key: 'from', label: 'Mittente (From)', type: 'text', required: false,
      placeholder: 'commerciale@example.com',
      help: 'Indirizzo "From" mostrato al destinatario. Se vuoto e usi un account di sistema, ' +
        'eredita il fromAddress di quell\\\'account.',
    },
    {
      key: 'to', label: 'Destinatari (To)', type: 'text', required: true,
      placeholder: 'mario@enoteca.it, anna@hotel.it',
      help: 'Uno o più indirizzi separati da virgola. Il pixel di apertura è UNICO per ' +
        'invio — non puoi distinguere chi ha aperto se metti 5 destinatari nello stesso To. ' +
        'Per tracking individuale: invia 1 mail per lead (vedi action_email_send_tracked_batch).',
    },
    {
      key: 'cc', label: 'Cc', type: 'text', required: false,
      help: 'Copia conoscenza. Vede tutti i destinatari in chiaro.',
    },
    {
      key: 'bcc', label: 'Bcc', type: 'text', required: false,
      help: 'Copia nascosta. Tipicamente per archiviare la tua mail su un indirizzo aziendale.',
    },
    {
      key: 'replyTo', label: 'Reply-To', type: 'text', required: false,
      placeholder: 'commerciale@example.com',
      help: 'Indirizzo dove arrivano le risposte se diverso dal From. Tipicamente lasciato vuoto.',
    },
    {
      key: 'subject', label: 'Oggetto', type: 'text', required: true,
      placeholder: 'Redivivo Gin per la tua enoteca · Limited Edition Mutabilis',
      help: 'Massimo 998 caratteri (limite RFC). I caratteri non-ASCII vengono codificati ' +
        'automaticamente (MIME encoded-word). Supporta interpolazione `{{lead.name}}`.',
    },

    // ────────── Body ──────────
    {
      key: 'bodyType', label: 'Tipo corpo', type: 'select', required: false,
      options: ['html', 'text'], defaultValue: 'html',
      help: 'HTML = formattazione + immagini + tracking pixel. Text = solo testo, pixel non iniettato ' +
        '(text/plain non supporta <img>). Per email commerciali usa SEMPRE html.',
    },
    {
      key: 'body', label: 'Corpo email', type: 'textarea', required: true,
      placeholder: '<p>Gentile {{lead.name}}, ...</p>',
      help: 'HTML completo o frammento (senza <html>/<body> — vengono aggiunti automaticamente). ' +
        'Tutti i link <a href> vengono riscritti per tracking se trackClicks=on. Supporta ' +
        '{{interpolazione}} dalle variabili upstream e dai campi lead.',
    },

    // ────────── Tracking identity ──────────
    {
      key: 'leadId', label: 'Lead ID', type: 'text', required: true,
      placeholder: '{{$json.lead.id}}',
      help: 'ID del lead nel database. Tipicamente arriva da un nodo db_query upstream. ' +
        'OBBLIGATORIO: senza lead id non si puo\\` tracciare chi apre/clicca.',
    },
    {
      key: 'campaignId', label: 'Campagna ID', type: 'text', required: true,
      placeholder: 'redivivo-2026-w23-enoteche-lazio',
      help: 'Stringa libera che raggruppa tutti gli invii della stessa campagna. ' +
        'Usata per gli analytics "open-rate per campagna". ' +
        'Convenzione consigliata: <brand>-<anno>-<week>-<segmento>-<area>.',
    },
    {
      key: 'sendId', label: 'Send ID (opzionale)', type: 'text', required: false,
      placeholder: 'lasciare vuoto = auto-generato',
      help: 'Identifica univocamente questo singolo invio. Se vuoto viene generato un uuid. ' +
        'Compilalo manualmente quando vuoi che un retry del workflow NON crei un secondo invio ' +
        '(es. usa `{{leadId}}-{{campaignId}}` per idempotenza forte).',
    },

    // ────────── Tracking config ──────────
    {
      key: 'trackOpens', label: 'Traccia aperture (pixel)', type: 'boolean', required: false,
      defaultValue: 'true',
      help: 'On: inietta un img 1x1 GIF trasparente che chiama il runtime quando il client ' +
        'carica l\\\'email. Spegni solo per mailing legali / molto formali o per evitare il bollo ' +
        '"contenuto bloccato" su client conservatori (Outlook desktop).',
    },
    {
      key: 'trackClicks', label: 'Traccia click (URL rewrite)', type: 'boolean', required: false,
      defaultValue: 'true',
      help: 'On: ogni <a href> viene riscritto in un redirect tracciato. Spegni quando il body ' +
        'contiene link sensibili (es. password reset) che NON vuoi loggare.',
    },
    {
      key: 'trackingBaseUrl', label: 'URL base tracking', type: 'text', required: false,
      placeholder: 'https://mio-tenant.app.automazionezeli.com',
      help: 'Dominio del tuo runtime FlowForge. Il pixel diventa <baseUrl>/api/track/open/<token> e ' +
        'i click <baseUrl>/api/track/click/<token>?u=<dest>. Se vuoto, eredita da ' +
        'MEDEA_PUBLIC_BASE_URL nel container (preimpostato al provision).',
    },
    {
      key: 'clickWhitelist', label: 'Domini permessi nei link', type: 'chip-list', required: false,
      placeholder: 'example.com, mio-dominio.com',
      help: 'Lista di domini (suffix-match) per cui i link vengono riscritti col tracking. ' +
        'Tutti gli altri restano LINK DIRETTI (senza tracking). Difesa anti open-redirect: ' +
        'qualcuno che inietta un link nel template non puo\\` usare il TUO dominio per ' +
        'redirigere a URL malevoli. Lascia vuoto per usare solo il dominio del trackingBaseUrl. ' +
        'Metti "*" (sconsigliato) per riscrivere QUALSIASI link.',
    },

    // ────────── GDPR ──────────
    {
      key: 'requireConsent', label: 'Richiede consenso GDPR upstream', type: 'boolean', required: false,
      defaultValue: 'true',
      help: 'On (default): l\\\'invio fallisce se l\\\'input upstream non ha `consentVerified=true`. ' +
        'Spegni SOLO per email transazionali non commerciali (ricevute ordine, recupero password, ' +
        'notifiche operative): per quelle il consenso non e\\` richiesto ex art.7 e-Privacy.',
    },
    {
      key: 'sampleRate', label: 'Frazione invio (0–1)', type: 'number', required: false,
      defaultValue: '1',
      help: 'A/B test ratio. 1 = invia a tutti (default). 0.5 = al 50%. ' +
        '0.1 = al 10% (test pilot). Implementato dal workflow chiamante.',
    },

    // ────────── Knobs ──────────
    {
      key: 'timeoutMs', label: 'Timeout SMTP (ms)', type: 'number', required: false,
      defaultValue: '30000',
      help: 'Quando il server SMTP non risponde entro N ms, il nodo fallisce. ' +
        '30s di default coprono il 99esimo percentile dei mail server seri.',
    },
  ],

  vendor: 'flowforge',
  version: '1.0.0',
  cost: { typicalLatencyMs: 1200 },
};
