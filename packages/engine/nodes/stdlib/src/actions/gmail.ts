/**
 * action_gmail — nodo Gmail dedicato (OAuth Google).
 *
 * Distinto dal nodo Email IMAP generico (che resta invariato): questo parla
 * direttamente con l'API Gmail usando l'integrazione OAuth del tenant
 * (provider `gmail`, scope gmail.send + gmail.readonly, auto-refresh del token).
 * L'esecuzione vera è nel runtime: executors/integrations/gmail.ts.
 *
 * Un unico nodo con tre operazioni (send / list / get) — pattern resource+
 * operation à la n8n. I campi si mostrano/nascondono via `showIf`.
 *
 * @module actions/gmail
 */
import type { NodeModule } from '../types.js';

const IF_SEND = { field: 'operation', equals: 'send' } as const;
const IF_LIST = { field: 'operation', equals: 'list' } as const;
const IF_GET = { field: 'operation', equals: 'get' } as const;

export const gmailNode: NodeModule = {
  def: {
    id: 'action_gmail',
    type: 'action',
    label: 'Gmail',
    icon: 'mail',
    color: '#ea4335',
    description:
      'Nodo Gmail dedicato via API Google (OAuth). Distinto dal nodo Email IMAP generico: usa la connessione ' +
      "Google del tenant (Impostazioni → Integrazioni), con refresh automatico e trasparente dell'access token " +
      '— nessun re-login ad ogni esecuzione. Tre operazioni:\n' +
      "  • send — manda un'email: destinatari to/cc/bcc, oggetto, corpo in testo e/o HTML, allegati opzionali. " +
      "Il messaggio parte dall'indirizzo Google connesso.\n" +
      '  • list — cerca messaggi con la sintassi di ricerca Gmail (es. "from:cliente@x.it is:unread newer_than:7d") ' +
      'e restituisce mittente, oggetto, data e anteprima dei risultati.\n' +
      '  • get — legge un messaggio per id: intestazioni, corpo (testo + HTML) ed elenco allegati.\n' +
      'Sicurezza: le credenziali stanno nel vault cifrato del tenant, mai nel workflow; le chiamate passano dal ' +
      'guard anti-SSRF/esfiltrazione del runtime. Per la posta non-Gmail (qualsiasi provider IMAP/SMTP) usa il ' +
      'nodo Email generico.\n' +
      'Use case: notifiche automatiche ai clienti direttamente dal workflow, invio di report o fatture PDF ' +
      'generati da un nodo a monte, triage della posta in arrivo (leggi le non lette, classifica con un nodo AI, ' +
      'rispondi o instrada), estrazione di ordini e richieste dalle email ricevute, follow-up commerciali ' +
      'programmati, inoltro condizionale di messaggi verso team diversi in base al contenuto.',
    configFields: [
      {
        key: 'operation',
        label: 'Operazione',
        type: 'select',
        options: ['send', 'list', 'get'],
        required: true,
        defaultValue: 'send',
        help: 'send = invia · list = cerca messaggi · get = leggi un messaggio.',
      },
      {
        key: 'integrationLabel',
        label: 'Account Google (opzionale)',
        type: 'text',
        required: false,
        help: "Se hai connesso più account Google, indica la label dell'integrazione da usare. Vuoto = quella predefinita.",
      },
      // ── send ──────────────────────────────────────────────────────────
      {
        key: 'to',
        label: 'A (To)',
        type: 'text',
        required: false,
        showIf: IF_SEND,
        placeholder: 'mario@esempio.it, lucia@esempio.it',
        help: 'Uno o più destinatari separati da virgola. Obbligatorio per send.',
      },
      { key: 'cc', label: 'Cc', type: 'text', required: false, showIf: IF_SEND },
      { key: 'bcc', label: 'Ccn (Bcc)', type: 'text', required: false, showIf: IF_SEND },
      {
        key: 'replyTo',
        label: 'Rispondi a (Reply-To)',
        type: 'text',
        required: false,
        showIf: IF_SEND,
      },
      { key: 'subject', label: 'Oggetto', type: 'text', required: false, showIf: IF_SEND },
      {
        key: 'bodyText',
        label: 'Corpo (testo)',
        type: 'textarea',
        required: false,
        showIf: IF_SEND,
        help: 'Versione testo semplice. Puoi usare solo testo, solo HTML, o entrambi (multipart/alternative).',
      },
      {
        key: 'bodyHtml',
        label: 'Corpo (HTML)',
        type: 'rich-text',
        required: false,
        showIf: IF_SEND,
        help: "Versione HTML formattata. Se compili sia testo sia HTML, i client mostrano l'HTML.",
      },
      {
        key: 'attachmentsJson',
        label: 'Allegati (JSON)',
        type: 'json',
        required: false,
        showIf: IF_SEND,
        placeholder:
          '[{ "filename": "report.pdf", "content": "<base64>", "mimeType": "application/pdf" }]',
        help: "Array di allegati { filename, content (base64), mimeType }. Tipicamente collegato all'output di un nodo precedente (es. PDF: Genera → base64). Accetta anche il formato { name, base64, contentType }.",
      },
      // ── list ──────────────────────────────────────────────────────────
      {
        key: 'query',
        label: 'Ricerca Gmail (q)',
        type: 'text',
        required: false,
        showIf: IF_LIST,
        placeholder: 'is:unread from:cliente@x.it newer_than:7d',
        help: 'Sintassi di ricerca Gmail. Vuoto = messaggi più recenti.',
      },
      {
        key: 'maxResults',
        label: 'Numero massimo',
        type: 'number',
        required: false,
        defaultValue: '10',
        showIf: IF_LIST,
        help: 'Quanti messaggi restituire (1–25). Per ognuno vengono recuperati mittente/oggetto/data/anteprima.',
      },
      // ── get ───────────────────────────────────────────────────────────
      {
        key: 'messageId',
        label: 'ID messaggio',
        type: 'text',
        required: false,
        showIf: IF_GET,
        help: "L'id del messaggio (dal risultato di list o da un trigger). Obbligatorio per get.",
      },
    ],
    searchAliases: ['gmail', 'google mail', 'posta google', 'mail google', 'email google'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};
