/**
 * HTTP node — NodeDef metadata (config fields per editor UI).
 *
 * Separato dall'executor: la palette del canvas + drawer config carica SOLO
 * questa definizione (no need per il bundle runtime dell'executor).
 *
 * Versione 3.0.0 — refactor su core/middleware + utils/pagination Strategy
 * (cfr. NODE-ARCHITECTURE-2026.md). Behavior preservato 1:1 con v2.0.0.
 */

import type { NodeDef } from '@medea/engine-core-schema';

export const httpNodeDef: NodeDef = {
  id: 'action_http',
  type: 'action',
  label: 'HTTP Request',
  // "chiama una API REST": né 'api' né 'rest' sono nei token di id/label.
  searchAliases: ['api', 'rest', 'chiamata', 'get', 'post'],
  icon: 'globe',
  color: '#3b82f6',
  description:
    'Esegue una richiesta HTTP/HTTPS verso API esterne. Coltellino svizzero per qualunque integrazione vendor non gia\\` coperta da un nodo dedicato (action_send_email, community_*, integration_*).\n\n' +
    'Differenza con i sibling: action_http = REST/RPC generico full-feature (auth multipla, body 5 forme, pagination 4 strategie, retry/breaker). Per scraping HTML usa action_web_fetch_advanced (header browser preset, cookie jar, anti-bot light). Per orchestrazione adaptive con AI extract usa action_scrape_smart (fetch→render→stealth→vision pipeline).\n\n' +
    'Auth supportata: Basic (user:pass base64), Bearer (token in header), API Key (header custom), Custom (header arbitrari), OAuth2 client_credentials (il nodo ottiene da sé l\\`access-token dal token endpoint e lo inietta come Bearer, con cache fino a scadenza). Per il flow OAuth2 authorization_code (a 3 gambe, con redirect utente) usa un nodo integration dedicato. Body: JSON serializzato (con merge di key-value editor), Form url-encoded, Multipart (file upload + campi misti), Raw-text (string custom Content-Type), Raw-binary (base64), Binary (handle da nodo upstream).\n\n' +
    'Pagination automatica con 4 strategie: page-number (?page=N), offset/limit (?offset=N&limit=M), cursor opaco (?cursor=X from response), Link header RFC 5988 (Link: <url>; rel="next"). Walker bounded — maxPages cap protegge da loop infiniti se il vendor implementa Link male.\n\n' +
    'Resilienza enterprise: retry con backoff configurabile (count + delay base + jitter exponential), follow redirects con limit, response format selezionabile (auto-detect via Content-Type / json / text / binary base64), timeout per-request. Wrap automatico con circuit breaker per-host (shared con tutti i nodi che colpiscono lo stesso host — se il vendor e\\` giu\\`, tutti i workflow si fermano insieme prima di accumulare timeout). Telemetry OpenTelemetry: span per request con method/host/status/duration per dashboard SRE.\n\n' +
    'Use case: (1) chiamata API vendor non coperto da community_* (es. ERP italiano custom), (2) integrazione SaaS interno con auth Bearer + retry idempotente, (3) sync periodico catalogo prodotti con pagination cursor su API REST esterna, (4) webhook outbound notify verso CRM partner con telemetry SLA per audit.\n\n' +
    'Safety budget: SSRF guard via safeOutboundFetch (blocca 127.0.0.1, 10.x/172.16.x/192.168.x, link-local), max response size 50 MB (override per-call), timeout default 30s, retry max 5 attempts, circuit breaker apre su 5 fail consecutivi/30s. Audit log su ogni call con request_id + duration.',
  configFields: [
    // ────────── Core ──────────
    {
      key: 'method',
      label: 'Metodo HTTP',
      type: 'select',
      required: true,
      options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
      defaultValue: 'GET',
      help: 'GET=leggi · POST=crea · PUT/PATCH=aggiorna · DELETE=cancella · HEAD=solo headers · OPTIONS=preflight CORS.',
    },
    {
      key: 'url',
      label: 'URL',
      type: 'text',
      required: true,
      placeholder: 'https://api.example.com/v1/users/{{input.id}}',
      help: 'URL completo (http o https). Supporta {{espressioni}} per pezzi dinamici.',
    },

    // ────────── Authentication ──────────
    {
      key: 'authMode',
      label: 'Autenticazione',
      type: 'select',
      required: false,
      options: ['none', 'basic', 'bearer', 'apikey-header', 'custom', 'oauth2'],
      defaultValue: 'none',
      help:
        'none = nessuna (o gestita via Headers). ' +
        'basic = HTTP Basic (user+password → Base64). ' +
        'bearer = "Authorization: Bearer <token>" (JWT, OAuth access tokens). ' +
        'apikey-header = header custom con il valore (X-API-Key, X-Auth-Token, ecc). ' +
        'custom = nome+valore header completamente liberi. ' +
        'oauth2 = OAuth2 client_credentials (machine-to-machine): il nodo richiede da sé ' +
        'l\'access-token al token endpoint e lo inietta come Bearer (token cachato fino a scadenza).',
    },
    { key: 'basicUser', label: 'Username (Basic)', type: 'text', required: false, showIf: { field: 'authMode', equals: 'basic' } },
    { key: 'basicPass', label: 'Password (Basic)', type: 'secret', required: false, showIf: { field: 'authMode', equals: 'basic' } },
    { key: 'bearerToken', label: 'Token Bearer', type: 'secret', required: false, help: 'Il token segreto da mettere dopo "Bearer ".', showIf: { field: 'authMode', equals: 'bearer' } },
    { key: 'apiKeyHeaderName', label: 'Nome header API Key', type: 'text', required: false, defaultValue: 'X-API-Key', placeholder: 'X-API-Key  oppure  X-Auth-Token', showIf: { field: 'authMode', equals: 'apikey-header' } },
    { key: 'apiKeyValue', label: 'Valore API Key', type: 'secret', required: false, showIf: { field: 'authMode', equals: 'apikey-header' } },
    { key: 'customAuthHeaderName', label: 'Nome header custom', type: 'text', required: false, defaultValue: 'Authorization', showIf: { field: 'authMode', equals: 'custom' } },
    { key: 'customAuthHeaderValue', label: 'Valore header custom', type: 'secret', required: false, showIf: { field: 'authMode', equals: 'custom' } },
    // ── OAuth2 client_credentials
    { key: 'oauth2TokenUrl', label: 'Token endpoint URL', type: 'text', required: false, placeholder: 'https://login.example.com/oauth2/token', help: 'URL del token endpoint OAuth2 (grant client_credentials).', showIf: { field: 'authMode', equals: 'oauth2' } },
    { key: 'oauth2ClientId', label: 'Client ID', type: 'text', required: false, showIf: { field: 'authMode', equals: 'oauth2' } },
    { key: 'oauth2ClientSecret', label: 'Client secret', type: 'secret', required: false, showIf: { field: 'authMode', equals: 'oauth2' } },
    { key: 'oauth2Scope', label: 'Scope (opzionale)', type: 'text', required: false, placeholder: 'read:data write:data', help: 'Scope OAuth2 separati da spazio. Vuoto = nessuno scope richiesto.', showIf: { field: 'authMode', equals: 'oauth2' } },
    { key: 'oauth2AuthStyle', label: 'Invio credenziali client', type: 'select', required: false, options: ['header', 'body'], defaultValue: 'header', help: 'header = HTTP Basic sul token endpoint (default, RFC 6749). body = client_id/secret nel form.', showIf: { field: 'authMode', equals: 'oauth2' } },

    // ────────── Query parameters ──────────
    {
      key: 'queryParamsJson',
      label: 'Query Parameters',
      type: 'key-value',
      required: false,
      help: 'Aggiunti all\'URL come ?key=value&... Supportano {{espressioni}}.',
    },

    // ────────── Headers ──────────
    {
      key: 'headersJson',
      label: 'Headers HTTP extra',
      type: 'key-value',
      required: false,
      help: 'Coppie nome-valore extra (Authorization e Content-Type sono gestiti automaticamente).',
    },

    // ────────── Body ──────────
    {
      key: 'bodyType',
      label: 'Tipo body',
      type: 'select',
      required: false,
      options: ['none', 'json', 'form-urlencoded', 'multipart', 'raw-text', 'raw-binary-base64', 'binary'],
      defaultValue: 'json',
      help:
        'none = nessun body (GET/HEAD/DELETE tipicamente). ' +
        'json = JSON (Content-Type application/json). ' +
        'form-urlencoded = form classico (key=value&...). ' +
        'multipart = form-data con file/binary support. ' +
        'raw-text = testo grezzo (per XML, YAML, custom). ' +
        'raw-binary-base64 = bytes binari (body in base64, viene decodificato). ' +
        'binary = UPLOAD ref-primario: il body sono i byte di un handle BinaryData in ' +
        'INPUT (da Read File / http download / pdf / imap); Content-Type dal mimeType dell\'handle.',
    },
    {
      key: 'body',
      label: 'Body (JSON o testo)',
      type: 'code',
      language: 'json',
      required: false,
      placeholder: '{ "key": "{{input.value}}" }',
      help: 'Per json: JSON. Per raw-text: testo libero. Per raw-binary-base64: stringa base64.',
      showIf: { field: 'bodyType', in: ['json', 'raw-text', 'raw-binary-base64'] },
    },
    {
      key: 'rawBinaryContentType',
      label: 'Content-Type del binario',
      type: 'select',
      required: false,
      options: ['application/octet-stream', 'application/pdf', 'image/png', 'image/jpeg', 'application/zip'],
      defaultValue: 'application/octet-stream',
      showIf: { field: 'bodyType', equals: 'raw-binary-base64' },
    },
    {
      key: 'formFields',
      label: 'Form fields (key-value)',
      type: 'key-value',
      required: false,
      help: 'Coppie nome-valore del form. Per multipart con file: il valore puo` essere base64.',
      showIf: { field: 'bodyType', in: ['form-urlencoded', 'multipart'] },
    },

    // ────────── Pagination ──────────
    {
      key: 'paginationMode',
      label: 'Pagination',
      type: 'select',
      required: false,
      options: ['none', 'page-number', 'offset-limit', 'cursor', 'link-header'],
      defaultValue: 'none',
      help:
        'none = singola chiamata. ' +
        'page-number = ?page=1&limit=N, ?page=2&limit=N, ... (stop quando items < limit). ' +
        'offset-limit = ?offset=0&limit=N, ?offset=N&limit=N, ... ' +
        'cursor = leggi next_cursor dalla risposta, passa come ?cursor=... ' +
        'link-header = segui Link: <url>; rel="next" (GitHub, Mastodon).',
    },
    { key: 'paginationMaxPages', label: 'Max pagine', type: 'number', required: false, defaultValue: '10', help: 'Limite di sicurezza — interrompe il loop anche se ci sono altre pagine.', showIf: { field: 'paginationMode', in: ['page-number', 'offset-limit', 'cursor', 'link-header'] } },
    { key: 'paginationPageSize', label: 'Items per pagina (limit)', type: 'number', required: false, defaultValue: '50', showIf: { field: 'paginationMode', in: ['page-number', 'offset-limit'] } },
    { key: 'paginationItemsField', label: 'Campo array nella risposta', type: 'text', required: false, placeholder: 'es. data, items, results', help: 'Se valorizzato, concatena response[campo]. Se vuoto, concatena l\'intera response.', showIf: { field: 'paginationMode', in: ['page-number', 'offset-limit', 'cursor', 'link-header'] } },
    { key: 'paginationPageParam', label: 'Nome parametro pagina', type: 'text', required: false, defaultValue: 'page', showIf: { field: 'paginationMode', equals: 'page-number' } },
    { key: 'paginationStartPage', label: 'Pagina iniziale', type: 'number', required: false, defaultValue: '1', showIf: { field: 'paginationMode', equals: 'page-number' } },
    { key: 'paginationLimitParam', label: 'Nome parametro limit', type: 'text', required: false, defaultValue: 'limit', showIf: { field: 'paginationMode', in: ['page-number', 'offset-limit'] } },
    { key: 'paginationOffsetParam', label: 'Nome parametro offset', type: 'text', required: false, defaultValue: 'offset', showIf: { field: 'paginationMode', equals: 'offset-limit' } },
    { key: 'paginationStartOffset', label: 'Offset iniziale', type: 'number', required: false, defaultValue: '0', showIf: { field: 'paginationMode', equals: 'offset-limit' } },
    { key: 'paginationCursorParam', label: 'Nome parametro cursor', type: 'text', required: false, defaultValue: 'cursor', showIf: { field: 'paginationMode', equals: 'cursor' } },
    { key: 'paginationCursorField', label: 'Campo next cursor nella risposta', type: 'text', required: false, defaultValue: 'next_cursor', help: 'Es. next_cursor, nextPage, paging.next.cursor', showIf: { field: 'paginationMode', equals: 'cursor' } },

    // ────────── Retry ──────────
    {
      key: 'retryStrategy',
      label: 'Chi gestisce il retry',
      type: 'select',
      required: false,
      options: ['auto', 'node', 'workflow', 'none'],
      defaultValue: 'auto',
      help:
        'UN SOLO livello di retry (mai annidato). ' +
        'auto (default) = questo nodo HTTP ritenta internamente (consigliato: conosce retryOnStatus + Retry-After). ' +
        'node = come auto, esplicito. ' +
        'workflow = NON ritenta il nodo; lascia il retry al motore del workflow (retry generico per categoria d\'errore). ' +
        'none = nessun retry.',
    },
    { key: 'retryCount', label: 'Numero retry', type: 'number', required: false, defaultValue: '0', help: 'Quante volte ritentare in caso di errore (5xx o codici configurati). 0 = no retry. Ignorato se "Chi gestisce il retry" = workflow/none.' },
    { key: 'retryInitialDelayMs', label: 'Delay iniziale (ms)', type: 'number', required: false, defaultValue: '500', help: 'Pausa prima del primo retry. Si moltiplica per il fattore ad ogni tentativo.', showIf: { field: 'retryCount', truthy: true } },
    { key: 'retryBackoffFactor', label: 'Fattore backoff esponenziale', type: 'number', required: false, defaultValue: '2', help: '2 = raddoppia ogni retry (500ms, 1000ms, 2000ms, ...). 1 = delay costante.', showIf: { field: 'retryCount', truthy: true } },
    { key: 'retryOnStatus', label: 'Status da ritentare (csv)', type: 'text', required: false, defaultValue: '429,500,502,503,504', placeholder: '429,500,502,503,504', help: 'Codici HTTP che fanno scattare il retry. Errori di network/timeout sono sempre ritentati.', showIf: { field: 'retryCount', truthy: true } },

    // ────────── Response handling ──────────
    {
      key: 'responseFormat',
      label: 'Formato risposta',
      type: 'select',
      required: false,
      options: ['auto', 'json', 'text', 'binary'],
      defaultValue: 'auto',
      help:
        'auto = sniff dal Content-Type (default; octet-stream → handle binary). ' +
        'json = parse forzato (errore se non valido). ' +
        'text = stringa raw. ' +
        'binary = download come HANDLE BinaryData (ref content-addressed su disco): i byte ' +
        'NON entrano nel JSON → per PDF/immagini/file, anche grandi. Si collega a Write File / ' +
        'email / pdf / excel che consumano BinaryData (senza store: inline base64, fail-soft).',
    },
    { key: 'followRedirects', label: 'Segui redirect', type: 'boolean', required: false, defaultValue: 'true', help: 'Se on: segue 3xx automaticamente. Se off: restituisce status 3xx e header Location.' },
    { key: 'allowSelfSigned', label: 'Accetta certificati self-signed', type: 'boolean', required: false, defaultValue: 'false', help: 'Onorato SOLO verso host nella allowlist interna del tuo workspace (autorizzata da Zeli). Verso host pubblici resta IGNORATO e la verifica TLS è SEMPRE attiva (anti-MITM). Hai un endpoint interno con cert self-signed (es. ERP aziendale)? Richiedi l\'abilitazione dell\'host via email a info@zeli.it: lo aggiungiamo alla tua allowlist e questo flag diventa attivo per quell\'host.' },
    { key: 'statusCodeOnly', label: 'Solo status code (ignora body)', type: 'boolean', required: false, defaultValue: 'false', help: 'Se on: scarta il body, restituisce solo status+headers (piu` veloce per ping/healthcheck).' },
    { key: 'timeoutMs', label: 'Timeout (millisecondi)', type: 'number', required: false, defaultValue: '30000', help: 'Default 30s. Aumenta per API lente (es. report generation).' },
    { key: 'maxResponseMb', label: 'Max risposta (MB)', type: 'number', required: false, defaultValue: '50', help: 'Cap dimensione risposta (anti-OOM). Default 50 MB, max 500. Se superato (via content-length o in streaming) il nodo si ferma con errore invece di saturare la memoria.' },
    { key: 'throwOnError', label: 'Errore su status 4xx/5xx', type: 'boolean', required: false, defaultValue: 'true', help: 'Se on, lo step fallisce su errore HTTP non-recuperato dal retry.' },
  ],
  vendor: 'flowforge',
  version: '3.0.0',
  // Il nodo ritenta INTERNAMENTE (withRetry su retryOnStatus + Retry-After): l'engine
  // NON deve ri-ritentare → niente doppione annidato. Override via config.retryStrategy.
  selfManagedRetry: true,
  cost: {
    typicalLatencyMs: 200,
  },
};
