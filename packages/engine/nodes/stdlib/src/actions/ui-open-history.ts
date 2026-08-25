/**
 * `ui_open_history` — helper UI per generare link al Run History view.
 *
 * Non e\` un'azione lato server tradizionale (no API call), e\` un helper che
 * produce in output URL deep-link al Run History del workflow corrente (o di un
 * workflow specifico), filtrato per stato/data.
 *
 * Use case
 * ────────
 * Email digest "✓ workflow OK / ✗ errors today: [link]" — il link punta al
 * Run History pre-filtrato per data e stato.
 *
 * @module actions/ui-open-history
 */

import type { NodeModule } from '../types.js';

export const uiOpenHistoryNode: NodeModule = {
  def: {
    id: 'ui_open_history',
    type: 'action',
    label: 'UI: Open Run History (link)',
    icon: 'history',
    color: '#64748b',
    description:
      'Helper enterprise specializzato per generare deep-link URL canonici verso la view "Run History" ' +
      "dell'editor FlowForge — il pannello slide-out che mostra l'elenco paginato di run di un workflow con " +
      'filtri rich (status, date range, error type, triggered_by, search nel JSON di input/output), pre-pronto ' +
      'da incorporare in qualunque output testuale del workflow downstream che andrà letto da un essere umano ' +
      '(email, notifica chat, SMS, dashboard print, PDF report) per consentirgli un single-click "vai a vedere ' +
      'i dettagli concreti senza dover navigare manualmente nell\'editor". ' +
      'Il workflow target è configurabile: il workflow corrente (self-link, default — il pattern più comune ' +
      'per email di errore: "questo workflow ha avuto X errori oggi, vedi dettagli") oppure un workflow target ' +
      'arbitrario via workflowId (utile per workflow di alerting/orchestration che fanno report cross-workflow). ' +
      'Filtri opzionali query string pre-applicati al link generato che selezionano automaticamente la view nel ' +
      'caricamento: stato (success | partial | error | running | paused | all), dateFrom/dateTo (ISO 8601 ' +
      'oppure espressioni relative tipo "today", "-7d", "last_month"), query search (full-text su input/output ' +
      'JSON content), triggerType (manual, webhook, cron, subworkflow), errorContains (filtro su error_message). ' +
      'URL generato è relativo al baseUrl pubblico del tenant FlowForge (deriva dalla env ' +
      'MEDEA_PUBLIC_BASE_URL del container, tipicamente https://<slug>.app.automazionezeli.com) oppure ' +
      "assoluto se baseUrl override è impostato — il second'use case è quando si vuole forzare il link verso " +
      'la dashboard portal centrale (https://flowforge.automazionezeli.com) invece del subdomain tenant per ' +
      'casi di multi-tenancy reporting. ' +
      'Output: { url (string completo encoded), workflowId, queryString, isRelative }. ' +
      'Use case principali della pipeline notification: email digest serale "il workflow X ha avuto Y errori ' +
      'oggi → [vedi dettagli]" con click sul link che apre direttamente Run History filtrato per status=error ' +
      "date=today — l'operatore vede subito le 5 run errored senza navigare 4 click; report admin daily " +
      'inviato via PEC o email che linka cross-workflow gli incident del giorno; notifica Slack/Telegram/' +
      'Discord automatica con embed che include il link diretto al run history per consentire al team ' +
      'developer di triagare velocemente; alerting su SLO degraded (latency p99 > 10s) con embedded link al ' +
      "history filtrato per i run che hanno triggerato l'alarm; client-portal share token che restituisce un " +
      "URL preventivamente firmato per consentire al cliente esterno (senza login tenant) di vedere l'history " +
      'del SUO workflow ordinabile.',
    configFields: [
      {
        key: 'workflowId',
        label: 'Workflow ID (opzionale)',
        type: 'expression',
        required: false,
        help: 'Default: workflow corrente (context.workflowId). Specifica un altro workflowId per link cross-workflow.',
      },
      {
        key: 'statusFilter',
        label: 'Filtro stato',
        type: 'select',
        required: false,
        defaultValue: 'all',
        options: ['all', 'success', 'error', 'running'],
        help: 'Pre-filtra il run history su uno specifico stato.',
      },
      {
        key: 'dateFrom',
        label: 'Data da (ISO o expression)',
        type: 'expression',
        required: false,
        placeholder: '{{$today}}',
        help: 'Filtro temporale lower bound. Formato ISO 8601 (es. 2026-06-05) o expression FlowForge.',
      },
      {
        key: 'dateTo',
        label: 'Data a (ISO o expression)',
        type: 'expression',
        required: false,
        help: 'Filtro temporale upper bound.',
      },
      {
        key: 'searchQuery',
        label: 'Query search (opzionale)',
        type: 'expression',
        required: false,
        placeholder: 'error_code:TIMEOUT',
        help: 'Free-text filter applicato sul run history.',
      },
      {
        key: 'baseUrl',
        label: 'Base URL (opzionale)',
        type: 'text',
        required: false,
        placeholder: 'https://mio-tenant.app.automazionezeli.com',
        help: 'Default: usa MEDEA_PUBLIC_BASE_URL del container tenant. Override per email che vanno fuori dominio.',
      },
    ],
    outputs: ['url', 'workflowId', 'filters'],
    outputContract: {
      notes: 'Costruisce l\'indirizzo con cui aprire lo storico gia` filtrato: non apre niente da solo — `url` va messo in un messaggio o in una email.',
      fields: [
        { name: 'url', type: 'string', desc: 'L\'indirizzo dello storico coi filtri gia` applicati.' },
        { name: 'workflowId', type: 'string|null', desc: 'Il workflow a cui e` limitato. Null se li comprende tutti.' },
        { name: 'filters', type: 'object', desc: 'I filtri applicati: status, dateFrom, dateTo e search. Null quelli non impostati.' },
      ],
    },
    vendor: 'flowforge',
    version: '1.0.0',
    cost: { typicalLatencyMs: 1 },
  },
};
