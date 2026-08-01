/**
 * `integration_slack_post` — Slack Web API chat.postMessage.
 *
 * Use case
 * ────────
 * Notifica un canale Slack (alert, deploy report, daily digest, agent reply).
 * Supporta:
 *   - Plain text + emoji
 *   - Block Kit (layouts, buttons, sections)
 *   - Thread reply (thread_ts)
 *   - Attachment legacy (per back-compat)
 *
 * Credentials: integration vault → { botToken: "xoxb-..." }
 *
 * Output
 * ──────
 *   {
 *     ok: true, ts: '<message_ts>', channel: '<channel_id>',
 *     message: { text, ts, user, bot_id }
 *   }
 *
 * @module actions/integration-slack-post
 */

import type { NodeModule } from '../types.js';

export const integrationSlackPostNode: NodeModule = {
  def: {
    id: 'integration_slack_post',
    type: 'action',
    label: 'Slack: Post message',
    icon: 'slack',
    color: '#4A154B',
    description:
      'Connettore canonico Slack via Web API ufficiale chat.postMessage — l\'endpoint scaffold di tutta la ' +
      'famiglia Slack messaging del workflow stack, utilizzato dal wrapper community_slack che incapsula ' +
      'pattern community-friendly per il dataset AI scaffold. Posta un messaggio in un canale Slack del ' +
      'workspace autorizzato con supporto pieno alle tre features avanzate della piattaforma: ' +
      '(1) Plain text con emoji (sintassi shortcode :rocket: :heart: :tada: che Slack converte server-side in ' +
      'emoji visuali + supporto a custom emoji aziendali :it_team: caricate dall\'admin del workspace), ' +
      '(2) Block Kit (lo standard Slack 2018+ per layout rich JSON-defined: header section per titoli grandi, ' +
      'section blocks con accessory (button, multi_static_select, datepicker, image), divider per separazione ' +
      'logica, image blocks con alt_text per accessibility, fields array a 2-colonne per metadata strutturati, ' +
      'context block per metadata small + author, actions row con multi-button per interactive payload back), ' +
      '(3) Thread reply via thread_ts (passa il ts del messaggio parent come thread_ts → la response appare ' +
      'come reply nel thread invece di nuovo messaggio standalone — fondamentale per consolidare conversazioni ' +
      'su un topic specifico ed evitare di spammare il canale principale con N messaggi disgiunti). ' +
      'Auth via OAuth Bot Token (formato xoxb-* generato durante l\'install della Slack App nel workspace, con ' +
      'scopes minimum chat:write + chat:write.public + chat:write.customize per posting con username/icon ' +
      'custom). Token stored nel vault integration FlowForge accessibile da Settings → Integrations → Slack ' +
      'nell\'editor tenant, mai hardcoded nel workflow per security. ' +
      'Channel resolution: il channel può essere passato come "#general" (humanReadable), "C0123456789" (ID ' +
      'channel univoco Slack — più robusto perché un canale rinominato preserva l\'ID), oppure user ID ' +
      'U0123456789 per DM diretto al singolo membro. Il bot deve essere stato esplicitamente "added" al ' +
      'canale privato per posting (errore canonico not_in_channel se manca). ' +
      'Idempotency: Idempotency-Key generata automaticamente da runId:nodeId della run corrente del workflow → ' +
      'in caso di retry del nodo per network blip o crash recovery, Slack non duplica il messaggio (il pattern ' +
      'più importante per evitare il #1 incident customer support "il bot ha postato 5 volte lo stesso alert"). ' +
      'Rate limit Slack Tier 1 (default per Bot Token): 1 req/sec sustained con burst di 10/sec — il nodo ' +
      'rispetta header X-RateLimit-Remaining e usa Retry-After su 429 con jitter. ' +
      'Block Kit reference completo: api.slack.com/block-kit/building (l\'admin Slack del workspace può ' +
      'sperimentare layouts via Block Kit Builder visual no-code). ' +
      'Use case: alert run workflow falliti nel canale #ops con block kit "🔴 Workflow {{name}} ha fallito" + ' +
      'context block "run_id: {{runId}} | error: {{error.message}}" + button "Open dashboard" che linka a ' +
      'ui_open_history; deploy report enterprise post-CI con embed completo (commit author, changes count, ' +
      'test results, deploy duration); daily digest delle 08:00 con riassunto KPI del giorno precedente ' +
      'generato da agent_business_summarizer e formattato in Block Kit ricco; AI agent reply automatic nel ' +
      'canale #support quando un customer scrive una domanda ricorrente (knowledge base match + AI completion ' +
      'restituita come messaggio thread).',
    configFields: [
      {
        key: 'integrationLabel',
        label: 'Etichetta integration (opzionale)',
        type: 'text',
        required: false,
        placeholder: 'main-workspace',
        help: 'Default null = usa la default integration Slack del tenant. ' +
          'Per multi-workspace (es. cliente + interno) specifica la label salvata in Integrations.',
      },
      {
        key: 'channel',
        label: 'Canale',
        type: 'expression',
        required: true,
        placeholder: '#general   oppure   C0123456789',
        help: 'Channel ID (C0123…) o nome (#general). Bot deve essere membro del canale.',
      },
      {
        key: 'text',
        label: 'Testo messaggio',
        type: 'expression',
        required: true,
        placeholder: 'Hello :wave: deploy completato!',
        help: 'Testo plain o markdown Slack (mrkdwn). Emoji shortcut supportati (:tada:, :rocket:). ' +
          'Quando `blocks` e\\` settato, questo testo viene usato come fallback (notification + accessibility).',
      },
      {
        key: 'blocks',
        label: 'Block Kit JSON (opzionale)',
        type: 'code',
        language: 'json',
        required: false,
        placeholder: '[{ "type": "section", "text": { "type": "mrkdwn", "text": "*Hello*" } }]',
        help: 'Array di Block Kit blocks. Quando popolato, sovrascrive il render del campo "text" ' +
          '(che resta comunque fallback per notification + screen reader).',
      },
      {
        key: 'threadTs',
        label: 'Thread timestamp (opzionale)',
        type: 'expression',
        required: false,
        placeholder: '{{$node.previousPost.json.ts}}',
        help: 'Quando popolato, posta come REPLY a un messaggio esistente. Usa il `ts` del messaggio padre.',
      },
      {
        key: 'unfurlLinks',
        label: 'Unfurl link automatico',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help: 'Default true. Quando false, Slack non genera preview cards per i link nel messaggio.',
      },
    ],
    outputs: ['ok', 'ts', 'channel', 'message'],
    vendor: 'flowforge',
    version: '1.0.0',
    cost: { typicalLatencyMs: 350 },
  },
};
