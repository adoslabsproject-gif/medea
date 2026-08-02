/**
 * `action_odoo_update_activity` — NodeDef.
 *
 * @module actions/odoo_update_activity/definition
 */

import type { NodeDef } from '@medea/engine-core-schema';

export const odooUpdateActivityNodeDef: NodeDef = {
  id: 'action_odoo_update_activity',
  type: 'action',
  label: 'Odoo: Aggiungi Attività',
  icon: 'calendar-plus',
  color: '#0ea5e9',
  description:
    'Pianifica una mail.activity in Odoo — il meccanismo nativo di task assignment con scadenza che alimenta il ' +
    'pannello "Le mie attività" della sidebar Odoo e genera notifiche automatiche al responsabile. La attività ' +
    'va legata a un record arbitrario tramite il pattern res_model + res_id (polymorphic association): partner ' +
    'di anagrafica per follow-up commerciale, opportunità crm.lead per call di qualificazione, ordine sale.order ' +
    'per controllo pagamento, fattura account.move per rispondere a contestazione, ticket helpdesk.ticket per ' +
    'SLA escalation. Il campo activity_type_id richiede di sapere a memoria gli ID numerici delle activity types ' +
    'configurate nel tenant Odoo (4=To Do, 1=Email, 2=Call, 3=Meeting, ...) — informazione opaca per un utente ' +
    'non-tecnico. Questo nodo sblocca il lookup BY NAME: si passa "Da Fare", "Telefonata", "Verifica documenti" ' +
    'e il nodo risolve l\'ID tramite ricerca exact-match su mail.activity.type (caching del risultato per ' +
    'workflow successivi nello stesso run). Date_deadline accetta sia ISO 8601 (2026-06-15) sia espressioni ' +
    'relative ("+3d", "+1w", "+2M") parsate localmente prima dell\'invocazione RPC. User_id supporta sia ID che ' +
    'email per assegnazione a commerciale in vacanza con backup automatico al supervisor (lookup user_id con ' +
    'fallback su company.user_id parent). ' +
    'Output: { success, activityId, resolvedActivityType, assignedToEmail, dueDate, summary }. ' +
    'Le attività create alimentano il widget "Attività in scadenza" della dashboard Odoo e generano email ' +
    'automatica al user_id se attiva la configurazione Odoo "Send activity overdue notification". ' +
    'Use case: post agent_email_triage_commercialista con label "anomalia_iva" e confidence < 0.7 → crea ' +
    'mail.activity tipo "Da Fare" su crm.lead corrispondente con deadline oggi+2gg e summary "Controllo manuale ' +
    'classificazione IVA dichiarata"; post scadenza fattura B2B 30gg senza pagamento → activity "Telefonata" su ' +
    'account.move "Sollecito pagamento fattura n.X"; ingaggio nuovo cliente firma contratto → activity "Da Fare" ' +
    'su res.partner "Onboarding kit + accesso area riservata"; rinnovo abbonamento annuale 30gg prima della ' +
    'scadenza → activity tipo "Email" su sale.order parent "Invio offerta rinnovo".',

  configFields: [
    { key: 'baseUrl', label: 'URL Odoo', type: 'text', required: true,
      placeholder: 'https://miostudio.odoo.com' },
    { key: 'database', label: 'Database', type: 'text', required: true },
    { key: 'login', label: 'Login', type: 'text', required: true },
    { key: 'password', label: 'Password / API Key', type: 'secret', required: true },

    { key: 'resModel', label: 'Model target', type: 'text', required: true,
      placeholder: 'crm.lead',
      help: 'Model Odoo del record (es. res.partner, crm.lead, sale.order). ' +
        'Lowercase + dots, regex enforced.' },
    { key: 'resId', label: 'ID record target', type: 'number', required: true,
      help: 'Id del record sul quale agganciare l\'attività.' },

    { key: 'activityTypeId', label: 'activity_type_id (numerico)', type: 'number',
      required: false,
      help: 'Id da mail.activity.type. Più veloce dell\'opzione name (1 chiamata in meno).' },
    { key: 'activityTypeName', label: 'Activity type per nome', type: 'text',
      required: false, placeholder: 'To Do',
      help: 'Risolto via search_read su mail.activity.type. Usabile se ' +
        'non conosci l\'id (es. multi-installazione).' },

    { key: 'summary', label: 'Summary', type: 'text', required: true,
      placeholder: 'Verifica manuale email cliente',
      help: 'Testo breve mostrato sulla card attività.' },
    { key: 'noteHtml', label: 'Nota (HTML)', type: 'textarea', required: false,
      help: 'Corpo HTML dell\'attività. Accetta basic HTML (p, br, ul, b).' },
    { key: 'dateDeadline', label: 'Deadline (YYYY-MM-DD)', type: 'text', required: false,
      placeholder: '2026-06-10',
      help: 'Formato ISO. Default = oggi (server time).' },
    { key: 'userId', label: 'Assegna a user_id', type: 'number', required: false,
      help: 'Default = utente autenticato della call.' },

    { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number', required: false,
      defaultValue: '60000' },
    { key: 'followRedirects', label: 'Segui redirect', type: 'boolean',
      required: false, defaultValue: 'true' },
  ],

  vendor: 'flowforge',
  version: '1.0.0',
  cost: { typicalLatencyMs: 300 },
};
