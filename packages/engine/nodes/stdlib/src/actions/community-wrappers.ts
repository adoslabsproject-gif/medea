/**
 * Hi-level wrapper community nodes — alias semantici per i 3 integration_*.
 *
 * Pattern: stesso configFields shape, l'executor server delega all'integration
 * equivalente. Esistono per coerenza dataset AI scaffold + onboarding migliore
 * (utente cerca "Slack" → trova `community_slack` user-friendly).
 *
 * @module actions/community-wrappers
 */

import type { NodeModule } from '../types.js';

export const communitySlackNode: NodeModule = {
  def: {
    id: 'community_slack',
    type: 'action',
    label: 'Slack (community wrapper)',
    icon: 'slack',
    color: '#4A154B',
    description:
      'Wrapper enterprise high-level per il modulo integration_slack_post (Slack Web API chat.postMessage) che ' +
      'unifica i tre regimi di messaggistica sotto un\'unica interfaccia coerente con il pattern community_* del ' +
      'dataset AI scaffold di FlowForge: invio di messaggi plain text con mrkdwn slack-flavored, invio rich con ' +
      'Block Kit JSON (lo standard Slack 2025 per layout interattivi con header section, divider, buttons, image ' +
      'blocks, fields, accessory elements come datepicker e multi_static_select), e reply in thread esistente via ' +
      'thread_ts per consolidare le conversazioni del flow nello stesso topic invece di spammare il canale. ' +
      'Auth via OAuth2 token bot delegato dal Slack workspace owner — il token viene risolto dal vault integration ' +
      'tramite integrationLabel (multi-token support: un singolo tenant FlowForge può gestire 10+ workspace Slack ' +
      'come MSP), MAI hardcoded nei workflow per security. Supporta target canali pubblici (#general), privati ' +
      '(privatamente joined dal bot), DM diretti tramite user ID U0123456 e canali multi-channel guest. ' +
      'Fallback notification: se il canale ha "Slow mode" attivo o il bot non è membro, il nodo restituisce un ' +
      'errore semantico esplicito invece di silently fail. Anti-flood: respect del Slack rate limit Tier 1-4 ' +
      '(60 RPM, 600 RPM, 1200 RPM, 6000 RPM in base al tipo di workspace Plus/Enterprise), con backoff ' +
      'esponenziale automatico su 429 retry-after. Output: { ok, channel, ts (timestamp Slack del messaggio = ' +
      'thread_id univoco per replies successivi), permalink, threadParent? }. ' +
      'Use case: notifica completamento workflow critico al canale #ops-alerts con block "🟢 Backup OK \\n size: ' +
      '4.2GB \\n duration: 12min" e button "View dashboard" → click apre Grafana; daily standup automatico in ' +
      '#daily-standup alle 9:00 con riepilogo dei task chiusi ieri; notifica sales pipeline a #sales-room quando ' +
      'crm.lead Odoo passa a "Won" con valore expectedRevenue; alerting Sentinel WAF ban a #security con dettaglio ' +
      'IP/ASN/country/reason in section block formattato; pre-meeting reminder thread sotto un messaggio Calendly ' +
      'invece di creare noise nel canale.',
    configFields: [
      { key: 'integrationLabel', label: 'Etichetta integration (opzionale)', type: 'text', required: false },
      { key: 'channel', label: 'Canale', type: 'expression', required: true, placeholder: '#general', help: 'Channel ID o #nome.' },
      { key: 'text', label: 'Testo messaggio', type: 'expression', required: true, help: 'Plain text o mrkdwn Slack.' },
      { key: 'blocks', label: 'Block Kit JSON (opzionale)', type: 'code', language: 'json', required: false, help: 'Array di blocks per layout ricchi.' },
      { key: 'threadTs', label: 'Thread timestamp (opzionale)', type: 'expression', required: false, help: 'Reply a messaggio esistente.' },
      { key: 'unfurlLinks', label: 'Unfurl link automatico', type: 'boolean', required: false, defaultValue: 'true', help: 'Default true.' },
    ],
    outputs: ['ok', 'ts', 'channel', 'message'],
    vendor: 'flowforge',
    version: '1.0.0',
    cost: { typicalLatencyMs: 350 },
  },
};

