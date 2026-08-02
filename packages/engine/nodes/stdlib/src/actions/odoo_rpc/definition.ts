/**
 * `action_odoo_rpc` — NodeDef metadata (5 operations, conditional fields).
 *
 * @module actions/odoo_rpc/definition
 */

import type { NodeDef } from '@medea/engine-core-schema';

export const odooRpcNodeDef: NodeDef = {
  id: 'action_odoo_rpc',
  type: 'action',
  label: 'Odoo',
  icon: 'database',
  color: '#714B67',
  description:
    'Connettore enterprise per Odoo Community ed Enterprise (versioni 14, 15, 16, 17, 18) via protocollo XML-RPC ' +
    'nativo sugli endpoint /xmlrpc/2/common e /xmlrpc/2/object. Cinque operazioni atomiche coprono il ciclo CRUD ' +
    'completo: search_read leggi record con domain filter (SELECT con WHERE Odoo-style), create per inserire ' +
    'una nuova istanza di un modello (INSERT), write per aggiornare record esistenti (UPDATE), unlink per la ' +
    'cancellazione logica (DELETE rispettando i record rules), call_method per invocare qualsiasi metodo Python ' +
    'esposto dal modello (action_confirm, message_post, action_invoice_create, ecc.). ' +
    "Tutte le chiamate transitano sempre attraverso l'ORM Odoo: rispettano i record rules per-utente, le ACL, " +
    'i validatori server-side (api.constrains), le compute fields, gli automated actions e popolano il chatter + ' +
    "audit log Odoo come se l'azione fosse fatta da un utente reale dell'interfaccia web. NESSUNA esecuzione " +
    'SQL diretta sul Postgres backend: zero rischio di bypass di sicurezza o corruzione di dati derivati. ' +
    "Cache automatica dell'uid di sessione per ridurre i due roundtrip authenticate iniziali al primo call (TTL " +
    '15 minuti, invalidata su 401). Supporta API Key Odoo 14+ raccomandata in produzione (bypass 2FA, revocabile, ' +
    'non scade). Use case: sincronizzazione contatti tra form web e res.partner Odoo, creazione automatica di ' +
    'lead CRM da email PEC dello studio commercialista, aggiornamento stato fattura account.move via call_method ' +
    'action_post, lookup anagrafica fiscale partita IVA per matching cliente nella pipeline di onboarding, ' +
    'batch reporting estraendo report Qweb in PDF per controllo di gestione mensile.',

  configFields: [
    // ────────── Authentication (sempre visibile) ──────────
    {
      key: 'baseUrl',
      label: 'URL Odoo (https://)',
      type: 'text',
      required: true,
      placeholder: 'https://mio-odoo.example.it',
      help:
        'URL base della tua istanza Odoo. https:// obbligatorio in produzione. ' +
        'Senza /web, senza /xmlrpc — il nodo aggiunge automaticamente i path.',
    },
    {
      key: 'database',
      label: 'Nome database',
      type: 'text',
      required: true,
      placeholder: 'odoo_studiocommercialista',
      help:
        'Database name (database_show=False richiede di inserirlo a mano). ' +
        'Se vedi solo un db, e` quello che ti appare nella URL dopo /web?db=...',
    },
    {
      key: 'login',
      label: 'Utente Odoo',
      type: 'text',
      required: true,
      placeholder: 'segreteria@studiocommercialista.it',
      help:
        'Email o username Odoo. Per workflow automatici crea un utente dedicato ' +
        '(es. "Workflow Bot") con permessi limitati al minimo necessario.',
    },
    {
      key: 'password',
      label: 'Password o API Key',
      type: 'secret',
      required: true,
      help:
        'PER PRODUZIONE: usa un API Key (Odoo 14+, menu utente → Account Security → ' +
        'New API Key). Bypassa il 2FA, non scade, revocabile. ' +
        'Password normale funziona ma non e` raccomandata.',
    },

    // ────────── Operation selector ──────────
    {
      key: 'operation',
      label: 'Operazione',
      type: 'select',
      required: true,
      options: ['search_read', 'create', 'write', 'unlink', 'call_method'],
      defaultValue: 'search_read',
      help:
        'search_read = leggi record (SELECT). ' +
        'create = crea nuovo record. ' +
        'write = aggiorna record esistenti. ' +
        'unlink = cancella record (rispetta record rules). ' +
        "call_method = chiama metodo arbitrario (es. action_confirm sull'ordine).",
    },
    {
      key: 'model',
      label: 'Modello Odoo',
      type: 'text',
      required: true,
      placeholder: 'res.partner    oppure    crm.lead    oppure    account.move',
      help:
        'Nome tecnico del modello Odoo (lowercase con punti). ' +
        'Esempi: res.partner (anagrafica), crm.lead (lead CRM), account.move (fattura), ' +
        'mail.message (messaggi/email), product.template (prodotti).',
    },

    // ────────── search_read ──────────
    {
      key: 'domainJson',
      label: 'Domain (filtri)',
      type: 'code',
      language: 'json',
      required: false,
      placeholder: '[["email", "=", "{{input.from}}"], ["customer_rank", ">", 0]]',
      help:
        'Array di triple [campo, operatore, valore] in formato Odoo domain. ' +
        'Operatori: =, !=, >, <, >=, <=, like, ilike, in, not in, child_of. ' +
        'AND implicito; per OR usa "|" prima di due triple. ' +
        "Vuoto = tutti i record (rispetta i record rules dell'utente).",
      showIf: { field: 'operation', equals: 'search_read' },
    },
    {
      key: 'fieldsJson',
      label: 'Campi da leggere',
      type: 'code',
      language: 'json',
      required: false,
      placeholder: '["id", "name", "email", "phone", "company_id"]',
      help:
        'Array di nomi campo. ' +
        'Vuoto = tutti i campi (lento, default). ' +
        'Usa solo i campi che ti servono per ridurre payload + latenza.',
      showIf: { field: 'operation', equals: 'search_read' },
    },
    {
      key: 'limit',
      label: 'Limit (max record)',
      type: 'number',
      required: false,
      defaultValue: '100',
      help: 'Range 1-10000. Default 100. Riducilo per snellire i payload.',
      showIf: { field: 'operation', equals: 'search_read' },
    },
    {
      key: 'offset',
      label: 'Offset (paginazione)',
      type: 'number',
      required: false,
      defaultValue: '0',
      help: 'Per paginazione: salta i primi N record. Range 0-1000000.',
      showIf: { field: 'operation', equals: 'search_read' },
    },
    {
      key: 'order',
      label: 'Ordinamento (ORDER BY)',
      type: 'text',
      required: false,
      placeholder: 'create_date desc, id desc',
      help: 'Espressione SQL-like Odoo. Vuoto = ordine default del modello.',
      showIf: { field: 'operation', equals: 'search_read' },
    },

    // ────────── create / write ──────────
    {
      key: 'valuesJson',
      label: 'Valori (JSON)',
      type: 'code',
      language: 'json',
      required: false,
      placeholder:
        '{"name": "Mario Rossi", "email": "mario@example.it", "phone": "+39 333 1234567"}',
      help:
        'Oggetto JSON con i campi da scrivere. ' +
        "Per relazioni many2one usa l'ID numerico (es. company_id: 1). " +
        'Per many2many usa il "command Odoo" [(6, 0, [id1, id2])]. ' +
        'Per binary upload (allegati) usa base64.',
      showIf: { field: 'operation', in: ['create', 'write'] },
    },

    // ────────── write / unlink ──────────
    {
      key: 'recordIdsJson',
      label: 'IDs dei record',
      type: 'code',
      language: 'json',
      required: false,
      placeholder: '[42, 7]    oppure    {{$node.search.json.body}}',
      help:
        'Array di ID numerici dei record da modificare o cancellare. ' +
        "Tipicamente l'output di un nodo search_read precedente.",
      showIf: { field: 'operation', in: ['write', 'unlink'] },
    },

    // ────────── call_method ──────────
    {
      key: 'methodName',
      label: 'Nome metodo',
      type: 'text',
      required: false,
      placeholder: 'action_confirm    oppure    message_post',
      help:
        'Nome del metodo da chiamare sul modello. ' +
        'Esempi comuni: action_confirm (conferma SO/PO), action_invoice_create, ' +
        'message_post (invio messaggio chatter), action_send_mail.',
      showIf: { field: 'operation', equals: 'call_method' },
    },
    {
      key: 'positionalJson',
      label: 'Argomenti posizionali (JSON array)',
      type: 'code',
      language: 'json',
      required: false,
      placeholder: '[[42], {"body": "<p>Ciao</p>"}]',
      help:
        "Array JSON dei posizionali. Primo elemento spesso e` l'array di IDs target. " +
        'Vuoto = nessun arg posizionale.',
      showIf: { field: 'operation', equals: 'call_method' },
    },
    {
      key: 'kwargsJson',
      label: 'Argomenti keyword (JSON object)',
      type: 'code',
      language: 'json',
      required: false,
      placeholder: '{"subject": "Promemoria", "subtype_id": 1}',
      help: 'Oggetto JSON dei kwargs. Vuoto = {}.',
      showIf: { field: 'operation', equals: 'call_method' },
    },

    // ────────── HTTP knobs ──────────
    {
      key: 'timeoutMs',
      label: 'Timeout HTTP (ms)',
      type: 'number',
      required: false,
      defaultValue: '60000',
      help: 'Default 60s. Aumenta per query report pesanti. Range 1000-300000.',
    },
    {
      key: 'followRedirects',
      label: 'Segui redirect',
      type: 'boolean',
      required: false,
      defaultValue: 'true',
    },
    {
      key: 'includePipelineLog',
      label: "Includi log nell'output",
      type: 'boolean',
      required: false,
      defaultValue: 'true',
    },
  ],

  vendor: 'flowforge',
  version: '1.0.0',
  cost: {
    typicalLatencyMs: 250,
  },
};
