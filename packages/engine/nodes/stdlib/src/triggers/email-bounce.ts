import type { NodeModule } from '../types.js';

/**
 * trigger_email_bounce — innesca il workflow alla ricezione di un BOUNCE (Delivery
 * Status Notification, RFC 3464). Riusa il sottosistema IMAP (stesso poller di
 * trigger_imap: UID cursor, dedup Message-ID, markSeen, circuit breaker) + un parser
 * DSN che filtra: SOLO i messaggi riconosciuti come bounce avviano il workflow, e il
 * payload è arricchito con i dati del rimbalzo.
 *
 * I bounce diventano così eventi di prima classe: "email non recapitata → rimuovi dalla
 * lista / avvisa / aggiorna CRM", senza scrivere parser MIME a mano.
 */
export const emailBounceTriggerNode: NodeModule = {
  def: {
    id: 'trigger_email_bounce',
    type: 'trigger',
    label: 'Email Bounce (IMAP)',
    icon: 'mail',
    color: '#ef4444',
    searchAliases: ['bounce', 'rimbalzo', 'mailer-daemon', 'undelivered', 'dsn', 'non recapitata'],
    description:
      'Monitora una mailbox IMAP e avvia il workflow SOLO quando arriva un bounce (Delivery ' +
      'Status Notification, RFC 3464) — l\'avviso "email non recapitata" inviato da ' +
      'MAILER-DAEMON/postmaster. Le email normali nella stessa mailbox vengono ignorate.\n\n' +
      'Differenza con i sibling: trigger_email_bounce = SOLO i rimbalzi, con payload ' +
      'strutturato. Per ingest email generico (con filtri subject/from/allegati) usa ' +
      'trigger_imap. Per inviare email usa action_send_email.\n\n' +
      'Riconoscimento (RFC 3464/3463): rileva il report-type=delivery-status, la parte ' +
      'message/delivery-status o i campi DSN (Action/Status/Final-Recipient); in mancanza, ' +
      'i segnali deboli (mittente MAILER-DAEMON + subject di tipo "delivery failed"). ' +
      'Classifica hard (codice 5.x.x = permanente, rimuovi il contatto) vs soft (4.x.x = ' +
      'transitorio, ritenta più tardi).\n\n' +
      'Output del nodo (triggerInput.bounce): failedRecipients[], bounceType (hard|soft|' +
      'unknown), status (es. "5.1.1"), action, diagnosticCode, originalMessageId (per ' +
      "correlare al run d'invio), reportingMta. Più i campi email standard (subject, from, " +
      'date, headers).\n\n' +
      'Infrastruttura riusata da trigger_imap: cursore UID persistente, dedup per Message-ID ' +
      '(exactly-once), markSeen on-success, circuit breaker per host. Credenziali dal vault ' +
      'per-tenant (Settings → Email Accounts) o inline.\n\n' +
      'Use case: (1) cold outreach — rimuovi dalla lista i contatti con hard bounce per ' +
      'proteggere la reputation del dominio, (2) notifica al mittente quando una fattura PEC ' +
      "rimbalza, (3) aggiorna il CRM marcando l'indirizzo come non valido.",
    configFields: [
      {
        key: 'systemAccountId',
        label: 'Account email (Settings → Email Accounts)',
        type: 'email-account-picker',
        required: false,
        help: 'Account IMAP dal vault per-tenant. Se selezionato, host/port/credenziali vengono da lì.',
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
        help: 'Dove arrivano i bounce. Di norma INBOX (i DSN tornano al mittente). Se hai una regola che li smista, indica quella cartella.',
      },
      {
        key: 'pollIntervalSec',
        label: 'Intervallo polling (secondi)',
        type: 'number',
        required: false,
        defaultValue: '120',
        help: 'Frequenza di controllo. I bounce non sono urgenti → 120s di default.',
      },
      {
        key: 'onlyUnseen',
        label: 'Solo email NON LETTE',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'Se ON, considera solo i messaggi \\Seen=false. Il dedup resta sul Message-ID.',
      },
      {
        key: 'markSeen',
        label: 'Quando marcare come letta',
        type: 'select',
        options: ['on-success', 'always', 'never'],
        required: false,
        defaultValue: 'on-success',
        help: 'on-success (raccomandato) = marca letta solo se il workflow completa. always = sempre. never = mai.',
      },
      {
        key: 'tlsMode',
        label: 'Cifratura',
        type: 'select',
        options: ['tls', 'starttls', 'plain'],
        required: false,
        defaultValue: 'tls',
        help: 'tls = porta 993 (raccomandato). starttls = 143. plain = nessuna cifratura.',
      },
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};
