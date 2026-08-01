/**
 * `trigger_odoo_polling` — definition-only trigger (NodeDef metadata).
 *
 * What it does (runtime-side)
 * ───────────────────────────
 * The Odoo polling trigger is consumed by the workflow runtime's trigger
 * scheduler (NOT a per-tick executor on the stdlib side). At every
 * `pollIntervalSec` it:
 *
 *   1. Authenticates against `baseUrl` / `database` / `login` / `password`.
 *   2. Calls `search_read` on `model` with the configured `domainJson`
 *      filter AND an implicit cursor: `[("id", ">", lastSeenId)]`.
 *   3. For every new record, fires ONE run of the workflow with the record
 *      as the trigger input.
 *   4. Persists `lastSeenId` (the max id of the batch) in the trigger
 *      state store so the next poll picks up where it left off.
 *
 * Why this lives in stdlib as a Def-only module
 * ─────────────────────────────────────────────
 * The polling LOOP itself is engine-side concern (it needs the trigger
 * scheduler + state store). What WE own is the NodeDef metadata: how the
 * user configures it, the help texts, the validation hints. The runtime
 * reads this def from the registry and wires up the polling loop with
 * the user-supplied config. Same pattern as the existing IMAP/PEC
 * triggers — they too are definition-only.
 *
 * @module triggers/odoo_polling
 */

import type { NodeModule } from '../../types.js';

