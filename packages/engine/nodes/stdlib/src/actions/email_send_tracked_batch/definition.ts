/**
 * `action_email_send_tracked_batch` — NodeDef.
 *
 * UI: identical look to the single-send sibling except for:
 *   - one "Lista destinatari" textarea-ish field (JSON inline OR fed
 *     from upstream via $json.recipients)
 *   - throttling section (rate, jitter, retry, budget)
 *
 * @module actions/email_send_tracked_batch/definition
 */

import type { NodeDef } from '@medea/engine-core-schema';

export const emailSendTrackedBatchNodeDef: NodeDef = {
  id: 'action_email_send_tracked_batch',
  type: 'action',
  label: 'Email: invia in batch con tracking',
  icon: 'send',
  color: '#0284c7',
  description:
    'Variante batch di action_email_send_tracked progettata per outreach commerciali a volume controllato ' +
    'rispettando le policy anti-spam dei provider SMTP enterprise (Gmail/Workspace, Outlook 365, Yahoo, ' +
    'transactional ESP come Mailgun/Postmark/SES). Accetta una lista di destinatari dove ogni elemento porta il ' +
    'proprio leadId univoco (per tracking analytics differenziato), i propri valori di sostituzione template ' +
    '(es. { "nome": "Mario", "azienda": "ACME", "settore": "Edilizia" }) e opzionalmente un proprio override di ' +
    'subject — utile per A/B testing del soggetto su sottoinsiemi della lista. Il loop di invio è serializzato ' +
    'con throttling configurabile in mail/ora (default 60, sotto la soglia Gmail di 100/h per evitare flag ' +
    'reputation IP) e jitter random ±20% sul delay tra invii (defense contro detection pattern automation di ' +
    'Gmail Postmaster Tools). Backoff esponenziale (5s → 30s → 2m → 10m) su HTTP 429 oppure SMTP 421 (Service ' +
    'not available, troppe connessioni), con retry budget configurabile (default 3 retry per destinatario). ' +
    'Budget temporale globale: se l\'esecuzione supera maxRunMinutes (default 50 minuti per stare sotto al ' +
    'timeout 60min default di nginx/Cloudflare), i destinatari non ancora processati vengono restituiti nel ' +
    'response array con flag requeued=true + last_error per essere ripresi dal cron upstream nel run successivo ' +
    '— pattern resumable enterprise vs all-or-nothing che blocca su grosse liste. ' +
    'GDPR gate identico al sibling singolo: requireConsent=true (default) richiede consentVerified=true per ' +
    'OGNI singolo destinatario della lista, non solo globale; un destinatario senza consenso viene saltato e ' +
    'segnato come { status: "skipped", reason: "missing_consent" } senza fallire l\'intero batch. ' +
    'Output: { stats: { sent, failed, retried, skipped, requeued, totalMs, effectiveRatePerHour, ' +
    'avgLatencyMs }, results: [{ recipient, leadId, status, messageId?, trackingIds?, error?, attempts }] }. ' +
    'Use case: SaaS B2B drip campaign onboarding con 500 trial new signup/settimana → invio 60/h × 8h/giorno ' +
    'distribuiti su 2 giorni rispettando Gmail SLA; cold outreach lead scraped da LinkedIn con personalizzazione ' +
    'per settore — utile A/B test sul subject "Ciao Mario" vs "ACME — proposta per settore Edilizia"; newsletter ' +
    'mensile a 2000 iscritti con sottoinsiemi geografici (jitter randomizza l\'ordine per non triggerare antispam ' +
    'su pattern "tutti gli @libero.it nei primi 30 minuti"); recall pre-scadenza abbonamenti con tracking apertura ' +
    'per identificare candidati lapsus alla cancellazione e prepare retention sales call.',

  configFields: [
    // ────────── Sender ──────────
    {
      key: 'systemAccountId',
      label: 'Account email di sistema',
      type: 'email-account-picker',
      required: false,
      help: 'Account configurato in Settings → Email accounts. Se OAuth Gmail, il token viene ' +
        'rinnovato automaticamente quando scade — il batch può durare ore senza interruzioni.',
    },
    {
      key: 'host', label: 'SMTP host (override)', type: 'text', required: false,
      help: 'Manuale (sconsigliato per batch).',
      showIf: { field: 'systemAccountId', equals: '' },
    },
    {
      key: 'port', label: 'SMTP porta', type: 'number', required: false, defaultValue: '587',
      help: '587 STARTTLS, 465 TLS implicito.',
      showIf: { field: 'systemAccountId', equals: '' },
    },
    {
      key: 'security', label: 'Sicurezza', type: 'select', required: false,
      options: ['starttls', 'tls', 'none'], defaultValue: 'starttls',
      help: 'Lascia starttls salvo motivi specifici.',
      showIf: { field: 'systemAccountId', equals: '' },
    },
    {
      key: 'username', label: 'SMTP username', type: 'text', required: false,
      help: 'Per Gmail: l\\\'email completa.',
      showIf: { field: 'systemAccountId', equals: '' },
    },
    {
      key: 'password', label: 'SMTP password', type: 'secret', required: false,
      help: 'Per Gmail: App Password. Per OAuth: NON COMPILARE.',
      showIf: { field: 'systemAccountId', equals: '' },
    },

    // ────────── Envelope template ──────────
    {
      key: 'from', label: 'Mittente (From) template', type: 'text', required: false,
      placeholder: 'commerciale@example.com',
      help: 'Indirizzo del mittente. Se vuoto e c\\\'e\\` un account di sistema, eredita il suo fromAddress.',
    },
    {
      key: 'replyTo', label: 'Reply-To', type: 'text', required: false,
      help: 'Indirizzo dove arrivano le risposte se diverso dal From.',
    },
    {
      key: 'subject', label: 'Oggetto template', type: 'text', required: true,
      placeholder: 'Ciao {{lead.name}} · una proposta da Redivivo Gin',
      help: 'Supporta interpolazione `{{vars}}` per ogni destinatario.',
    },
    {
      key: 'body', label: 'Corpo template (HTML)', type: 'textarea', required: true,
      help: 'Body template HTML. I link verso domini in `clickWhitelist` vengono tracciati; ' +
        'il pixel viene aggiunto in fondo. Le variabili `{{lead.field}}` per ogni destinatario.',
    },
    {
      key: 'bodyType', label: 'Tipo corpo', type: 'select', required: false,
      options: ['html', 'text'], defaultValue: 'html',
      help: 'HTML obbligatorio se vuoi il tracking pixel.',
    },

    // ────────── Tracking ──────────
    {
      key: 'campaignId', label: 'Campagna ID', type: 'text', required: true,
      placeholder: 'redivivo-2026-w23-enoteche-lazio',
      help: 'Stringa libera. Tutti i destinatari di questo batch ereditano questo campaignId.',
    },
    {
      key: 'trackOpens', label: 'Traccia aperture (pixel)', type: 'boolean', required: false, defaultValue: 'true',
      help: 'On: inietta pixel 1x1 in ogni email del batch.',
    },
    {
      key: 'trackClicks', label: 'Traccia click (URL rewrite)', type: 'boolean', required: false, defaultValue: 'true',
      help: 'On: riscrive i link verso domini whitelisted.',
    },
    {
      key: 'trackingBaseUrl', label: 'URL base tracking', type: 'text', required: false,
      help: 'URL del runtime FlowForge. Vuoto = eredita MEDEA_PUBLIC_BASE_URL.',
    },
    {
      key: 'clickWhitelist', label: 'Domini permessi nei link', type: 'chip-list', required: false,
      help: 'Lista di domini (suffix-match) per il tracking link. Vuoto = solo trackingBaseUrl. ' +
        'Mettere "*" per riscrivere TUTTI i link (sconsigliato).',
    },

    // ────────── GDPR ──────────
    {
      key: 'requireConsent', label: 'Richiede consenso GDPR upstream', type: 'boolean', required: false,
      defaultValue: 'true',
      help: 'On (default): rifiuta il batch se l\\\'input non porta `consentVerified=true`.',
    },

    // ────────── Recipients ──────────
    {
      key: 'recipients', label: 'Lista destinatari (JSON inline)', type: 'json', required: false,
      help: 'Array `[{leadId, to, fromAddress?, templateVars?, sendId?}, …]`. Se vuoto, il nodo ' +
        'legge `$json.recipients` dall\\\'input upstream (tipicamente un db_query).',
    },

    // ────────── Throttling ──────────
    {
      key: 'ratePerHour', label: 'Rate (email/h)', type: 'number', required: false, defaultValue: '60',
      help: 'Cap superiore di mail/h. Gmail Workspace: 60-100/h per account è il safe spot. ' +
        'Salire a 300+/h significa segnalazioni "soft fail" o ban temporaneo.',
    },
    {
      key: 'jitter', label: 'Jitter (0–0.95)', type: 'number', required: false, defaultValue: '0.2',
      help: 'Variazione casuale del delay tra send (0 = cadenza fissa, 0.5 = ±50%). 0.2 default per ' +
        'apparire "umani" agli antispam senza spaccare il rate.',
    },
    {
      key: 'maxAttempts', label: 'Tentativi per destinatario', type: 'number', required: false, defaultValue: '3',
      help: 'Numero di tentativi (incluso il primo) prima di marcare un destinatario come fallito.',
    },
    {
      key: 'backoffBaseMs', label: 'Backoff base (ms)', type: 'number', required: false, defaultValue: '5000',
      help: 'Backoff esponenziale: backoffBaseMs · 2^(attempt-1), cap 60s. ' +
        '5_000 → tentativi a 5s, 10s, 20s.',
    },
    {
      key: 'budgetMs', label: 'Budget totale (ms, opzionale)', type: 'number', required: false,
      help: 'Tempo massimo del batch. Oltre questo, i destinatari residui escono con requeued=true ' +
        'cosi\\` un cron a monte li riprende. Vuoto = 2× il tempo ideale.',
    },
  ],

  vendor: 'flowforge',
  version: '1.0.0',
  cost: { typicalLatencyMs: 90_000 },
};
