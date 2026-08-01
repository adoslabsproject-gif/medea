/**
 * `community_hubspot` — HubSpot CRM REST API.
 * Credentials: { accessToken: "pat-..." } via integration vault.
 * @module actions/community-hubspot
 */

import type { NodeModule } from '../types.js';

export const communityHubspotNode: NodeModule = {
  def: {
    id: 'community_hubspot',
    type: 'action',
    label: 'HubSpot: CRM (contacts/deals/companies)',
    icon: 'briefcase',
    color: '#FF7A59',
    description:
      'Connettore enterprise per HubSpot CRM (la piattaforma marketing+sales+service di Cambridge MA con 200k+ ' +
      'customer paganti, dominante nel B2B mid-market US/EMEA, gestisce il funnel completo dal MQL al revenue) ' +
      'via API REST v3 ufficiale. Sette operazioni atomiche coprono il flusso CRM standard: createContact (lead ' +
      'capture da form web/Calendly/Typeform), updateContact (post-engagement: update lifecycle_stage MQL→SQL, ' +
      'sync da gestionale esterno), getContact (lookup per email, vid, o by_property), listContacts (paginated ' +
      'export filtrato per segmentation), createDeal (opportunità con pipeline+stage assegnati, expected_close_date, ' +
      'amount in € EUR), updateDeal (movimentazione kanban tra stage: Appointment Scheduled → Qualified to Buy → ' +
      'Closed Won), createCompany (account record per ABM B2B con domain dedup automatico HubSpot). ' +
      'Pattern UPSERT idempotente: il nodo cerca contact by email (con cache 60s per richieste consecutive nel ' +
      'stesso workflow), crea se assente, aggiorna se presente — evita duplicati che intasano il database CRM e ' +
      'confondono i sales rep ("perché Mario compare 3 volte?"). ' +
      'Auth via Private App Access Token (formato pat-eu1-xxxxxxxx oppure pat-na1-xxxxxxxx in base alla regione ' +
      'hosting HubSpot del customer) generato dall\'admin nella sezione Settings → Integrations → Private Apps, ' +
      'con scopes minimum: crm.objects.contacts.read/write, crm.objects.deals.read/write, ' +
      'crm.objects.companies.read/write. Il token è stored nel vault integration FlowForge e referenziato via ' +
      'integrationLabel — multi-account HubSpot supportato (un tenant FlowForge che gestisce 5 portali HubSpot ' +
      'come MSP). ' +
      'Rate limit HubSpot v3: 100 req/10sec per token (10 RPS sustained), 250k req/giorno per token Professional, ' +
      'unlimited per Enterprise — il nodo gestisce 429 con Retry-After exponential backoff + jitter, fallback su ' +
      '5xx gateway error con 3 retry distribuiti. ' +
      'Custom properties: il nodo supporta automaticamente le proprietà custom del tenant HubSpot (fino a 1000 ' +
      'properties/object), validation tipo (string, number, datetime, enumeration, bool, date) prima dell\'invio ' +
      'per evitare 400 BadRequest. ' +
      'API docs: developers.hubspot.com/docs/api/crm — versione API v3 (2023+), v1 legacy deprecato. ' +
      'Use case: lead capture da Typeform → contact con properties {{first_name}}, {{company}}, {{interest_area}} + ' +
      'lifecycle_stage=lead; ordine pagato Stripe webhook → upsert contact + create deal con amount=order.total e ' +
      'stage=Closed Won + associazione contact↔deal; registrazione azienda B2B da SignUp form con dominio ' +
      'aziendale → create company con domain+industry + create contact admin associato; nightly sync da Odoo ' +
      'res.partner verso HubSpot contact per allineare il CRM marketing con la base clienti contabile.',
    configFields: [
      {
        key: 'integrationLabel',
        label: 'Etichetta integration (opzionale)',
        type: 'text',
        required: false,
      },
      {
        key: 'operation',
        label: 'Operazione',
        type: 'select',
        required: true,
        defaultValue: 'createContact',
        options: ['createContact', 'updateContact', 'getContact', 'listContacts', 'createDeal', 'updateDeal', 'createCompany'],
        help: 'Tipo di azione HubSpot da eseguire.',
      },
      {
        key: 'email',
        label: 'Email (per createContact/getContact/updateContact via email lookup)',
        type: 'expression',
        required: false,
        help: 'Required per contact operations (HubSpot dedup per email).',
      },
      {
        key: 'objectId',
        label: 'Object ID (per update/get specifico)',
        type: 'expression',
        required: false,
        help: 'HubSpot internal object ID. Alternativa a email per contact, required per deal/company update.',
      },
      {
        key: 'propertiesJson',
        label: 'Properties (JSON)',
        type: 'code',
        language: 'json',
        required: false,
        placeholder: '{ "firstname": "Mario", "lastname": "Rossi", "company": "Acme" }',
        help: 'Required per create/update. Object con properties HubSpot (firstname, lastname, email, company, ' +
          'phone, jobtitle, deal_stage, amount, ecc — vedi schema HubSpot CRM per properties valide).',
      },
      {
        key: 'limit',
        label: 'Limit (per listContacts)',
        type: 'number',
        required: false,
        defaultValue: '50',
        help: 'Max 100 (hard cap HubSpot). Default 50.',
      },
    ],
    outputs: ['ok', 'data', 'objectId', 'count'],
    vendor: 'flowforge',
    version: '1.0.0',
    cost: { typicalLatencyMs: 600 },
  },
};
