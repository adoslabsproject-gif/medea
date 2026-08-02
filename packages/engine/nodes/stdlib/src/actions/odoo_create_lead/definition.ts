/**
 * `action_odoo_create_lead` — NodeDef.
 *
 * @module actions/odoo_create_lead/definition
 */

import type { NodeDef } from '@medea/engine-core-schema';

export const odooCreateLeadNodeDef: NodeDef = {
  id: 'action_odoo_create_lead',
  type: 'action',
  label: 'Odoo: Crea Lead CRM',
  icon: 'plus-circle',
  color: '#22c55e',
  description:
    'Crea una opportunità nel pipeline CRM di Odoo (modello crm.lead) abbattendo la complessità tipica della ' +
    'sintassi XML-RPC many2many sui tag. Il modello crm.lead di Odoo richiede per i campi relazionali (tag_ids, ' +
    'user_id, team_id, partner_id) la sintassi "command Odoo" — array di tuple [(6, 0, [id1, id2])] dove 6 ' +
    'significa "replace all relations" e 0 è un placeholder posizionale — sintassi notoriamente ostica anche ' +
    'per developer esperti e completamente fuori portata per un commercialista che vuole solo "aggiungere un lead ' +
    'da una PEC ricevuta". Questo nodo nasconde tutto: accetta i tag come array di stringhe leggibili ' +
    '(["interessato_fattura_elettronica", "studio_torino"]) e li risolve idempotentemente lato Odoo via crm.tag ' +
    'name_create — i tag esistenti vengono riutilizzati, quelli mai visti prima vengono creati ON THE FLY senza ' +
    'fallire il workflow per "tag inesistente". user_id (commerciale assegnato) e team_id (team di vendita) ' +
    'accettano sia ID numerico sia email/nome — la risoluzione avviene server-side con search per email ' +
    'in res.users. Bug noto fixato 2026-06-04: prima versione del name_create non era idempotente sotto race ' +
    'condition (due workflow concurrent con stesso tag → 2 record duplicati) — ora con SAVEPOINT + ON CONFLICT. ' +
    'Output: { leadId, success, lead: { name, email, phone, partnerId, tagIds, userId, teamId, expectedRevenue, ' +
    'probability, description, stageId, createDate } }. ' +
    'Campi coperti dal wrapper: name (titolo opportunità), email/phone/mobile, description (rich text Qweb), ' +
    'tagIdsByName (array stringhe), userIdByEmail, teamIdByName, expectedRevenue (decimal € EUR), probability ' +
    '(0-100), source (sorgente lead per analytics CRM: "PEC", "WhatsApp", "Web form"). ' +
    'Use case reali: input da action_pec_classify branch received_message → crea lead "Richiesta info da X" con ' +
    'tag "pec_inbound" e source="PEC" assegnato al commercialista in turno (round-robin via team_id); webhook ' +
    'from Calendly meeting booking → crea lead con expectedRevenue stimato da pacchetto selezionato; reazione a ' +
    'agent_email_triage_b2b_sales label "qualified_prospect" → lead in stage "Qualifying" con probability 30; ' +
    'integration LinkedIn Sales Navigator export → bulk create lead con tag "linkedin_outbound" e team_id "BDR".',

  configFields: [
    // Auth
    { key: 'baseUrl', label: 'URL Odoo', type: 'text', required: true,
      placeholder: 'https://miostudio.odoo.com' },
    { key: 'database', label: 'Database', type: 'text', required: true },
    { key: 'login', label: 'Login', type: 'text', required: true },
    { key: 'password', label: 'Password / API Key', type: 'secret', required: true },

    // Lead core
    { key: 'name', label: 'Titolo opportunità', type: 'text', required: true,
      placeholder: 'Mario Rossi - 730 2025',
      help: 'Visualizzato come opportunità nella pipeline CRM. Required.' },
    { key: 'emailFrom', label: 'Email cliente', type: 'text', required: false,
      placeholder: 'mario@cliente.it' },
    { key: 'phone', label: 'Telefono cliente', type: 'text', required: false },
    { key: 'partnerName', label: 'Nome cliente', type: 'text', required: false,
      placeholder: 'Mario Rossi',
      help: 'Solo quando il partner non è già linkato via partnerId.' },
    { key: 'description', label: 'Descrizione (testo / HTML)', type: 'textarea',
      required: false,
      help: 'Visualizzata sull\'opportunità. Accetta plain text o HTML basic.' },

    // Linking
    { key: 'partnerId', label: 'partner_id (linka esistente)', type: 'number',
      required: false,
      help: 'Salta name/phone auto-link → usa direttamente il partner indicato.' },

    // Tags
    { key: 'tagNames', label: 'Tag (comma-separated)', type: 'text', required: false,
      placeholder: 'urgente,fiscale,2025',
      help: 'Risolti via crm.tag name_create (idempotente: tag esistenti ' +
        'riusati, nuovi creati). Comando many2many (6,0,[id,…]).' },

    // Assignment
    { key: 'userId', label: 'Assegna a user_id', type: 'number', required: false,
      help: 'Sales rep responsabile.' },
    { key: 'teamId', label: 'Sales team_id', type: 'number', required: false },

    // Commercial
    { key: 'expectedRevenue', label: 'Expected revenue', type: 'number',
      required: false, help: 'Decimale nell\'unità monetaria company.' },
    { key: 'probability', label: 'Probability %', type: 'number', required: false,
      help: 'Range 0-100. Vuoto = default Odoo (calcolato dallo stage).' },

    // Override
    { key: 'model', label: 'Model (override)', type: 'text', required: false,
      defaultValue: 'crm.lead',
      help: 'Cambiare solo se l\'installazione Odoo ha rinominato crm.lead.' },

    // Knobs
    { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number', required: false,
      defaultValue: '60000' },
    { key: 'followRedirects', label: 'Segui redirect', type: 'boolean',
      required: false, defaultValue: 'true' },
  ],

  vendor: 'flowforge',
  version: '1.0.0',
  cost: { typicalLatencyMs: 350 },
};
