/**
 * `community_notion` — Notion API (pages + databases).
 * Credentials: { integrationToken: "secret_..." } via integration vault.
 * @module actions/community-notion
 */

import type { NodeModule } from '../types.js';

export const communityNotionNode: NodeModule = {
  def: {
    id: 'community_notion',
    type: 'action',
    label: 'Notion: Pages / Databases',
    icon: 'book',
    color: '#000000',
    description:
      'Connettore enterprise per Notion (la piattaforma di knowledge management cresciuta a 30M+ utenti, oggi ' +
      'usata massivamente da startup e team distribuiti per docs, OKR tracking, project planning, wikipedia ' +
      'interne, CRM lightweight, intranet sostitutiva di Confluence) via API REST ufficiale Notion v1. ' +
      'Quattro operazioni atomiche coprono il 95% degli use case workflow: createPage per inserire una nuova ' +
      'pagina sotto un parent (database con properties schema oppure pagina libera con block content), ' +
      'queryDatabase per filtri rich con cursors paginati e ordering compound, updatePage per modificare ' +
      'properties di un record già esistente in database (case classico per kanban move tra status), getPage ' +
      'per fetch puntuale con blocks (paragraph, heading_1/2/3, bulleted_list_item, numbered_list_item, ' +
      'callout, code, image, embed, divider, table, child_database). ' +
      'Auth via Internal Integration Token (formato secret_xxxxxxxx) creato dal workspace admin nella sezione ' +
      'Integrations del Settings — il token va aggiunto al vault integration FlowForge con label leggibile (es. ' +
      '"notion-marketing-team-token") e referenziato via integrationLabel nel nodo. Critical: dopo aver creato ' +
      'il token, ricordare di "Share" esplicitamente la pagina/database con l\'integration dall\'UI Notion ' +
      '(menu ⋯ → Add connections), altrimenti l\'API ritornerà 404 "object_not_found" anche con token valido. ' +
      'Pagination automatica via has_more + next_cursor (il nodo accumula tutti i record fino al limite di ' +
      '100 pagine totali di sicurezza, configurable). Rate-limit Notion: 3 req/s media per integration, ' +
      'enforcing 429 con Retry-After header — gestito con backoff esponenziale automatico nel nodo. ' +
      'Schema validation: i campi properties devono matchare lo schema del database target — il nodo verifica ' +
      "la coerenza Type prima dell'invio (rich_text accetta array di rich_text, title accetta plain_text + " +
      'rich_text, number accetta numeric, status/select accetta name esistenti, multi_select array). ' +
      'API docs ufficiali: developers.notion.com — versione API correntemente targata 2022-06-28 (la più stable). ' +
      'Use case: knowledge base auto-popolata dai workflow di customer support (ogni ticket Zendesk risolto → ' +
      'pagina sotto "/Customer Lessons" con summary AI e tags); log meeting Calendly → row nuovo nel database ' +
      "Meetings con date, partecipanti, link Zoom, action_items estratti dall'AI summarizer; dashboard sync " +
      'da Postgres a database Notion che il management consulta giornalmente (replace Looker per metriche ' +
      'leggere); data collection da form Typeform → row in CRM Notion con tag auto da agent_email_triage_b2b ' +
      'per qualifica lead; documentazione PR auto-generata da GitHub merge events con link diff e ' +
      'breaking_changes notice.',
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
        defaultValue: 'createPage',
        options: ['createPage', 'queryDatabase', 'updatePage', 'getPage'],
      },
      {
        key: 'parentId',
        label: 'Parent ID (database o page UUID)',
        type: 'expression',
        required: false,
        placeholder: '32-char-uuid-with-dashes',
        help: 'UUID del parent (database per createPage in db, page per createPage child). Required per createPage.',
      },
      {
        key: 'parentType',
        label: 'Tipo parent',
        type: 'select',
        required: false,
        defaultValue: 'database_id',
        options: ['database_id', 'page_id'],
        help: 'database_id (default) per pages in db, page_id per child pages.',
      },
      {
        key: 'pageId',
        label: 'Page ID (per updatePage/getPage)',
        type: 'expression',
        required: false,
        help: 'UUID page Notion. Required per updatePage/getPage.',
      },
      {
        key: 'databaseId',
        label: 'Database ID (per queryDatabase)',
        type: 'expression',
        required: false,
        help: 'UUID database. Required per queryDatabase.',
      },
      {
        key: 'propertiesJson',
        label: 'Properties (JSON Notion schema)',
        type: 'code',
        language: 'json',
        required: false,
        placeholder: '{ "Name": { "title": [{ "text": { "content": "Hello" }}] } }',
        help:
          'Properties shape Notion (vedi developers.notion.com/reference/property-value-object). ' +
          'Required per createPage/updatePage.',
      },
      {
        key: 'filterJson',
        label: 'Filter (per queryDatabase)',
        type: 'code',
        language: 'json',
        required: false,
        placeholder: '{ "property": "Status", "select": { "equals": "Done" } }',
        help: 'Filter object per queryDatabase. Vedi developers.notion.com/reference/post-database-query-filter.',
      },
      {
        key: 'pageSize',
        label: 'Page size (per queryDatabase)',
        type: 'number',
        required: false,
        defaultValue: '50',
        help: 'Max 100 (hard cap Notion). Default 50.',
      },
    ],
    outputs: ['ok', 'data', 'pageId', 'results', 'count', 'hasMore', 'nextCursor'],
    vendor: 'flowforge',
    version: '1.0.0',
    cost: { typicalLatencyMs: 700 },
  },
};
