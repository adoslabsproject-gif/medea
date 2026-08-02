import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { loadConfig } from './config.js';
import { logger } from './lib/logger.js';
import { healthRoutes } from './routes/health.js';
import { createWorkflowRoutes } from './routes/workflows.js';
import { createNotificationsRoutes } from './routes/notifications.routes.js';
import { registerAccountStorageRoute } from './routes/account-storage.js';
import { registerTenantHealthRoute } from './routes/tenant-health.js';
import { createRunsArchiveRoutes } from './routes/runs-archive.js';
import { createRunRoutes } from './routes/runs.js';
import { createBinaryRoutes } from './routes/binary.js';
import { createSignalRoutes } from './routes/signals.js';
import { createHelpChatRoutes } from './routes/help-chat.js';
import { createUxTelemetryRoutes } from './routes/ux-telemetry.js';
import { createNodesCatalogRoutes } from './routes/nodes-catalog.js';
import { createCommunityNodesRoutes } from './routes/community-nodes.js';
import { createCustomNodesRoutes } from './routes/custom-nodes.js';
import { createAiScaffoldMissingNodesRoutes } from './routes/ai-scaffold-missing-nodes.js';
import { createRegistryServerRoutes } from './routes/registry-server.js';
import { loadInstalledFromDisk } from './services/community-nodes.service.js';
import { seedCommunityDefaults } from './services/community-nodes-bootstrap.js';
import { createTestNodeRoutes } from './routes/test-node.js';
import { createWebhookTestRoutes } from './routes/webhook-test.js';
import { createSubworkflowExtractRoutes } from './routes/subworkflow-extract.js';
import { createOAuthConnectRoutes } from './routes/oauth-connect.js';
import { createIntegrationsRoutes } from './routes/integrations-oauth.js';
import { createSystemEmailAccountsRoutes } from './routes/system-email-accounts.js';
import { createEmailOauthRoutes } from './routes/email-oauth.route.js';
import { createEmailTrackingRoutes } from './routes/email-tracking.route.js';
import { createFileBrowserRoutes } from './routes/file-browser.js';
import { createAiInteractionsRoutes } from './routes/ai-interactions.js';
import { RunService } from './services/run.service.js';
import { createNodeGeneratorRoutes } from './routes/node-generator.js';
import { createAuthRoutes } from './routes/auth.js';
import { createSSORoutes } from './routes/sso.js';
import { createDbStudioRoutes } from './routes/db-studio.js';
import { createDbRestRoutes } from './routes/db-rest.js';
import { createDbAgentChatRoutes } from './routes/db-agent-chat.js';
import { createWorkflowAgentRoutes } from './routes/workflow-agent.js';
import { createWebhookRoutes } from './routes/webhooks.js';
import { createWhatsAppTriggerRoutes } from './routes/whatsapp-trigger/index.js';
import { createTelegramTriggerRoutes } from './routes/telegram-trigger/index.js';
import { createStreamProxyNativeMiddleware } from './routes/stream-proxy-native.js';
import { WorkflowService } from './services/workflow.service.js';
import { createIntegrationWebhookRoutes } from './routes/integrations-webhooks.js';
import { createVersionRoutes } from './routes/versions.js';
import { createTemplateRoutes } from './routes/templates.js';
import { createVariableRoutes } from './routes/variables.js';
import { createRunHistoryRoutes } from './routes/runs-history.js';
import { createFormRoutes } from './routes/forms.js';
import { createCredentialsRoutes } from './routes/credentials.js';
import { createLlmProvidersRoutes } from './routes/llm-providers.js';
import { createAdminRoutes } from './routes/admin.js';
import { createDashboardRoutes } from './routes/dashboard.js';
import { createViewerShareRoutes, createPublicShareRoutes } from './routes/viewer-share.js';
import { createClientPortalAdminRoutes, createClientPortalPublicRoutes } from './routes/client-portal.js';
import { createVectorRoutes } from './routes/vector.js';
import { createOauthRoutes } from './routes/oauth.js';
import { createSamlRoutes } from './routes/saml.js';
import { createShareRoutes } from './routes/share.js';
import { createN8nImportRoutes } from './routes/n8n-import.js';
import { createBackupRoutes } from './routes/backup.js';
import { createAnalyticsRoutes } from './routes/analytics.js';
import { createAiAssistantRoutes } from './routes/ai-assistant.js';
import { createAiTemplatesRoutes } from './routes/ai-templates.js';
import { createUpgradeInfoRoute } from './routes/upgrade-info.js';
import { createInternalRunsActiveRoute } from './routes/internal-runs-active.js';
import { createPrivateGenerationsRoutes } from './routes/private-generations.js';
import { createStudioRoutes } from './routes/studio/index.js';
import { createAiMetricsRoutes } from './routes/ai-metrics.js';
import { createInvokeRoutes } from './routes/invoke.js';
import { createMcpRoutes } from './routes/mcp.js';
import { createPinRoutes } from './routes/pins.js';
import { createFolderRoutes } from './routes/folders.js';
import { createAuditRoutes } from './routes/audit.js';
import { createLicenseRoutes } from './routes/license.js';
import { createFormsListRoutes } from './routes/forms-list.js';
import { createMetricsRoutes } from './routes/metrics.js';
import { createUsersRoutes } from './routes/users.js';
import { createClientErrorsRoutes } from './routes/client-errors.js';
import { createMarketplaceRoutes } from './routes/marketplace.js';
import { createRunReplayRoutes } from './routes/run-replay.js';
import { createErrorWorkflowSettingsRoutes } from './routes/error-workflow-settings.js';
import { createAiChatRoutes } from './routes/ai-chat.js';
import { createJanitorRoutes } from './routes/janitor.js';
import { createJanitorRuntime, type JanitorRuntime } from './services/janitor/index.js';
import { DbStudioService } from './services/db-studio.service.js';
import { authMiddleware } from './middleware/auth.js';
import { tenantStatusMiddleware } from './middleware/tenant-status.js';
import { PUBLIC_PREFIXES, PUBLIC_PATH_PATTERNS } from './middleware/auth-public-paths.js';
import { rateLimit } from './middleware/rate-limit.js';
import { publicWebhookRateLimitKey } from './lib/webhook-rate-limit-key.js';
import { getAuthKeys } from './lib/auth-keys.js';
import { InMemoryEventBus } from './adapters/event-bus-memory.js';
import { attachStaticUi } from './lib/static-ui.js';
import type { IEventBus } from './ports/event-bus.js';

