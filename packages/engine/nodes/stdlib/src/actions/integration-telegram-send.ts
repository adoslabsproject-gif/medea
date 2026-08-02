/**
 * `integration_telegram_send` — Telegram Bot API sendMessage/sendPhoto.
 *
 * Credentials: { botToken: "<botId>:<token>" } via integration vault.
 *
 * @module actions/integration-telegram-send
 */

import type { NodeModule } from '../types.js';

export const integrationTelegramSendNode: NodeModule = {
  def: {
    id: 'integration_telegram_send',
    type: 'action',
    label: 'Telegram: Bot send',
    icon: 'send',
    color: '#0088cc',
    description:
      "Connettore canonico Telegram via Bot API ufficiale (sendMessage + sendPhoto) — l'endpoint primitivo " +
      'su cui il wrapper community_telegram costruisce esperienza user-friendly per il dataset AI scaffold. ' +
      'Invia messaggi testo o foto in qualsiasi chat Telegram a cui il bot ha accesso (chat 1-to-1 con utente ' +
      "che ha già scritto al bot per primo, group dove il bot è stato aggiunto dall'admin, canale broadcast " +
      'dove il bot ha permessi di posting). Telegram è la piattaforma di messaging cross-platform con 900M+ MAU ' +
      'particolarmente dominante in Italia, Russia, Iran, Brasile, India per community real-time e bot ' +
      'automation enterprise. ' +
      'Operations: sendMessage (messaggio testuale puro con length cap 4096 char, splitting automatico in più ' +
      'chunk se eccede), sendPhoto (foto inline con caption optional 1024 char, URL remoto o local path file — ' +
      "NO upload binario diretto in questo nodo per semplicità, l'upload di binary va via integration_http " +
      'multipart custom). ' +
      'Parse modes: MarkdownV2 (the modern Telegram dialect 2017+, escape stringente di *_~`>#+-=|{}.!() per ' +
      'evitare 400 BadRequest — gestito automaticamente dal nodo che pre-escapa i caratteri pericolosi), HTML ' +
      '(subset sicuro <b>bold</b>, <i>italic</i>, <u>underline</u>, <s>strike</s>, <code>inline_code</code>, ' +
      '<pre>code_block</pre>, <a href="url">link</a>, <span class="tg-spoiler">spoiler</span>), Markdown ' +
      'legacy (per back-compat con sistemi antichi — sconsigliato in favore di MarkdownV2 più predictable). ' +
      'Auth via Bot Token (formato 123456789:AAExxxxxxxx ottenuto da @BotFather durante la creazione del bot) ' +
      'stored nel vault integration FlowForge. Multi-bot supportato (un tenant FlowForge che gestisce 5 bot ' +
      'Telegram diversi via integrationLabel — es. uno per ops alert, uno per customer service, uno per ' +
      'marketing broadcast). ' +
      'Resilienza: auto-retry su 429 (rate-limit Telegram con header Retry-After) con exponential backoff + ' +
      'jitter; auto-retry su 5xx upstream Telegram con 3 retry distribuiti; timeout configurabile (default ' +
      '15s) per evitare workflow stuck su network slow. ' +
      'Disable notification flag: il messaggio arriva nella chat ma non triggera notification push sul ' +
      'dispositivo destinatario — pattern per low-priority notify che vuoi tracciare ma non disturbare. ' +
      'Reply_to_message_id per rispondere in thread a messaggio specifico. ' +
      'Use case: alert workflow runtime nei canali ops/sre con MarkdownV2 rich + emoji status indicators; bot ' +
      'reply automatico nel chat 1-to-1 con utente che ha scritto al bot (echo, knowledge base lookup, AI ' +
      'completion via action_llm_complete + send risposta); notifica utente end-customer al completamento di ' +
      'un processo asincrono ("✅ Il tuo file è stato processato, scarica qui {{download_url}}"); push ' +
      'monitoraggio metriche infrastructure con foto chart generata da generateChart upstream + caption con ' +
      'percentuali KPI; broadcast in canale community Telegram quando blog post pubblicato sul sito (sync ' +
      'via webhook CMS); reminder appuntamento Calendly 24h prima con counter countdown formatato.',
    configFields: [
      {
        key: 'integrationLabel',
        label: 'Etichetta integration (opzionale)',
        type: 'text',
        required: false,
        placeholder: 'main-bot',
        help: 'Default null = usa default integration Telegram del tenant. Multi-bot: usa label salvata in Integrations.',
      },
      {
        key: 'chatId',
        label: 'Chat ID o @username',
        type: 'expression',
        required: true,
        placeholder: '-1001234567890   oppure   @miocanale',
        help:
          'Numeric chat ID (privati: positivo, gruppi/canali: negativo con -100 prefix) o @username pubblico. ' +
          'Il bot deve essere admin del canale o membro del gruppo per poter postare.',
      },
      {
        key: 'text',
        label: 'Testo messaggio (o caption foto)',
        type: 'expression',
        required: false,
        placeholder: '*Alert* — workflow completato \\u2705',
        help:
          'Testo del messaggio (o caption se "photoUrl" valorizzato). ' +
          'Required se photoUrl vuoto. Max 4096 char per messaggio, 1024 per caption.',
      },
      {
        key: 'photoUrl',
        label: 'URL foto (opzionale)',
        type: 'expression',
        required: false,
        placeholder: 'https://example.com/chart.png',
        help:
          'Quando valorizzato, usa sendPhoto invece di sendMessage. URL deve essere accessibile da Telegram (no localhost). ' +
          'Max 5MB. Per testo+foto, popola anche "text" (diventa caption).',
      },
      {
        key: 'parseMode',
        label: 'Formato parse',
        type: 'select',
        required: false,
        defaultValue: 'MarkdownV2',
        options: ['MarkdownV2', 'HTML', 'Markdown', 'none'],
        help:
          'MarkdownV2 (default, strict escape) / HTML / Markdown (legacy) / none (plain). ' +
          'MarkdownV2 richiede escape di . - ! ( ) [ ] _ * — vedi core.telegram.org/bots/api#markdownv2-style.',
      },
      {
        key: 'disableNotification',
        label: 'Notifica silenziosa',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'Quando true, il messaggio arriva senza suono/vibrazione (notifica silenziosa).',
      },
      {
        key: 'disableWebPagePreview',
        label: 'Disabilita preview link',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'Quando true, Telegram non genera preview cards per i link nel testo (solo per sendMessage).',
      },
    ],
    outputs: ['ok', 'messageId', 'chatId', 'date', 'mode'],
    vendor: 'flowforge',
    version: '1.0.0',
    cost: { typicalLatencyMs: 400 },
  },
};