export const communityTelegramNode: NodeModule = {
  def: {
    id: 'community_telegram',
    type: 'action',
    label: 'Telegram (community wrapper)',
    icon: 'send',
    color: '#0088cc',
    description:
      'Wrapper enterprise high-level per il modulo integration_telegram_send (Telegram Bot API ufficiale) che ' +
      'unifica i pattern di messaggistica più usati in workflow business sotto un\'unica interfaccia coerente ' +
      'con il pattern community_* del dataset AI scaffold FlowForge. Telegram è la piattaforma di messaging ' +
      'con 900M+ MAU usata massivamente in Italia/Russia/Iran/Brasile per community real-time, alert ops/devops ' +
      'team, bot di customer service, channel broadcast verso audience grosse (broadcast unidirezionale al ' +
      'canale, nessun limite di destinatari come WhatsApp Business — è il use case principale del Telegram bot ' +
      'in contesto enterprise EU). ' +
      'Operations supportate via Bot API: invio di messaggio testuale (sendMessage), invio di foto (sendPhoto ' +
      'con file upload o URL remoto), invio di documento (sendDocument per PDF/XLS allegati), invio di location ' +
      '(sendLocation per geolocation point), invio di voice/audio (sendVoice). Supporto pieno per parse mode ' +
      'MarkdownV2 (l\'incarnazione moderna di Telegram con escape stringente di tutti i caratteri speciali ' +
      '*_~`>#+-=|{}.!() per evitare 400 BadRequest, gestito automaticamente dal nodo) e HTML (subset sicuro ' +
      '<b><i><u><s><code><pre><a> più <span class="tg-spoiler"> per spoiler effect). ' +
      'Caption support per foto/video: testo descrittivo che appare sotto il media con stesso parse mode + ' +
      'formatting + emoji. Notifiche silenziose via disable_notification: il messaggio arriva nella chat ma ' +
      'NON triggera la notifica push del dispositivo destinatario, utile per low-priority updates che vuoi ' +
      'tracciare ma non disturbare l\'utente di notte ("backup completato OK alle 03:00", "report generato"). ' +
      'Auth via Bot Token (formato 123456789:AAExxxxxxx) ottenuto da @BotFather di Telegram quando si crea il ' +
      'bot. Token stored nel vault integration FlowForge. Multi-bot supportato (un tenant FlowForge che ' +
      'orchestra 5 bot Telegram diversi via integrationLabel). ' +
      'Target chat_id: numerico univoco identificante una chat 1-to-1 con uno user, oppure un group, oppure ' +
      'un channel. Per chat 1-to-1 l\'utente DEVE prima aver scritto al bot (limite anti-spam di Telegram, ' +
      'non possiamo iniziare la conversazione cold), per group/channel il bot DEVE essere stato aggiunto come ' +
      'member dall\'admin. ' +
      'Rate limit Telegram Bot API: 30 messaggi al secondo per bot in totale, 1 messaggio al secondo per chat ' +
      'individuale, 20 messaggi al minuto per group (cap automatic gestito dal nodo con 429 + retry exponential). ' +
      'Use case: broadcast alert critici a canale ops/sre quando workflow di produzione falliscono o sentinel ' +
      'rileva attacco (formato MarkdownV2 con bot icon custom); notifica end-user su esito ordine e-commerce ' +
      '("✅ Il tuo ordine #12345 è stato spedito con tracking GLS 9871234567"); invio quotidiano alle 08:00 di ' +
      'report metrico aziendale con foto chart embedded (generata da generateChart upstream) + caption con i ' +
      'top KPI del giorno precedente; notify silent al manager per low-priority updates senza il bip notifica ' +
      'che disturba durante una call ("processo notturno OK alle 02:30, no anomalie"); customer support ' +
      'bidirezionale dove il cliente scrive al bot e un workflow risponde con knowledge base AI suggested + ' +
      'fallback handoff umano via human_review_decision.',
    configFields: [
      { key: 'integrationLabel', label: 'Etichetta integration (opzionale)', type: 'text', required: false },
      { key: 'chatId', label: 'Chat ID o @username', type: 'expression', required: true, help: 'Numeric ID o @username pubblico.' },
      { key: 'text', label: 'Testo (o caption)', type: 'expression', required: false, help: 'Required se photoUrl vuoto.' },
      { key: 'photoUrl', label: 'URL foto (opzionale)', type: 'expression', required: false, help: 'Se valorizzato usa sendPhoto.' },
      { key: 'parseMode', label: 'Formato parse', type: 'select', required: false, defaultValue: 'MarkdownV2', options: ['MarkdownV2', 'HTML', 'Markdown', 'none'], help: 'Default MarkdownV2.' },
      { key: 'disableNotification', label: 'Notifica silenziosa', type: 'boolean', required: false, defaultValue: 'false' },
      { key: 'disableWebPagePreview', label: 'Disabilita preview link', type: 'boolean', required: false, defaultValue: 'false' },
    ],
    outputs: ['ok', 'messageId', 'chatId', 'date', 'mode'],
    vendor: 'flowforge',
    version: '1.0.0',
    cost: { typicalLatencyMs: 400 },
  },
};

