import type { NodeModule } from '../types.js';

/**
 * Webhook trigger — opens the request/response cycle. Paired with the
 * action_webhook_respond node when you want a synchronous reply.
 *
 * v2.0 (Federico-grade):
 *   • Custom path (in addition to the default /webhooks/:id/:token)
 *   • CORS Allowed Origins (browser-callable webhooks)
 *   • Raw body capture (needed for HMAC signature validation — Stripe,
 *     GitHub send the digest over the raw bytes, not the parsed JSON)
 *   • HEAD method support
 *   • JWT auth mode
 *   • Response data shape selector for the default envelope
 *   • Ignore bot user-agents toggle
 */
export const webhookTriggerNode: NodeModule = {
  def: {
    id: 'trigger_webhook',
    type: 'trigger',
    label: 'Webhook',
    icon: 'link',
    color: '#22c55e',
    description:
      'Avvia il workflow quando una richiesta HTTP arriva all\'URL del webhook. URL pubblico generato automaticamente (path = workflow_id + token random) e mostrato nel pannello "Webhook URL" del nodo. Path custom opzionale via customPath per URL leggibili (es. /webhooks/c/stripe/event invece di /webhooks/<uuid>).\n\n' +
      'Differenza con i sibling: trigger_webhook = endpoint always-on, request-response. Per sospensione mid-workflow con resume su callback vedi logic_wait_signal. Per ingest email usa trigger_imap. Per polling DB usa trigger_db_change. Per scheduled jobs usa trigger_cron.\n\n' +
      'Auth modes: none (pubblico, signed token nel URL), header-token (Authorization: Bearer <token>), hmac-signature (HMAC-SHA256 del body con secret condiviso — pattern Stripe/PayPal/Slack), basic-auth (RFC 7617), jwt (verifica issuer/audience/exp). HMAC e\\` raccomandato per integrazioni B2B production — il token nel URL e\\` log-leak vulnerable mentre la firma HMAC valida ogni request anche se URL e\\` intercettata.\n\n' +
      'Response modes (responseMode): (a) immediate = 202 Accepted subito + workflow async (raccomandato per webhook esterni ad alta frequenza Stripe/SDI), (b) wait-for-workflow = aspetta il workflow e ritorna {runId, status} JSON, (c) use-respond-node = aspetta il workflow E un nodo action_webhook_respond finale decide status+body+headers (API REST custom).\n\n' +
      'Features production-grade: raw body capture (per HMAC verify byte-perfect senza JSON re-serialization che spaccherebbe la firma), CORS configurabile per integrazioni browser (origin allowlist, preflight handled), anti-replay dedup su firma HMAC (cache LRU per nodeId+signature, TTL 10min — una request HMAC gia\\` vista viene rifiutata, AUDIT WE-4), dedup via header Idempotency-Key (pattern Stripe: un retro del client con lo stesso Idempotency-Key entro 24h ritorna 200 {duplicate:true} senza rieseguire il workflow), rate-limit per-webhook configurabile (rateLimitPerMin, fixed-window per nodeId+IP → 429 + Retry-After oltre la soglia; 0 = disabilitato), audit on-hit (ogni hit autorizzato loggato con ip + method + SHA-256 del body, mai il payload in chiaro).\n\n' +
      'Use case: (1) callback Stripe/PayPal/SDI post-pagamento con HMAC verify e branching su event type, (2) endpoint API REST custom per integrazioni vendor B2B con header-token, (3) submit form landing page (response HTML redirect post-success), (4) inbound webhook firmato HMAC con anti-replay automatico.\n\n' +
      'Safety budget: token URL confrontato in modo timing-safe, anti-replay HMAC (TTL 10min, cap 10k), dedup Idempotency-Key (TTL 24h), rate-limit per-webhook (429 + Retry-After), CORS allowlist. La verifica firma/JWT e\\` byte-perfect sul raw body.',
    configFields: [
      // ────────── Routing ──────────
      {
        key: 'method',
        label: 'Metodo HTTP accettato',
        type: 'select',
        required: true,
        options: ['POST', 'GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY'],
        defaultValue: 'POST',
        help:
          'POST = riceve payload nel body (default per la maggioranza dei webhook). ' +
          'GET = solo query string (ping/test/pagine). PUT/PATCH/DELETE per REST. ' +
          'HEAD = solo headers (health check). OPTIONS = preflight CORS. ' +
          'ANY = accetta qualsiasi metodo. Solo questo metodo è accettato — gli altri ritornano 405.',
      },
      {
        key: 'customPath',
        label: 'Percorso URL personalizzato',
        type: 'text',
        required: false,
        placeholder: 'tesi  oppure  webhook/orders',
        help:
          'Se vuoto: usa il path auto-generato /webhooks/:workflowId/:token. ' +
          'Se valorizzato: il webhook è raggiungibile anche su /webhooks/c/<percorso>/:token ' +
          '(es. "tesi" → /webhooks/c/tesi/:token). Utile per URL brand-friendly o ' +
          'compatibili con sistemi che non accettano UUID nel path.',
      },

      // ────────── Authentication ──────────
      {
        key: 'authMode',
        label: 'Autenticazione richiesta',
        type: 'select',
        required: false,
        options: ['none', 'header-token', 'basic-auth', 'hmac-signature', 'jwt'],
        defaultValue: 'none',
        help:
          'none = aperto (PROTEGGI con IP allowlist sotto). ' +
          'header-token = "Authorization: Bearer <token>". ' +
          'basic-auth = HTTP Basic standard. ' +
          'hmac-signature = firma HMAC del body (Stripe, GitHub, Shopify, Twilio). ' +
          'jwt = JSON Web Token firmato (verifica issuer/audience/exp).',
      },
      {
        key: 'authSecret',
        label: 'Token / Password',
        type: 'secret',
        required: false,
        help: 'header-token: il token segreto. basic-auth: la sola password (lo username va sotto).',
        showIf: { field: 'authMode', in: ['header-token', 'basic-auth'] },
      },
      {
        key: 'basicAuthUsername',
        label: 'Username (basic-auth)',
        type: 'text',
        required: false,
        placeholder: 'es. webhook-client',
        help: "Username dell'header Authorization: Basic. Il client costruisce base64(user:pass).",
        showIf: { field: 'authMode', equals: 'basic-auth' },
      },
      {
        key: 'hmacSecret',
        label: 'Chiave HMAC condivisa',
        type: 'secret',
        required: false,
        help: 'Chiave segreta del mittente. Tipicamente fornita dal provider (es. Stripe Signing Secret).',
        showIf: { field: 'authMode', equals: 'hmac-signature' },
      },
      {
        key: 'hmacHeader',
        label: 'Nome header con la firma',
        type: 'select',
        required: false,
        options: [
          'X-Hub-Signature-256',
          'X-Signature-SHA256',
          'X-Signature',
          'Stripe-Signature',
          'X-Shopify-Hmac-Sha256',
          'X-Twilio-Signature',
          'X-Webhook-Signature',
        ],
        defaultValue: 'X-Hub-Signature-256',
        help: 'GitHub/GitLab = X-Hub-Signature-256. Stripe = Stripe-Signature. Shopify = X-Shopify-Hmac-Sha256.',
        showIf: { field: 'authMode', equals: 'hmac-signature' },
      },
      {
        key: 'hmacAlgo',
        label: 'Algoritmo HMAC',
        type: 'select',
        required: false,
        options: ['sha256', 'sha1', 'sha512'],
        defaultValue: 'sha256',
        help: 'sha256 = standard moderno. sha1 = legacy. sha512 = paranoico.',
        showIf: { field: 'authMode', equals: 'hmac-signature' },
      },
      {
        key: 'jwtSecret',
        label: 'JWT Secret / Public Key',
        type: 'secret',
        required: false,
        help: 'Per HS256: la chiave condivisa. Per RS256/ES256: la public key del firmatario (PEM).',
        showIf: { field: 'authMode', equals: 'jwt' },
      },
      {
        key: 'jwtAlgo',
        label: 'Algoritmo JWT',
        type: 'select',
        required: false,
        options: ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384'],
        defaultValue: 'HS256',
        help: 'HS = HMAC (symmetric). RS = RSA. ES = ECDSA. Auth0/Cognito usano RS256.',
        showIf: { field: 'authMode', equals: 'jwt' },
      },
      {
        key: 'jwtIssuer',
        label: 'Issuer atteso (opzionale)',
        type: 'text',
        required: false,
        placeholder: 'https://auth.example.com/',
        help: 'Se valorizzato, il claim "iss" del token DEVE matchare esattamente. Lascia vuoto per non controllare.',
        showIf: { field: 'authMode', equals: 'jwt' },
      },
      {
        key: 'jwtAudience',
        label: 'Audience attesa (opzionale)',
        type: 'text',
        required: false,
        placeholder: 'flowforge-api',
        help: 'Se valorizzato, il claim "aud" DEVE matchare. Lascia vuoto per non controllare.',
        showIf: { field: 'authMode', equals: 'jwt' },
      },

      // ────────── Network filters ──────────
      {
        key: 'ipAllowlist',
        label: 'IP allowlist',
        type: 'chip-list',
        required: false,
        placeholder: 'es. 192.168.1.0/24',
        help: 'Lista IP/CIDR autorizzati. Vuoto = qualsiasi IP. Es. "203.0.113.42, 10.0.0.0/8".',
      },
      {
        key: 'ignoreBots',
        label: 'Ignora bot',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help:
          'Se on: respinge richieste con User-Agent contenente "bot", "crawler", "spider", "scrape" ' +
          "(non è una difesa di sicurezza — è un filtro contro indicizzatori che vedono l'URL nei log).",
      },

      // ────────── CORS ──────────
      {
        key: 'corsOrigin',
        label: 'CORS Allowed Origin',
        type: 'text',
        required: false,
        placeholder: '*  oppure  https://miosito.com',
        help:
          'Header Access-Control-Allow-Origin sulla response. Necessario se il webhook viene chiamato da ' +
          'browser (es. fetch() da una webapp su un altro dominio). "*" = qualsiasi origine (permissivo). ' +
          'Per produzione metti il dominio specifico.',
      },
      {
        key: 'corsAllowCredentials',
        label: 'CORS Allow Credentials',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'Se on: Access-Control-Allow-Credentials: true (permette cookies cross-origin). NON usabile insieme a Origin="*".',
      },

      // ────────── Body handling ──────────
      {
        key: 'rawBody',
        label: 'Preserva raw body (per HMAC)',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help:
          "Se on: il body grezzo (stringa esatta dei bytes ricevuti) viene incluso nell'output del trigger " +
          'come campo "rawBody". OBBLIGATORIO se vuoi rifare la validazione HMAC fuori da FlowForge — Stripe ' +
          'e GitHub firmano i bytes esatti, non il JSON dopo parse/serialize.',
      },

      // ────────── Response shape ──────────
      {
        key: 'responseMode',
        label: 'Come rispondere al chiamante',
        type: 'select',
        required: false,
        options: ['immediate', 'wait-for-workflow', 'use-respond-node'],
        defaultValue: 'immediate',
        help:
          'immediate = 202 Accepted appena ricevuta (raccomandato per webhook esterni). ' +
          'wait-for-workflow = aspetta il workflow e ritorna {runId, status} JSON. ' +
          'use-respond-node = aspetta il workflow E usa un nodo "Webhook: Respond" alla fine ' +
          'per personalizzare body/status/headers (per HTML pages, redirect, ecc.).',
      },
      {
        key: 'responseShape',
        label: "Shape dell'output (modalità wait-for-workflow)",
        type: 'select',
        required: false,
        options: ['envelope', 'last-step-output', 'all-steps-output'],
        defaultValue: 'envelope',
        help:
          'envelope = {runId, status} (default). ' +
          "last-step-output = ritorna solo l'output dell'ultimo nodo come JSON. " +
          'all-steps-output = array completo di tutti gli step. ' +
          'Ignorato se responseMode=immediate o use-respond-node.',
        showIf: { field: 'responseMode', equals: 'wait-for-workflow' },
      },

      // ────────── Safety ──────────
      {
        key: 'rateLimitPerMin',
        label: 'Rate-limit (richieste/minuto per IP)',
        type: 'number',
        required: false,
        defaultValue: '0',
        help:
          'Massimo richieste al minuto accettate da uno stesso IP su questo webhook (finestra fissa). ' +
          'Oltre la soglia → 429 Too Many Requests + header Retry-After. 0 = nessun limite (default). ' +
          'Tipico: 60-120 per callback provider, più basso per form pubblici esposti a spam.',
      },
    ],
    vendor: 'flowforge',
    version: '2.1.0',
  },
};
