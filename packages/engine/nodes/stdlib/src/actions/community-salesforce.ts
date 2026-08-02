/**
 * `community_salesforce` — Salesforce SOQL + REST.
 * Credentials: { instanceUrl, accessToken, refreshToken, clientId, clientSecret } (OAuth2).
 * @module actions/community-salesforce
 */

import type { NodeModule } from '../types.js';

export const communitySalesforceNode: NodeModule = {
  def: {
    id: 'community_salesforce',
    type: 'action',
    label: 'Salesforce: SOQL + REST',
    icon: 'cloud',
    color: '#00A1E0',
    description:
      'Connettore enterprise per Salesforce — la piattaforma CRM mondiale leader (150k+ customer paganti, ' +
      'dominante nel B2B enterprise US/EMEA con il 23% di market share globale del CRM, base installata di ' +
      'sales+service+marketing+industrie cloud) via REST API ufficiale. Sei operazioni atomiche coprono il ' +
      'ciclo completo CRUD + SOQL: query (esegue una stringa SOQL Salesforce Object Query Language — il ' +
      'dialetto SQL-like proprietario di Salesforce con relationship traversal nested "SELECT Name, Owner.Email, ' +
      "(SELECT Subject FROM Tasks) FROM Account WHERE BillingCountry = 'Italy'\"), create (insert nuovo record " +
      'con field validation server-side), update (modify esistente by Id), upsert (cruciale per integration ' +
      'idempotente — match per external_id field designato, crea se assente, aggiorna se presente in una sola ' +
      'chiamata atomica = pattern di sync da sistema esterno verso Salesforce), delete (logical/physical), ' +
      'get (retrieve puntuale by Id con field selection). ' +
      'Auth via OAuth2 con refresh-token flow — il pattern enterprise standard per integration server-side: ' +
      "l'admin Salesforce crea una Connected App nella sezione Setup → App Manager con scope api+refresh_token, " +
      "l'utente FlowForge completa il consent flow una sola volta nell'editor Settings → Integrations e il " +
      'sistema salva il refresh_token nel vault del tenant. Il nodo ottiene access_token short-lived (15 min ' +
      'TTL Salesforce default) da cache local + refresh automatico sul 401/INVALID_SESSION_ID con 1 retry ' +
      "trasparente — l'utente non vede mai expire né deve fare manual re-auth. " +
      'Multi-environment support: Salesforce ha sandbox (test environments isolati) e production (real ' +
      "environment); l'integration vault FlowForge supporta integrationLabel separati per pointing a " +
      'instanceUrl diversi (sandbox: cs99.salesforce.com / production: ap25.salesforce.com / EU regional ' +
      'cluster: eu46.salesforce.com), prevenendo il classico incident "test contro production by mistake". ' +
      'Rate limit Salesforce: API limit aggregato per giorno è quota-based (15k req/giorno Developer Edition, ' +
      '5M req/giorno Enterprise Edition) — il nodo monitora consumption via Sforce-Limit-Info response header ' +
      'e logga warning quando > 80% usage per consentire forecast prima del hard cap. ' +
      'API docs ufficiali: developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest (REST API v62.0+ ' +
      "Summer '24 release). Bulk API v2 non gestita da questo nodo (richiede async polling pattern — usabile " +
      'via action_http custom). ' +
      'Use case: lead from web form Typeform → upsert Lead in Salesforce by email (External_Id__c) con ' +
      'LeadSource=Web e Status=Open-Not Contacted per il sales team italiano; opportunity update post-pagamento ' +
      "Stripe webhook → update Opportunity Stage='Closed Won' Amount={{order.total}} CloseDate={{today}}; " +
      'contact sync bidirezionale da HubSpot CRM verso Salesforce per multi-CRM strategy (i marketing usano ' +
      'HubSpot, il sales team usa Salesforce — sync notturno via query → upsert); reporting SOQL custom per ' +
      'export forecast pipeline mensile in PDF tramite action_pdf_generate; integration con sistema gestionale ' +
      'italiano legacy che esporta ordini in CSV → bulk upsert come Custom_Order__c.',
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
        defaultValue: 'query',
        options: ['query', 'create', 'update', 'upsert', 'delete', 'get'],
      },
      {
        key: 'sobject',
        label: 'SObject name (es. Account, Lead, Opportunity)',
        type: 'expression',
        required: false,
        placeholder: 'Lead',
        help: 'Required per create/update/upsert/delete/get. Es. Account, Lead, Contact, Opportunity, custom__c.',
      },
      {
        key: 'soql',
        label: 'SOQL query (per operation=query)',
        type: 'code',
        language: 'sql',
        required: false,
        placeholder: 'SELECT Id, Name, Email FROM Lead WHERE CreatedDate = TODAY LIMIT 100',
        help: 'Required per operation=query. SOQL standard Salesforce.',
      },
      {
        key: 'recordId',
        label: 'Record ID (per update/get/delete)',
        type: 'expression',
        required: false,
        help: 'Salesforce ID 15/18-char. Required per update/get/delete.',
      },
      {
        key: 'externalIdField',
        label: 'External ID field (per upsert)',
        type: 'text',
        required: false,
        placeholder: 'External_ID__c',
        help: 'Required per upsert. Campo custom Salesforce marcato come External ID.',
      },
      {
        key: 'externalIdValue',
        label: 'External ID value (per upsert)',
        type: 'expression',
        required: false,
        help: 'Required per upsert. Valore univoco esterno (es. UUID workflow, ID CRM esterno).',
      },
      {
        key: 'recordJson',
        label: 'Record fields (JSON, per create/update/upsert)',
        type: 'code',
        language: 'json',
        required: false,
        placeholder: '{ "FirstName": "Mario", "LastName": "Rossi", "Company": "Acme" }',
        help: 'Required per create/update/upsert. Object con campi Salesforce (case-sensitive).',
      },
    ],
    outputs: ['ok', 'data', 'records', 'count', 'totalSize', 'recordId', 'created'],
    vendor: 'flowforge',
    version: '1.0.0',
    cost: { typicalLatencyMs: 800 },
  },
};
