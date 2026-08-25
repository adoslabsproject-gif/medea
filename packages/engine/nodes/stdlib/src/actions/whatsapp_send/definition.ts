/**
 * `action_whatsapp_send` — NodeDef metadata.
 *
 * @module actions/whatsapp_send/definition
 */

import type { NodeDef } from '@medea/engine-core-schema';

export const whatsAppSendNodeDef: NodeDef = {
  id: 'action_whatsapp_send',
  type: 'action',
  label: 'WhatsApp',
  icon: 'message-circle',
  color: '#25D366',
  description:
    'Invia messaggi WhatsApp Business via Meta Cloud API ufficiale (Graph v18+) usando i due regimi del ' +
    'protocollo: messaggi text in finestra di conversazione (validi solo nelle 24 ore successive a un messaggio ' +
    'in ingresso del cliente, secondo le policy Customer Service di WhatsApp Business) oppure messaggi template ' +
    'pre-approvati nel Business Manager (UTILITY, MARKETING, AUTHENTICATION) inviabili in qualsiasi momento. ' +
    'Supporta header media (immagine, video, documento, location), placeholder body con sostituzione posizionale ' +
    '(variabili numerate {{1}}, {{2}}, ...), bottoni quick-reply/url/call e lingua multipla. Validazione formato ' +
    'numero E.164 obbligatoria (+393331234567) con conversione automatica dai formati nazionali comuni. Rate limit ' +
    'Meta rispettato con backoff esponenziale e jitter. Errori semantici espliciti: 132xxx (template), 131xxx ' +
    '(numero), 80007 (rate). Output: { messageId, recipient, mode, response, billable, conversationCategory }. ' +
    "L'integrazione passa SOLO per Phone Number ID assegnato dall'app WhatsApp Business dedicata — nessun " +
    'accesso al numero personale del proprietario. Costi conversazione visibili in Insights Meta. ' +
    'Use case: notifica spedizione e-commerce con tracking number via template UTILITY, conferma appuntamento ' +
    'studio commercialista 24h prima con template AUTHENTICATION, ricezione documento via media header (cliente ' +
    'invia foto fattura → workflow estrae con OCR e crea fattura in Odoo), broadcast newsletter MARKETING con ' +
    'opt-out tracciato, escalation supporto tecnico real-time durante la finestra 24h con messaggi text plain.',

  configFields: [
    // ────────── Auth (sempre visibile) ──────────
    {
      key: 'phoneNumberId',
      label: 'Phone Number ID (Meta)',
      type: 'text',
      required: true,
      placeholder: '1234567890123456',
      help:
        "NON e` il tuo numero di telefono. E` l'ID NUMERICO che trovi nel pannello Meta " +
        'Business → WhatsApp → Configurazione API. Composto da soli numeri.',
    },
    {
      key: 'accessToken',
      label: 'Access Token (permanente)',
      type: 'secret',
      required: true,
      help:
        'Token di accesso permanente da Meta Business → Sistema Users → ' +
        'genera token con permesso whatsapp_business_messaging. ' +
        'Bypassa scadenza, da custodire come segreto.',
    },
    {
      key: 'apiVersion',
      label: 'Versione API Graph',
      type: 'select',
      required: false,
      options: ['v18.0', 'v19.0', 'v20.0', 'v21.0'],
      defaultValue: 'v20.0',
      help: 'Default v20.0. Cambia solo se Meta annuncia una deprecation.',
    },

    // ────────── Recipient (sempre visibile) ──────────
    {
      key: 'recipient',
      label: 'Destinatario (numero E.164)',
      type: 'expression',
      required: true,
      placeholder: '+39 333 1234567   oppure   {{input.phone}}',
      help:
        'Numero di telefono del destinatario in formato E.164. ' +
        'Spazi/trattini/parentesi vengono rimossi automaticamente. ' +
        'Il `+` opzionale.',
    },

    // ────────── Mode selector ──────────
    {
      key: 'mode',
      label: 'Modalita`',
      type: 'select',
      required: true,
      options: ['text', 'template'],
      defaultValue: 'text',
      help:
        'text = messaggio di testo libero. RICHIEDE che il cliente ti abbia scritto ' +
        'negli ultimi 24h (regola Meta). ' +
        'template = template pre-approvato in WhatsApp Business Manager. ' +
        "Funziona SEMPRE — l'unico modo per iniziare una nuova conversazione.",
    },

    // ────────── Text mode ──────────
    {
      key: 'body',
      label: 'Testo messaggio',
      type: 'expression',
      required: false,
      placeholder: 'Buongiorno {{input.nome}}, abbiamo ricevuto la sua PEC.',
      help: 'Testo del messaggio. Max 4096 caratteri. Supporta {{espressioni}}.',
      showIf: { field: 'mode', equals: 'text' },
    },
    {
      key: 'previewUrl',
      label: 'Anteprime link automatiche',
      type: 'boolean',
      required: false,
      defaultValue: 'false',
      help:
        'Se on, WhatsApp genera anteprime per i link nel body. ' +
        'Default off (UX piu` pulita + niente costo extra per la preview).',
      showIf: { field: 'mode', equals: 'text' },
    },

    // ────────── Template mode ──────────
    {
      key: 'templateName',
      label: 'Nome template',
      type: 'text',
      required: false,
      placeholder: 'pec_ricevuta_consegna',
      help:
        'Nome esatto del template come approvato in WhatsApp Business Manager. ' +
        'Case-sensitive. Solo template "APPROVED" funzionano (PENDING / REJECTED danno errore).',
      showIf: { field: 'mode', equals: 'template' },
    },
    {
      key: 'languageCode',
      label: 'Codice lingua',
      type: 'text',
      required: false,
      defaultValue: 'it',
      placeholder: 'it    oppure    en_US',
      help:
        'Codice lingua del template. Deve combaciare ESATTAMENTE con quello scelto ' +
        'in WhatsApp Business Manager. Formato xx oppure xx_XX.',
      showIf: { field: 'mode', equals: 'template' },
    },
    {
      key: 'componentsJson',
      label: 'Components (JSON array)',
      type: 'code',
      language: 'json',
      required: false,
      placeholder:
        '[{"type":"body","parameters":[{"type":"text","text":"{{input.nome}}"},{"type":"text","text":"{{$today}}"}]}]',
      help:
        'Array di components per popolare le variabili del template (placeholder {{1}}, {{2}}, ecc). ' +
        'Tipi parametro: text, currency, date_time, image, document, video. ' +
        'Vuoto = nessuna variabile (template fissi). ' +
        'Per dettagli: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages',
      showIf: { field: 'mode', equals: 'template' },
    },

    // ────────── HTTP ──────────
    {
      key: 'timeoutMs',
      label: 'Timeout HTTP (ms)',
      type: 'number',
      required: false,
      defaultValue: '15000',
      help: 'Range 1000-60000. Meta tipicamente risponde < 1s.',
    },
    {
      key: 'includePipelineLog',
      label: "Includi log nell'output",
      type: 'boolean',
      required: false,
      defaultValue: 'true',
    },
  ],

  outputContract: {
    notes: '`messageId` serve a correlare la conferma di consegna che arrivera` dopo per webhook: la consegna NON e` in questo output — qui c\'e` solo l\'accettazione da parte di WhatsApp.',
    fields: [
      { name: 'messageId', type: 'string', desc: 'L\'identificativo che WhatsApp ha assegnato al messaggio.' },
      { name: 'recipient', type: 'string', desc: 'Il numero a cui e` stato mandato.' },
      { name: 'mode', type: 'string', desc: 'Come e` stato mandato: testo libero o modello approvato.' },
      { name: 'response', type: 'object', desc: 'La risposta grezza dell\'API, per i dettagli.' },
      { name: 'pipelineSteps', type: 'array', desc: 'Il diario del passaggio. Presente solo col registro acceso.' },
    ],
  },
  vendor: 'flowforge',
  version: '1.0.0',
  cost: {
    typicalLatencyMs: 600,
  },
};