export interface ServerDependencies {
  eventBus: IEventBus;
  /**
   * Janitor runtime (data quality self-healing). Iniettato dal main.ts.
   * Se omesso (es. test isolati), il createServer ne istanzia uno
   * "headless" che non viene mai started — esposto comunque alle route
   * per non rompere il dependency graph.
   */
  janitor?: JanitorRuntime;
}

export async function createServer(deps: ServerDependencies = { eventBus: new InMemoryEventBus() }): Promise<Hono> {
  const config = loadConfig();
  const app = new Hono();
  const keys = await getAuthKeys();

  // Boot step 1/2: seed community defaults dall'image runtime al data dir
  // tenant (idempotente). I 7 community ufficiali (telegram, slack, github,
  // notion, stripe, linear, discord) sono COPIATI nell'image Docker e
  // estesi al tenant alla prima boot. Vedi community-nodes-bootstrap.ts.
  try {
    const seed = await seedCommunityDefaults();
    if (seed.seeded.length > 0) {
      logger.info({ seeded: seed.seeded }, 'Seeded community defaults from image');
    }
    if (seed.errors.length > 0) {
      logger.warn({ errors: seed.errors }, 'Some community defaults failed to seed');
    }
  } catch (err) {
    logger.error({ err }, 'Community defaults seeding failed — continuing');
  }

  // Boot step 2/2: hot-load installed community nodes from disk. Cheap on
  // boot (typically <50ms even with dozens installed). Errors are logged
  // but never fatal — a single broken package doesn't take down the runtime.
  try {
    const count = await loadInstalledFromDisk();
    if (count > 0) logger.info({ count }, 'Loaded installed community nodes');
  } catch (err) {
    logger.error({ err }, 'Failed to scan installed community nodes — continuing without them');
  }

  // AUDIT FIX WE-10 (2026-06-09 HIGH): body size cap globale anti JSON-bomb.
  //
  // Pre-fix: nessun bodyLimit middleware → `c.req.json()` / `c.req.text()`
  // accettavano payload illimitato. Specifico per /workflows/:id/pins (output_json
  // text column SQLite senza CHECK): un user malicious poteva PUT GB di JSON in
  // un pin → DB bloat + memoria container. /n8n-import + /invoke + /webhooks
  // hanno stesso vector. Cap: 10MB default — copre n8n export di 1000+ nodi
  // (~5MB typical) + margine. Routes specifiche (es. file upload streaming)
  // possono override con cap proprio.
  const { bodyLimit } = await import('hono/body-limit');
  app.use('*', bodyLimit({
    maxSize: 10 * 1024 * 1024, // 10MB
    onError: (c) => c.json({ error: { code: 'BODY_TOO_LARGE', message: 'Request body exceeds 10MB cap.' } }, 413),
  }));

  app.use(
    '*',
    cors({
      origin: config.CORS_ORIGINS.split(',').map((s) => s.trim()),
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Id', 'X-Actor-Id'],
      credentials: true,
    }),
  );
  // Security headers: in produzione li emette NGINX (single source of truth)
  // per evitare duplicati che penalizzano securityheaders.com da A+ a A.
  // Per dev/standalone senza nginx davanti, settare
  // MEDEA_STANDALONE=1 per riabilitare l'emissione lato app.
  if (process.env.MEDEA_STANDALONE === '1') {
    app.use('*', secureHeaders());
  }

  // Honeypot — PRIMA del logger access (così scanner non inquinano i log
  // access con migliaia di hit; restano i log honeypot dedicati) e PRIMA
  // di ogni route mount + attachStaticUi (così intercetta path /@fs/,
  // /wp-admin, /.env, etc. che altrimenti caderebbero nello SPA fallback
  // ritornando 200 + index.html — vedi #194 audit). Import dinamico per
  // evitare side-effect a import-time durante tests/migrations.
  const { honeypotMiddleware } = await import('./middleware/honeypot.js');
  app.use('*', honeypotMiddleware());

  // HIGH (2026-05-29): Origin-based CSRF defense-in-depth.
  // Cookie ff_session ha SameSite=Lax che blocca classic form-CSRF, ma
  // ATTENZIONE: tenant condividono eTLD+1 (*.app.automazionezeli.com),
  // quindi cookie cross-subdomain potrebbe essere abusato. Origin check
  // rifiuta mutating cross-origin requests.
  const { originCsrf } = await import('./middleware/origin-csrf.js');
  app.use('/api/v1/*', originCsrf({
    allowedOrigins: ['https://flowforge.automazionezeli.com'],
    allowedOriginPatterns: [/^https:\/\/[a-z0-9-]+\.app\.automazionezeli\.com$/],
    // Internal S2S endpoints + public share + portal token-gated → skip
    // perche\` autenticati via X-Internal-Token o magic-link token in path.
    skipPaths: [
      /^\/api\/v1\/internal\//,
      /^\/api\/v1\/share\//,
      /^\/api\/v1\/portal\//,
      /^\/api\/v1\/webhooks\//,
      /^\/api\/v1\/oauth-connect\//,
    ],
  }));

  app.use('*', honoLogger((message) => {
    logger.info({ hono: true }, message);
  }));

  app.use(
    '/api/v1/*',
    authMiddleware({
      publicKeyPem: keys.publicKeyPem,
      // Auth SEMPRE required — anche in dev. Misconfig di NODE_ENV nel
      // container tenant (env unset, default '') NON deve disabilitare auth.
      // Bypass solo via `publicPrefixes` / `publicPaths` esplicite.
      required: true,
      // Allowlist path pubblici — single source of truth in auth-public-paths.ts
      // (estratta per essere testabile in isolamento). NON aggiungere path qui:
      // modifica il modulo, coperto da auth-public-paths.test.ts.
      publicPrefixes: [...PUBLIC_PREFIXES],
      publicPathPatterns: [...PUBLIC_PATH_PATTERNS],
    }),
  );

  // AUDIT FIX C4 (2026-06-09) — tenantStatusMiddleware enforcement:
  //
  // Pre-fix: il middleware era esportato da middleware/tenant-status.ts ma
  // MAI montato in server.ts. Tenant suspended/archived/deleted potevano
  // continuare a eseguire workflow + LLM + DB studio → quota burning + violazione
  // del lifecycle. I commenti in sso.ts:268 lasciavano credere fosse attivo.
  //
  // Wire-up: DOPO authMiddleware (legge tenantId dalla session decoded), su
  // /api/v1/* — il middleware stesso skippa READ-only + auth/sso/health/webhooks
  // (skip-list interna) → solo POST/PUT/PATCH/DELETE su route data-modifying.
  app.use('/api/v1/*', tenantStatusMiddleware());

  app.route('/', healthRoutes);
  app.route('/', createMetricsRoutes());
  app.route('/api/v1', createAuthRoutes());
  // SSO bridge dal portal zeliAI (JWE A256GCM, single-use jti, 5min TTL).
  // Path /sso (NON /api/v1/sso) — bookmark-friendly + public per definizione.
  app.route('/', createSSORoutes());

  // Favicon — il runtime non serve static UI (l'editor frontend e` deploy
  // separato). I browser pero` chiedono `/favicon.ico` di default sui domini
  // tenant: rispondiamo 204 No Content invece di 404 (silenzia log + risparmia
  // bandwidth). Cache 1h per evitare re-fetch a ogni navigation.
  app.get('/favicon.ico', (c) => {
    c.header('Cache-Control', 'public, max-age=3600, immutable');
    return c.body(null, 204);
  });
  app.route('/api/v1/auth', createOauthRoutes());
  app.route('/api/v1/auth', createSamlRoutes());
  app.route('/api/v1/workflows', createWorkflowRoutes(deps.eventBus));
  app.route('/api/v1/notifications', createNotificationsRoutes());
  app.route('/api/v1', createRunRoutes(deps.eventBus));
  // Binary download (gap #6): serve i blob del BinaryStore content-addressed.
  // Auth-gated dal middleware globale; il ref è validato anti-traversal nello store.
  app.route('/api/v1', createBinaryRoutes());
  app.route('/api/v1/signals', createSignalRoutes(new RunService(deps.eventBus)));
  app.route('/api/v1/help-chat', createHelpChatRoutes());
  app.route('/api/v1/ux', createUxTelemetryRoutes());
  app.route('/api/v1/nodes', createNodesCatalogRoutes());
  // Banner upgrade info per editor SPA — proxy verso portal /runtime-status
  // con cache 5min, soft-fail (mai blocca UI). Vedi routes/upgrade-info.ts.
  app.route('/api/v1', createUpgradeInfoRoute());
  // F2 Cappella 2026-06-07: tier-aware storage quota endpoint.
  registerAccountStorageRoute(app);
  // Tenant Health: stato runtime del container (tab Settings, ex multi-tenant).
  registerTenantHealthRoute(app);
  // F3 Cappella: runs archive list + download (.jsonl.gz HMAC-firmati).
  app.route('/api/v1', createRunsArchiveRoutes(deps.eventBus));
  // Internal endpoint S2S: portal sweeper interroga per evitare di pausare
  // un container con run attivi (vedi routes/internal-runs-active.ts).
  app.route('/api/v1', createInternalRunsActiveRoute());
  // Storage privato generazioni media (gen-studio → save/rate/list/media). S2S internal-token.
  app.route('/api/v1', createPrivateGenerationsRoutes());
  // Mount community-nodes UNDER its own sub-path so the requireRole('owner')
  // middleware applied inside doesn't bleed into the sibling /api/v1/* routes.
  app.route('/api/v1/community-nodes', createCommunityNodesRoutes());
  // Custom Node Editor (Fase 1, 2026-06-08): owner-only CRUD per nodi creati
  // dall'utente nel suo workspace. Mount sotto sub-path per requireRole('owner').
  app.route('/api/v1/custom-nodes', createCustomNodesRoutes());
  // AI Scaffold Step 4 (2026-06-09): missing-node wizard orchestrator.
  // Quando Liara genera defId che non esistono in nessun catalog, l'endpoint
  // sintetizza JIT custom node tenant-private + riscrive il workflow.
  app.route('/api/v1/ai-scaffold', createAiScaffoldMissingNodesRoutes());
  // Public registry — no auth required (read-only). Lives at /registry/* so
  // any FlowForge instance can fetch from any other instance's registry.
  app.route('/registry', createRegistryServerRoutes());
  app.route('/api/v1', createTestNodeRoutes(deps.eventBus));
  app.route('/api/v1', createWebhookTestRoutes());
  app.route('/api/v1', createSubworkflowExtractRoutes(deps.eventBus));
  app.route('/api/v1/oauth-connect', createOAuthConnectRoutes());
  app.route('/api/v1/integrations', createIntegrationsRoutes());
  app.route('/api/v1/system/email-accounts', createSystemEmailAccountsRoutes());
  // Gmail OAuth2 flow (start / callback / status / refresh). Mounted at
  // /api/v1 so the redirect URI is /api/v1/email-accounts/oauth/google/callback.
  app.route('/api/v1', createEmailOauthRoutes());
  // Email tracking: open pixel + click redirect. Public (HMAC token =
  // auth). Mounted at root so paths are /api/track/{open,click}/:token.
  app.route('/', createEmailTrackingRoutes());
  app.route('/api/v1/file-browser', createFileBrowserRoutes());
  app.route('/api/v1/ai-interactions', createAiInteractionsRoutes());
  app.route('/api/v1', createVersionRoutes(deps.eventBus));
  app.route('/api/v1', createVariableRoutes());
  app.route('/api/v1', createRunHistoryRoutes(deps.eventBus));
  app.route('/api/v1', createNodeGeneratorRoutes());
  app.route('/api/v1/db', createDbStudioRoutes());
  app.route('/api/v1/db', createDbRestRoutes());
  app.route('/api/v1/db-agent', createDbAgentChatRoutes());
  app.route('/api/v1/workflow-agent', createWorkflowAgentRoutes());
  app.route('/api/v1/vector', createVectorRoutes());
  app.route('/api/v1/templates', createTemplateRoutes(deps.eventBus));
  app.route('/api/v1/credentials', createCredentialsRoutes());
  app.route('/api/v1/llm-providers', createLlmProvidersRoutes());
  app.route('/api/v1', createAdminRoutes());
  app.route('/api/v1/dashboard', createDashboardRoutes(deps.eventBus));
  app.route('/api/v1', createViewerShareRoutes());
  app.route('/api/v1', createPublicShareRoutes());
  // Client Portal — admin CRUD (owner-gated) + public token-gated (no auth)
  app.route('/api/v1', createClientPortalAdminRoutes());
  app.route('/api/v1', createClientPortalPublicRoutes(deps.eventBus));
  app.route('/api/v1', createShareRoutes(deps.eventBus));
  app.route('/api/v1', createN8nImportRoutes(deps.eventBus));
  app.route('/api/v1', createBackupRoutes());
  app.route('/api/v1', createAnalyticsRoutes());
  app.route('/api/v1', createAiAssistantRoutes());
  app.route('/api/v1', createAiMetricsRoutes());
  app.route('/api/v1/ai-templates', createAiTemplatesRoutes());
  app.route('/api/v1', createInvokeRoutes(deps.eventBus));
  app.route('/api/v1', createMcpRoutes(deps.eventBus));

  // Janitor — Data Quality Self-Healing. Esposto sotto /api/v1/janitor/*.
  // Se non iniettato dal main (test isolato), ne creiamo uno "headless"
  // — funziona per le route ma non viene start-ato qui (lo fa main.ts).
  const janitorRuntime: JanitorRuntime = deps.janitor ?? createJanitorRuntime({
    dbStudio: new DbStudioService(),
  });
  app.route('/api/v1/janitor', createJanitorRoutes(janitorRuntime));
  app.route('/api/v1', createPinRoutes());
  app.route('/api/v1', createFolderRoutes());
  app.route('/api/v1', createAuditRoutes());
  app.route('/api/v1', createLicenseRoutes());
  app.route('/api/v1', createFormsListRoutes());
  app.route('/api/v1', createUsersRoutes());
  app.route('/api/v1', createClientErrorsRoutes());
  app.route('/api/v1', createMarketplaceRoutes());
  app.route('/api/v1', createRunReplayRoutes(deps.eventBus));
  // GAP 5 (d): catch-all error-workflow di tenant (GET pubblico-auth, PUT admin).
  app.route('/api/v1', createErrorWorkflowSettingsRoutes(deps.eventBus));
  app.route('/api/v1/ai-chat', createAiChatRoutes());
  // HIGH (2026-05-29): rate-limit /webhooks/c/* per IP — anti brute-force
  // del token in URL. 60 req/min per IP e\` largo per legitimate Stripe/
  // GitHub callbacks (mai vicino al cap) ma blocca enumerazione.
  //
  // 2026-06-06 (BUG #138 fix): use case STREAMING HLS (stream/proxy.*) deve
  // bypassare il bucket — un singolo VLC al boot fetcha master + 36 sub-
  // playlist + AES key + 2-3 stream variants in burst (~40 req nei primi
  // 2 sec). Il bucket 60/60s rate-limita VLC al primo playback → "Invalid
  // data found" sul primo TS segment. Il proxy ha gia\` HMAC firma URL +
  // TTL 2h come anti-enumerazione/anti-replay — il rate-limit add nothing.
  const STREAM_PROXY_PATH = /^\/webhooks\/c\/stream\/proxy\.(m3u8|m3u|ts|vtt|key|mp4|m4s|aac|webvtt)\b/u;
  app.use('/webhooks/c/*', async (c, next) => {
    if (STREAM_PROXY_PATH.test(c.req.path)) {
      // Skip rate-limit: HLS streaming legit traffic.
      return next();
    }
    return rateLimit({
      label: 'webhook_c',
      windowMs: 60_000,
      perTenant: 60,
      tenantFrom: (cc) => cc.req.header('cf-connecting-ip') ?? cc.req.header('x-forwarded-for') ?? 'unknown',
    })(c as Context, next);
  });

  // Stream Proxy Native — bypassa il sandbox isolated-vm per HLS streaming.
  // Match: /webhooks/c/stream/proxy.(m3u8|m3u|ts|vtt|key|mp4|m4s|aac|webvtt)/:token?u=&e=&sig=
  // Pipe diretto upstream → response, Range pass-through, M3U8 rewrite inline.
  // Cade-su-no-match → next() → customPathHandler legacy (workflow run).
  const workflowService = new WorkflowService(deps.eventBus);
  app.use('/webhooks/c/*', createStreamProxyNativeMiddleware({ workflows: workflowService }));

  // AUDIT MEDIUM (2026-06-11): rate-limit per (webhook, IP) sulle route pubbliche
  // /webhooks/* e /forms/* (workflow webhooks, integration receivers, form trigger).
  // Senza, un webhook `authMode:none` (default consentito) è un vettore DoS/abuse:
  // ogni hit fa girare il workflow (CPU/IO del container). Key = workflowId+IP →
  // un singolo IP non può floodare nessun webhook, provider legittimi (Stripe/
  // GitHub, IP distinti) restano indipendenti. /webhooks/c/* ha già il suo bucket
  // (sopra, con bypass HLS) → qui lo skippiamo per non doppio-contare.
  const webhookKeyFrom = (c: Context): string => {
    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
    return publicWebhookRateLimitKey(c.req.path, ip);
  };
  const publicHookLimiter = rateLimit({
    label: 'webhook_public',
    windowMs: 60_000,
    perTenant: 120, // 120/min per (webhook, IP) — generoso per provider legit, blocca flood
    tenantFrom: webhookKeyFrom,
  });
  app.use('/webhooks/*', async (c, next) => {
    if (c.req.path.startsWith('/webhooks/c/')) return next(); // già rate-limited sopra
    return publicHookLimiter(c as Context, next);
  });
  app.use('/forms/*', publicHookLimiter);

  // WhatsApp trigger (Meta Cloud API) — PRIMA delle route generiche
  // /:workflowId/:token: il prefisso statico /whatsapp/ non deve essere
  // catturato dai param del webhook generico. Auth = handshake verify-token
  // (GET) + firma X-Hub-Signature-256 obbligatoria (POST), fail-closed.
  app.route('/webhooks', createWhatsAppTriggerRoutes(deps.eventBus));
  // Telegram trigger (Bot API) — stesso pattern del gemello WhatsApp:
  // prefisso statico /telegram/, auth = secret header fail-closed.
  app.route('/webhooks', createTelegramTriggerRoutes(deps.eventBus));
  app.route('/webhooks', createWebhookRoutes(deps.eventBus));
  // Integration provider webhook receivers (Stripe HMAC, ...). Mount sotto
  // /webhooks/ così Stripe Dashboard punta a https://<tenant>.app.../webhooks/stripe
  // come endpoint registered.
  app.route('/webhooks', createIntegrationWebhookRoutes(deps.eventBus));
  app.route('/forms', createFormRoutes(deps.eventBus));
  // Studio privato (generazione media) servito all'URL del tenant — PRIMA dello
  // static-ui catch-all, gated dalla sessione owner.
  app.route('/', createStudioRoutes());

  // Bundled UI (if present) — served on the same port as the API.
  // The catch-all goes LAST so it doesn't shadow any /api/* or /webhooks/* paths.
  attachStaticUi(app);

  app.onError((err, c) => {
    const reqId = c.req.header('x-request-id') ?? c.get('requestId' as never) ?? 'unknown';
    // Errori CLIENT tipati (es. WorkflowValidationError, 400): rispettiamo il
    // loro httpStatus + esponiamo il messaggio (è una validazione dell'input,
    // safe e utile — NON un leak schema/SQL). Solo i 5xx inattesi restano
    // generici. Pre-fix: un workflow invalido (edge orfani) dava 500 "Errore
    // interno" — fuorviante (colpa dell'input, non del server).
    const typed = err as { httpStatus?: unknown; expose?: unknown; code?: unknown };
    if (typeof typed.httpStatus === 'number' && typed.httpStatus >= 400 && typed.httpStatus < 500 && typed.expose === true) {
      logger.warn({ reqId, path: c.req.path, method: c.req.method, code: typed.code, msg: err.message }, 'Client error');
      return c.json({ error: { code: typeof typed.code === 'string' ? typed.code : 'BAD_REQUEST', message: err.message, reqId } }, typed.httpStatus as 400);
    }
    logger.error({ err, reqId, path: c.req.path, method: c.req.method }, 'Unhandled error');
    // In prod NON ritorniamo err.message (leak schema/file path/SQL). Solo
    // code+message generici + reqId per correlation con logs interni.
    // In dev/test mantiene err.message per debugging local.
    const isProd = process.env.NODE_ENV === 'production';
    if (isProd) {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Errore interno', reqId } }, 500);
    }
    return c.json({ error: { code: 'INTERNAL_ERROR', message: err.message, reqId } }, 500);
  });

  return app;
}
