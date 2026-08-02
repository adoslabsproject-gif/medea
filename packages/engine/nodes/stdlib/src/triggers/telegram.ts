import type { NodeModule } from '../types.js';

/**
 * Telegram trigger — inbound Bot API webhook receiver.
 *
 * Gemello in-ingresso di `integration_telegram_send` e sibling di
 * `trigger_whatsapp` (stessa architettura runtime: route dedicata, auth
 * fail-closed, dedup, payload normalizzato, 1 run per update). Telegram è
 * radicalmente più semplice di Meta: il bot si crea in 2 minuti da @BotFather
 * (zero verifica aziendale, zero costi, nessuna finestra 24h) — canale
 * perfetto per demo immediate e come canale ordini secondario gratuito.
 *
 * L'endpoint runtime vive in apps/engine/src/routes/telegram-trigger/.
 */
export const telegramTriggerNode: NodeModule = {
  def: {
    id: 'trigger_telegram',
    type: 'trigger',
    label: 'Telegram In',
    icon: 'send',
    color: '#26A5E4',
    description:
      'Avvia il workflow quando qualcuno scrive al tuo bot Telegram (Bot API ufficiale). Ogni update in arrivo = '
      + 'una run del workflow con payload GIÀ normalizzato: chatId e userId del mittente, username e nome, testo o '
      + 'caption, riferimenti media (file_id di foto/documento/audio/video/sticker da scaricare via getFile), '
      + 'posizione, risposte a messaggi (reply), e i click sui bottoni inline (callback_query) già estratti come '
      + 'interactive {id, title}. Il bot si crea in 2 minuti con @BotFather (/newbot → token) — nessuna verifica '
      + 'aziendale, nessun costo, nessun template pre-approvato: il canale più rapido per mettere in piedi un bot '
      + 'conversazionale o una demo dal vivo.\n\n'
      + 'Collegamento in 2 passi: (1) scegli un Secret token qui sotto; (2) registra il webhook con '
      + 'https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<dominio-workspace>/webhooks/telegram/'
      + '<workflow-id>&secret_token=<il-tuo-secret> — l\'id del workflow compare nel path dell\'editor dopo il '
      + 'primo salvataggio.\n\n'
      + 'Sicurezza fail-closed: ogni POST è accettato SOLO se l\'header X-Telegram-Bot-Api-Secret-Token combacia '
      + '(confronto timing-safe) col Secret token configurato — secret mancante o errato = 401, mai esecuzione. '
      + 'Dedup automatico per update_id (Telegram ri-consegna gli update non ACK-ati: lo stesso update non fa MAI '
      + 'ripartire il workflow due volte, TTL 24h). Risposta 200 immediata + run asincrona (Telegram ritenta i '
      + 'non-2xx). Messaggi editati ignorati di default — attivabili con lo switch dedicato.\n\n'
      + 'Differenza con i sibling: trigger_webhook = endpoint HTTP generico (dedup update_id, secret header e '
      + 'normalizzazione li dovresti costruire a mano); integration_telegram_send = solo INVIO. Il pattern completo '
      + 'per un bot è trigger_telegram → (logica/AI) → integration_telegram_send con chatId = quello ricevuto.\n\n'
      + 'Output per ogni run: { updateId, kind: "message" | "callback" | "edited", messageId, chatId, chatType, '
      + 'userId, username, firstName, text, interactive {id, title} | null, media {kind, fileId, mimeType, '
      + 'fileName, caption} | null, location {latitude, longitude} | null, replyToMessageId, timestamp (ISO 8601), '
      + 'raw }.\n\n'
      + 'Use case: (1) demo bot ordinazioni pizzeria dal vivo — bot creato al momento con @BotFather, stesso '
      + 'workflow AI del canale WhatsApp; (2) notifiche bidirezionali di squadra — il bot riceve comandi '
      + '(/stato, /report) e risponde con dati dai nodi DB; (3) raccolta documenti/foto dai clienti via chat; '
      + '(4) bottoni inline per conferme rapide (callback_query → interactive.id) senza digitare.',
    configFields: [
      {
        key: 'secretToken',
        label: 'Secret token (header webhook)',
        type: 'secret',
        required: true,
        help:
          'Stringa segreta che SCEGLI TU (1-256 char, lettere/numeri/_/-) e passi a setWebhook come '
          + '&secret_token=... Telegram la rimanda in OGNI POST nell\'header X-Telegram-Bot-Api-Secret-Token: '
          + 'se non combacia la richiesta è respinta con 401.',
      },
      {
        key: 'chatIdFilter',
        label: 'Filtro chat ID (opzionale)',
        type: 'text',
        required: false,
        placeholder: '-1001234567890',
        help:
          'Se valorizzato, processa solo gli update di questa chat (utile per bot ammessi in più gruppi). '
          + 'Vuoto = accetta qualsiasi chat.',
      },
      {
        key: 'includeEdited',
        label: 'Avvia anche per messaggi editati',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help:
          'Se on: il workflow parte anche quando un utente MODIFICA un messaggio già inviato '
          + '(kind="edited"). Default off: solo messaggi nuovi e click sui bottoni (i re-edit sono '
          + 'rumore per un bot conversazionale).',
      },
    ],
    outputs: [
      'updateId', 'kind', 'messageId', 'chatId', 'chatType', 'userId', 'username',
      'firstName', 'text', 'interactive', 'media', 'location', 'replyToMessageId',
      'timestamp', 'raw',
    ],
    outputContract: {
      fields: [
        { name: 'updateId', type: 'number', desc: 'update_id Telegram — chiave del dedup, stabile sui re-delivery' },
        { name: 'kind', type: '"message" | "callback" | "edited"', desc: 'message = messaggio nuovo; callback = click su bottone inline; edited = messaggio modificato (solo con includeEdited on)' },
        { name: 'messageId', type: 'number | null', desc: 'message_id del messaggio (per i callback: il messaggio che portava i bottoni)' },
        { name: 'chatId', type: 'number', desc: 'id della chat — è il valore da passare a integration_telegram_send per rispondere' },
        { name: 'chatType', type: 'string', desc: 'private | group | supergroup | channel' },
        { name: 'userId', type: 'number | null', desc: 'id Telegram del mittente (from.id) — identità stabile del cliente' },
        { name: 'username', type: 'string | null', desc: '@username del mittente, null se non impostato' },
        { name: 'firstName', type: 'string | null', desc: 'Nome del profilo del mittente' },
        { name: 'text', type: 'string | null', desc: 'Corpo unificato: text, caption dei media, o data del callback. null se il tipo non porta testo' },
        { name: 'interactive', type: '{ id, title } | null', desc: 'Per callback_query: id = callback data del bottone, title = testo del messaggio coi bottoni. null altrimenti' },
        { name: 'media', type: '{ kind, fileId, mimeType, fileName, caption } | null', desc: 'Per photo/document/voice/video/sticker: kind + file_id per il download via getFile (i byte NON sono inclusi; per le foto è la risoluzione più alta). null altrimenti' },
        { name: 'location', type: '{ latitude, longitude } | null', desc: 'Per messaggi posizione. null altrimenti' },
        { name: 'replyToMessageId', type: 'number | null', desc: 'Se il messaggio risponde a un altro: il message_id quotato. null altrimenti' },
        { name: 'timestamp', type: 'string', desc: 'Istante del messaggio in ISO 8601 UTC (dal date epoch Telegram)' },
        { name: 'raw', type: 'object', desc: 'L\'oggetto Update Telegram originale non normalizzato (per i campi esotici)' },
      ],
      notes: 'Un POST Telegram porta UN update → una run. Update duplicato (stesso update_id entro 24h) = nessuna nuova run. Messaggi editati scartati salvo includeEdited=true. I callback_query vanno comunque ACK-ati lato invio (answerCallbackQuery) per fermare lo spinner del client.',
    },
    searchAliases: ['telegram', 'bot', 'botfather', 'chatbot', 'ricevi', 'inbound', 'messaggi', 'tg'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};
