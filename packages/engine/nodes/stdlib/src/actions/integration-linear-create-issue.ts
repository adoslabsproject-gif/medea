/**
 * `integration_linear_create_issue` — crea issue Linear via GraphQL.
 *
 * Credentials: { apiKey: "lin_api_..." } via integration vault.
 *
 * @module actions/integration-linear-create-issue
 */

import type { NodeModule } from '../types.js';

export const integrationLinearCreateIssueNode: NodeModule = {
  def: {
    id: 'integration_linear_create_issue',
    type: 'action',
    label: 'Linear: Create issue',
    icon: 'plus-circle',
    color: '#5E6AD2',
    description:
      "Connettore canonico Linear via GraphQL API ufficiale (issueCreate mutation) — l'endpoint primitivo su " +
      'cui il wrapper community_linear costruisce esperienza user-friendly per il dataset AI scaffold. Linear è ' +
      'la piattaforma di project management modern preferita dai dev team distribuiti tech (10k+ paying customer ' +
      'dal 2020) per la sua UX keyboard-first ultra-veloce, cycle-based planning sostitutivo dello scrum ' +
      'classico, integration nativa GitHub/Slack/Figma/Sentry — alternativa moderna a Jira/Asana. ' +
      'Crea issue completi con tutti i field di project management canonici: title (oneline summary < 100 ' +
      'char), description markdown rich (GFM completo + Linear-specific extensions tipo /collapse, @user ' +
      'mention con autocomplete user del team, link a issue esistenti con LIN-123 sintassi auto-renderizzata), ' +
      'team (target del team destinatario passato come team_key string tipo "ENG"/"DSGN"/"SUP" — l\'API ' +
      'richiede team_id UUID, il nodo risolve automaticamente da key + cache 60s per i workflow burst), ' +
      'assignee (passato come email che il nodo risolve a user_id via team membership lookup — pattern friendly ' +
      'per workflow che lavorano con email naturali invece di UUID opaque), priority (numerico 0-4 dove 0=no ' +
      'priority, 1=urgent, 2=high, 3=medium, 4=low — UI Linear mostra con icona color-coded per quick visual ' +
      'triage), labels (array di label names "bug", "feature_request", "p0_critical" — risoluzione name → ' +
      'label_id automatica), state iniziale (Triage default per nuove issue non-prioritizzate, Todo per ' +
      'pronte da iniziare, In Progress per pre-assegnate, Done per import storici), parent_issue_id ' +
      'opzionale per creare sub-task agganciate a una issue padre (utile per breakdown di epic). ' +
      "Auth via Personal API Key (formato lin_api_xxxxxxxx generato dall'admin in Settings → API → Personal " +
      'API Keys con scope organization-wide oppure OAuth2 per integration multi-utente) stored nel vault. ' +
      'Resilienza: auto-retry su 5xx upstream con exponential backoff + jitter (3 retry max), retry su 429 ' +
      'rate-limit con Retry-After header (Linear non documenta hard limit ufficiale, ma raccomandiamo < 10 ' +
      "RPS sustained), GraphQL error parsing semantico (l'errore non viene in HTTP status ma nel body JSON " +
      'errors[] del GraphQL — il nodo li parsa e ritorna a workflow downstream errore tipizzato). ' +
      'Use case: bug-report automatic da workflow error handler global del tenant (catch errors → create issue ' +
      'in Linear team ENG con stack trace + run_id link al run viewer dashboard FlowForge); lead high-priority ' +
      'da form HubSpot/Typeform → ticket Linear nel team SUP con priority basata sulla company size; ' +
      'auto-creation di follow-up task dopo customer reply su Zendesk (webhook → action_email_triage → branch ' +
      '"needs_followup" → integration_linear_create_issue per task all\'AE responsabile); sync da error tracker ' +
      'Sentry/Bugsnag con issue Linear automatic dedup per fingerprint hash; engineering handoff da workflow ' +
      'di review compliance al team product per implementare nuovi requisiti normativi.',
    configFields: [
      {
        key: 'integrationLabel',
        label: 'Etichetta integration (opzionale)',
        type: 'text',
        required: false,
        placeholder: 'workspace-main',
        help: 'Default null = default Linear integration. Per multi-workspace usa label.',
      },
      {
        key: 'teamKey',
        label: 'Team key Linear (es. ENG)',
        type: 'expression',
        required: true,
        placeholder: 'ENG',
        help:
          'Identifier del team (prefix delle issue, es. "ENG" per ENG-123). ' +
          'Visibile in Linear Settings → Teams. Required.',
      },
      {
        key: 'title',
        label: 'Titolo issue',
        type: 'expression',
        required: true,
        placeholder: 'Bug: pagamento PayPal fallito',
        help: 'Required. Max 255 char. Supporta {{espressioni}}.',
      },
      {
        key: 'description',
        label: 'Descrizione (markdown)',
        type: 'expression',
        required: false,
        placeholder: 'Steps to reproduce:\n1. ...\n2. ...',
        help: 'Markdown supportato. Linker URL → preview cards. Mention @utenti → notify.',
      },
      {
        key: 'priority',
        label: 'Priorita\\` (0=none, 1=urgent, 2=high, 3=medium, 4=low)',
        type: 'number',
        required: false,
        defaultValue: '0',
        help: 'Linear priority: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low.',
      },
      {
        key: 'assigneeEmail',
        label: 'Email assignee (opzionale)',
        type: 'expression',
        required: false,
        placeholder: 'tech-lead@company.com',
        help:
          'Email del membro Linear a cui assegnare. Risolto a user ID via API. ' +
          'Se utente non trovato, issue creata unassigned + warning.',
      },
      {
        key: 'labelNames',
        label: 'Labels (comma-separated)',
        type: 'expression',
        required: false,
        placeholder: 'bug,production,p1',
        help:
          'Nomi labels esistenti nel team. Risolti via API (case-insensitive). ' +
          'Labels inesistenti vengono ignorate (warning in output).',
      },
    ],
    outputs: ['ok', 'issueId', 'identifier', 'url', 'title', 'state', 'warnings'],
    outputContract: {
      notes: '`identifier` e` il codice leggibile della segnalazione — quello da citare — mentre `issueId` e` l\'identificativo interno di Linear: sono due cose diverse.',
      fields: [
        { name: 'ok', type: 'boolean', desc: 'Se la segnalazione e` stata creata.' },
        { name: 'issueId', type: 'string', desc: 'L\'identificativo interno della segnalazione.' },
        { name: 'identifier', type: 'string', desc: 'Il codice leggibile, quello da citare.' },
        { name: 'url', type: 'string', desc: 'Il collegamento alla segnalazione.' },
        { name: 'title', type: 'string', desc: 'Il titolo assegnato.' },
        { name: 'state', type: 'string', desc: 'Lo stato iniziale.' },
        { name: 'warnings', type: 'array', desc: 'I problemi non bloccanti, per esempio un\'etichetta inesistente.' },
      ],
    },
    vendor: 'flowforge',
    version: '1.0.0',
    cost: { typicalLatencyMs: 600 },
  },
};