export const odooPollingTriggerNode: NodeModule = {
  def: {
    id: 'trigger_odoo_polling',
    type: 'trigger',
    label: 'Odoo: New record',
    icon: 'database',
    color: '#714B67',
    description:
      'Innesco di polling enterprise che firma un nuovo run del workflow ogni volta che compare un nuovo record ' +
      'in un modello Odoo specificato — sostituisce l\'assenza di webhook nativi del core Odoo Community (su ' +
      'Enterprise esiste il modulo automation ma richiede l\'installazione e setup non sempre fattibile in ' +
      'tenant cliente). Architettura: il trigger scheduler del runtime FlowForge invoca questo trigger ogni ' +
      'pollIntervalSec (default 60s, range 15s-3600s in base alla criticità — 15s per ordini e-commerce, 5min ' +
      'per nuovi lead, 1h per anagrafica), autentica via /xmlrpc/2/common, esegue search_read sul modello ' +
      'configurato con domain filter dell\'utente + un cursor implicito [("id", ">", lastSeenId)] che garantisce ' +
      'EXACTLY-ONCE delivery anche in presenza di crash del runtime, recovery, network blip o spostamento di ' +
      'container tra host (lastSeenId è persisto nello state store del trigger, non in memoria volatile). Per ' +
      'ogni nuovo record trovato, parte un singolo run del workflow con il record completo come trigger input — ' +
      'i tuoi nodi downstream possono leggere fields["name"], fields["email"], ecc. direttamente. Dopo ogni ' +
      'batch processato, lastSeenId è aggiornato al MAX(id) del batch in un\'unica transazione atomica per ' +
      'evitare race-condition tra polling overlap (es. polling interval più breve della latency del run). ' +
      'Edge case: se un workflow downstream è lento (es. fa LLM call), un nuovo polling parte comunque (non c\'è ' +
      'mutex globale sul trigger) ma il cursor protegge da duplicate processing — la peggiore cosa che può ' +
      'succedere è una micro-latency extra sul DB Odoo, non un duplicate run. ' +
      'Rispetta i record rules dell\'utente di login (che vede solo i record permessi dalla sua security group), ' +
      'quindi creare un utente Odoo dedicato "Workflow Bot FlowForge" con accessi minimi è raccomandato per ' +
      'limitare l\'esposizione. ' +
      'Esempi tipici di modelli pollati: crm.lead per nuovi lead da form web Odoo (alimenta sales sequence), ' +
      'mail.message per nuovi messaggi nel chatter (utile per audit di interazioni cliente), res.partner per ' +
      'nuove anagrafiche aggiunte manualmente da segreteria (sincronizza con MailChimp/HubSpot), sale.order ' +
      'per nuovi ordini in stato draft (revisione automatica), helpdesk.ticket per nuovi ticket assegnati da ' +
      'frontoffice (alerting whatsapp al team tecnico), account.move per fatture appena emesse (export verso ' +
      'gestionale esterno o sistema banca per anticipo fattura). ' +
      'Use case operativi: studio commercialista polleha crm.lead ogni 5min — ogni nuovo lead da Google Ads form ' +
      'lancia un workflow che fa scoring, manda email benvenuto e crea attività su mail.activity per il junior; ' +
      'e-commerce wine.it polleha sale.order ogni 60s — nuovo ordine triggera workflow di verifica giacenza ' +
      'magazzino + email conferma + creazione spedizione GLS; SaaS B2B polleha res.partner solo dei contatti ' +
      'creati negli ultimi 7gg per active_customer_rank > 0 — sync verso HubSpot CRM per il team marketing.',

    configFields: [
      // ────────── Auth (sempre visibile) ──────────
      {
        key: 'baseUrl',
        label: 'URL Odoo (https://)',
        type: 'text',
        required: true,
        placeholder: 'https://mio-odoo.example.it',
        help: 'URL base della tua istanza Odoo. https:// obbligatorio in produzione. ' +
          'Senza /web, senza /xmlrpc.',
      },
      {
        key: 'database',
        label: 'Nome database',
        type: 'text',
        required: true,
        placeholder: 'odoo_studiocommercialista',
      },
      {
        key: 'login',
        label: 'Utente Odoo',
        type: 'text',
        required: true,
        placeholder: 'workflow.bot@studiocommercialista.it',
        help: 'Utente con permessi di sola lettura sui modelli che vuoi triggherare. ' +
          'Per produzione crea un utente dedicato "Workflow Bot" con accesso minimo.',
      },
      {
        key: 'password',
        label: 'Password o API Key',
        type: 'secret',
        required: true,
        help: 'API Key (Odoo 14+) raccomandato. Bypassa il 2FA e non scade.',
      },

      // ────────── Modello target ──────────
      {
        key: 'model',
        label: 'Modello Odoo',
        type: 'text',
        required: true,
        placeholder: 'crm.lead    oppure    mail.message    oppure    res.partner',
        help: 'Nome tecnico del modello. Esempi: crm.lead (nuovi lead), ' +
          'mail.message (nuovi messaggi/email), res.partner (nuovi contatti), ' +
          'account.move (fatture). Lowercase con punti.',
      },
      {
        key: 'domainJson',
        label: 'Domain (filtro)',
        type: 'code',
        language: 'json',
        required: false,
        placeholder: '[["stage_id","=",1], ["team_id","=",5]]',
        help: 'Filtra ulteriormente i nuovi record. Array di triple ' +
          '[campo, operatore, valore]. Solo i record che matchano avviano il workflow. ' +
          'Vuoto = tutti i nuovi record nel modello (rispetta record rules).',
      },
      {
        key: 'fieldsJson',
        label: 'Campi da leggere',
        type: 'code',
        language: 'json',
        required: false,
        placeholder: '["id","name","email","phone","partner_name","stage_id"]',
        help: 'Array di nomi campo da includere nel trigger input. ' +
          'Vuoto = tutti (lento, paylod grande). ' +
          'Tipicamente leggi solo i campi che il workflow usa.',
      },

      // ────────── Polling cadence ──────────
      {
        key: 'pollIntervalSec',
        label: 'Intervallo polling (secondi)',
        type: 'number',
        required: false,
        defaultValue: '60',
        help: 'Frequenza polling. Default 60s (1 round/min). ' +
          'Range 10-3600 (max 1h). Sotto i 30s carica troppo Odoo per nessun beneficio.',
      },
      {
        key: 'batchLimit',
        label: 'Max record per poll',
        type: 'number',
        required: false,
        defaultValue: '50',
        help: 'Numero massimo di nuovi record da elaborare PER POLL. ' +
          'Se ne arrivano di piu`, gli altri sono presi nel poll successivo. ' +
          'Range 1-500. Protegge da burst nemicizzanti il LLM downstream.',
      },
      {
        key: 'initialBacklog',
        label: 'Backlog iniziale',
        type: 'select',
        required: false,
        options: ['skip', 'last-24h', 'last-week', 'all'],
        defaultValue: 'skip',
        help: 'Cosa fare al PRIMO avvio del trigger (quando lastSeenId e` ignoto). ' +
          'skip = ignora tutto il preesistente (default, comportamento "da ora in poi"). ' +
          'last-24h / last-week = recupera solo i record creati nelle ultime 24h / settimana. ' +
          'all = scorre TUTTI i record esistenti (può essere migliaia, attento al cost).',
      },

      // ────────── HTTP knobs ──────────
      {
        key: 'timeoutMs',
        label: 'Timeout HTTP (ms)',
        type: 'number',
        required: false,
        defaultValue: '30000',
        help: 'Range 1000-180000.',
      },
    ],

    vendor: 'flowforge',
    version: '1.0.0',
    cost: {
      typicalLatencyMs: 200,
    },
  },
};
