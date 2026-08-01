import type { NodeModule } from '../types.js';

/**
 * WhatsApp trigger — inbound Meta Cloud API (Graph) webhook receiver.
 *
 * Gemello in-ingresso di `action_whatsapp_send`: quel nodo INVIA via Cloud
 * API, questo RICEVE i messaggi del cliente e avvia il workflow (1 run per
 * messaggio). Il protocollo Meta impone due flussi sullo stesso endpoint:
 *
 *   GET  = verification handshake (hub.mode/hub.verify_token/hub.challenge)
 *          → echo del challenge SOLO se il verify token combacia
 *   POST = eventi firmati X-Hub-Signature-256 (HMAC-SHA256 dell'App Secret
 *          sui byte esatti del body) → normalizzazione + run
 *
 * L'endpoint runtime vive in apps/flowforge-runtime/src/routes/whatsapp-trigger/
 * (verify.ts firma+handshake, normalize.ts payload→messaggi, index.ts route).
 */
export const whatsappTriggerNode: NodeModule = {
  def: {
    id: 'trigger_whatsapp',
    type: 'trigger',
    label: 'WhatsApp In',
    icon: 'message-circle',
    color: '#25D366',
    description:
      'Avvia il workflow quando un cliente scrive al tuo numero WhatsApp Business (Meta Cloud API ufficiale, ' +
      'Graph v18+). Ogni messaggio in arrivo = una run del workflow con payload GIÀ normalizzato: mittente E.164, ' +
      'nome profilo, tipo messaggio (text, interactive button/list reply, image, document, audio, video, sticker, ' +
      'location, contacts, reaction), testo o caption, riferimenti media (id, mimeType, sha256, filename) da ' +
      'scaricare via Graph API, e context di reply per i thread. L\'URL callback da incollare nel pannello Meta ' +
      'Business → WhatsApp → Configurazione → Webhook è https://<dominio-del-tuo-workspace>' +
      '/webhooks/whatsapp/<workflow-id> — l\'id del workflow compare nel path dell\'editor dopo il primo salvataggio.\n\n' +
      'Sicurezza fail-closed su entrambi i flussi del protocollo Meta: (a) il verification handshake GET risponde ' +
      'al hub.challenge SOLO se hub.verify_token combacia (confronto timing-safe) col Verify token configurato ' +
      'sotto — lo scegli tu e lo incolli identico nel pannello Meta; (b) ogni POST evento è accettato SOLO se la ' +
      'firma X-Hub-Signature-256 (HMAC-SHA256 dell\'App Secret sui byte esatti del body) è valida — App Secret ' +
      'mancante o firma errata = 401, mai esecuzione. Dedup automatico per message-id (Meta ri-consegna gli ' +
      'eventi non ACK-ati: lo stesso messaggio non fa MAI ripartire il workflow due volte, TTL 24h). Status ' +
      'update (sent/delivered/read) ignorati di default — attivabili con lo switch dedicato.\n\n' +
      'Differenza con i sibling: trigger_webhook = endpoint HTTP generico (nessuna semantica WhatsApp: handshake, ' +
      'firma Meta, dedup message-id e normalizzazione li dovresti costruire a mano); action_whatsapp_send = solo ' +
      'INVIO. Il pattern completo per un bot conversazionale è trigger_whatsapp → (logica/AI) → ' +
      'action_whatsapp_send: la risposta rientra nella finestra Customer Service di 24h aperta dal messaggio del ' +
      'cliente, quindi testo libero senza template pre-approvati.\n\n' +
      'Output per ogni run: { messageId, from, profileName, phoneNumberId, displayPhoneNumber, timestamp (ISO ' +
      '8601), type, text, interactive {id, title} | null, media {id, mimeType, sha256, caption, filename} | null, ' +
      'location {latitude, longitude, name, address} | null, replyToMessageId, kind: "message" | "status", raw }.\n\n' +
      'Use case: (1) bot ordinazioni pizzeria/ristorante — il cliente scrive, l\'AI agente legge menù e storico ' +
      'dal DB tenant e prende l\'ordine, conferma via action_whatsapp_send; (2) assistenza clienti con escalation ' +
      '— i messaggi entrano nel workflow, un logic_if smista per parola chiave a operatore umano via ' +
      'action_send_email; (3) raccolta documenti — il cliente invia foto della fattura, il workflow scarica il ' +
      'media via Graph API e lo passa a OCR/gestionale; (4) opt-in campagne — button reply "ISCRIVIMI" registrato ' +
      'in tabella DB con consenso tracciato GDPR.',
    configFields: [
      {
        key: 'verifyToken',
        label: 'Verify token (handshake Meta)',
        type: 'secret',
        required: true,
        help:
          'Stringa segreta che SCEGLI TU (es. generata random) e incolli identica nel campo ' +
          '"Verify token" del pannello Meta Business → WhatsApp → Configurazione → Webhook. ' +
          'Meta la rimanda nel GET di verifica: se non combacia, l\'handshake fallisce e ' +
          'il webhook non si attiva.',
      },
      {
        key: 'appSecret',
        label: 'App Secret (verifica firma)',
        type: 'secret',
        required: true,
        help:
          'App Secret dell\'app Meta (Business → Impostazioni app → Di base → App secret). ' +
          'Serve a verificare la firma X-Hub-Signature-256 di OGNI evento: senza firma valida ' +
          'la richiesta è respinta con 401. NON è l\'Access Token (quello va nel nodo WhatsApp di invio).',
      },
      {
        key: 'phoneNumberIdFilter',
        label: 'Filtro Phone Number ID (opzionale)',
        type: 'text',
        required: false,
        placeholder: '1234567890123456',
        help:
          'Se l\'app Meta gestisce PIÙ numeri WhatsApp, processa solo gli eventi di questo ' +
          'Phone Number ID (l\'ID numerico del pannello Meta, non il numero di telefono). ' +
          'Vuoto = accetta gli eventi di qualsiasi numero dell\'app.',
      },
      {
        key: 'includeStatuses',
        label: 'Avvia anche per status update',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help:
          'Se on: il workflow parte anche per gli status dei messaggi INVIATI (sent, delivered, ' +
          'read, failed) con kind="status". Default off: solo i messaggi in arrivo dei clienti ' +
          '(gli status di consegna sono rumore per un bot conversazionale).',
      },
    ],
    outputs: [
      'messageId', 'from', 'profileName', 'phoneNumberId', 'displayPhoneNumber',
      'timestamp', 'type', 'text', 'interactive', 'media', 'location',
      'replyToMessageId', 'kind', 'raw',
    ],
    outputContract: {
      fields: [
        { name: 'messageId', type: 'string', desc: 'ID Meta del messaggio (wamid.…) — chiave del dedup, stabile sui re-delivery' },
        { name: 'from', type: 'string', desc: 'Numero del mittente in E.164 SENZA "+" (es. 393331234567), come lo emette Meta' },
        { name: 'profileName', type: 'string | null', desc: 'Nome del profilo WhatsApp del cliente (contacts[0].profile.name) — null se assente' },
        { name: 'phoneNumberId', type: 'string', desc: 'Phone Number ID del TUO numero che ha ricevuto il messaggio' },
        { name: 'displayPhoneNumber', type: 'string | null', desc: 'Il tuo numero in formato leggibile (metadata.display_phone_number)' },
        { name: 'timestamp', type: 'string', desc: 'Istante del messaggio in ISO 8601 UTC (convertito dall\'epoch Meta)' },
        { name: 'type', type: 'string', desc: 'Tipo Meta: text | button | interactive | image | document | audio | video | sticker | location | contacts | reaction | unknown' },
        { name: 'text', type: 'string | null', desc: 'Corpo testuale unificato: text.body, caption dei media, titolo del button/list reply, emoji della reaction. null se il tipo non porta testo' },
        { name: 'interactive', type: '{ id, title } | null', desc: 'Per button_reply/list_reply: id e titolo della scelta. null altrimenti' },
        { name: 'media', type: '{ id, mimeType, sha256, caption, filename } | null', desc: 'Per image/document/audio/video/sticker: riferimenti per il download via Graph API (i byte NON sono inclusi). null altrimenti' },
        { name: 'location', type: '{ latitude, longitude, name, address } | null', desc: 'Per type=location. null altrimenti' },
        { name: 'replyToMessageId', type: 'string | null', desc: 'Se il cliente ha risposto a un messaggio specifico: l\'id quotato (context.id). null altrimenti' },
        { name: 'kind', type: '"message" | "status"', desc: '"message" = messaggio in arrivo; "status" = status update (solo con includeStatuses on)' },
        { name: 'raw', type: 'object', desc: 'L\'oggetto messaggio/status Meta originale non normalizzato (per i campi esotici)' },
      ],
      notes: 'Un POST Meta può contenere N messaggi (batching): ogni messaggio = una run separata con il SUO payload. Status update scartati salvo includeStatuses=true. Messaggio duplicato (stesso wamid entro 24h) = nessuna nuova run.',
    },
    searchAliases: ['whatsapp', 'wa', 'meta', 'chatbot', 'ricevi', 'inbound', 'messaggi', 'bot'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};