export const communityLinearNode: NodeModule = {
  def: {
    id: 'community_linear',
    type: 'action',
    label: 'Linear (community wrapper)',
    icon: 'plus-circle',
    color: '#5E6AD2',
    description:
      'Wrapper enterprise high-level per il modulo integration_linear_create_issue (Linear GraphQL API ' +
      'createIssue mutation) che unifica il pattern community_* del dataset AI scaffold FlowForge per creare ' +
      'issue Linear. Linear è la piattaforma di project management built nell\'industry per startup tech moderne ' +
      'che vogliono velocità e UX cura (cresciuta a 10k+ paying customer dal 2020, popolarissima tra YC company ' +
      'e dev team distribuiti), alternativa moderna a Jira/Asana con keyboard-first UX, cycle-based planning, ' +
      'auto-archive completate, integration nativa GitHub/Slack/Figma. ' +
      'Crea issue completi via GraphQL API ufficiale Linear con tutti i campi principali del project management ' +
      'standard: team key (identificatore univoco del team destinatario, es. "ENG" per engineering, "DSGN" per ' +
      'design, "SUP" per support — Linear richiede team scope obbligatorio), title (oneline summary chiaro e ' +
      'concreto < 100 char), description markdown rich (Linear supporta GFM markdown completo + Linear-specific ' +
      'extensions tipo /collapse per collapsible sections, @user mention con autocomplete, link a altri issue ' +
      'con sintassi LIN-123), priority (1-4: urgent/high/medium/low — UI Linear lo mostra con icone ' +
      'color-coded per quick triage del team), assignee by email (l\'API Linear richiede assignee_id UUID, ' +
      'questo wrapper risolve automaticamente l\'email del responsabile al user_id corretto via team membership ' +
      'lookup — pattern friendly per non-tecnici che conoscono email ma non UUID), labels (array di label names ' +
      'come "bug", "feature_request", "documentation", "p0_critical" — il nodo risolve gli ID label dal name ' +
      'string contro la knowledge base del team), state (backlog/todo/in_progress/done — il default è il ' +
      'workflow_state default del team configurato in Settings Linear). ' +
      'Auth via Personal API Key (formato lin_api_xxxxxxxx generato dall\'admin in Settings → API → Personal ' +
      'API Keys) o OAuth2 per integration multi-user — stored nel vault integration FlowForge accessibile via ' +
      'integrationLabel. Rate limit: Linear non documenta hard limit ma il nodo usa 10 RPS sustained con ' +
      'backoff exponential su errori. ' +
      'Use case: creare bug Linear automatically da error tracker (webhook Sentry/Bugsnag/Datadog parsa ' +
      'l\'evento di errore e crea issue ENG-XXX con stack trace in description + priority urgent se affecting ' +
      '> 100 users); opening ticket support automatic da agent_email_triage_b2b_sales che classifica una email ' +
      'cliente come "support_request" → crea issue SUP-XXX con full body email + customer email come metadata ' +
      'per il customer success team; backlog auto-generato da customer feedback form (typeform/trigger_form) ' +
      'dove la categoria del feedback ("feature_request", "bug_report", "ui_complaint") mappa a team Linear ' +
      'diverso; handoff workflow → engineering con assignee email-resolved del lead engineer del team ' +
      'corrispondente al modulo affected, evitando ping manuale.',
    configFields: [
      { key: 'integrationLabel', label: 'Etichetta integration (opzionale)', type: 'text', required: false },
      { key: 'teamKey', label: 'Team key Linear', type: 'expression', required: true, placeholder: 'ENG' },
      { key: 'title', label: 'Titolo issue', type: 'expression', required: true },
      { key: 'description', label: 'Descrizione (markdown)', type: 'expression', required: false },
      { key: 'priority', label: 'Priorita\\` (0-4)', type: 'number', required: false, defaultValue: '0', help: '0=none, 1=urgent, 4=low.' },
      { key: 'assigneeEmail', label: 'Email assignee (opzionale)', type: 'expression', required: false },
      { key: 'labelNames', label: 'Labels (comma-separated)', type: 'expression', required: false },
    ],
    outputs: ['ok', 'issueId', 'identifier', 'url', 'title', 'state', 'warnings'],
    vendor: 'flowforge',
    version: '1.0.0',
    cost: { typicalLatencyMs: 600 },
  },
};
