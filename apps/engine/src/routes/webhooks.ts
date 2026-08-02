/**
 * Webhook routes — auto-registered per workflow that contains a `trigger_webhook` node.
 * URL shape: /webhooks/:workflowId/:token
 *
 * SECURITY (FIX 2026-05-31 audit HIGH-1):
 *   In modalità `none` (default), il `:token` deve matchare HMAC-SHA256(workflowId, SSO_SECRET).
 *   La conoscenza del solo workflowId UUID NON è più sufficiente a fire il webhook.
 *   Per altre modalità (header-token, basic-auth, hmac-signature, jwt), il token URL
 *   non è verificato perché l'auth avviene via header/body — il path :token serve
 *   solo come "endpoint slug" non-secret.
 *
 *   Helper `deriveDefaultWebhookToken(workflowId)` esportato per consumo editor SPA.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { createHmac, createVerify, timingSafeEqual } from 'node:crypto';
import { WorkflowService } from '@/services/workflow.service.js';
import { RunService } from '@/services/run.service.js';
import type { IEventBus } from '@/ports/event-bus.js';
import { logger } from '@/lib/logger.js';
import { safeParseJson } from '@/lib/safe-parse-json.js';
import { resumeWait } from '@/executors/wait.js';
import { publishTestEvent } from '@/services/test-event-bus.service.js';
import { WEBHOOK_RESPONSE_KEY, type WebhookResponsePayload } from '@/executors/webhook-respond.js';
import { checkWebhookRateLimit, webhookIdempotencySeen, bodyHash } from '@/routes/webhook-guards.js';
import { verifyDefaultWebhookToken } from '@/lib/webhook-token.js';
import type { Workflow, CanvasNode } from '@medea/engine-core-schema';

/**
 * Substring match (not word-boundary) — most bot UAs include "bot" as part
 * of a compound token like "Googlebot", "Bingbot", "Twitterbot" where the
 * word boundary inside the identifier doesn't exist. False positives on
 * legitimate UAs containing these substrings (e.g. "robots") are accepted
 * since the toggle is opt-in for noise reduction, not security.
 */
const BOT_UA_PATTERN = /bot|crawler|spider|scrape|slurp|googlebot|bingbot|baiduspider|yandex|duckduckbot/iu;

/**
 * NodeConfig stores values as `string | undefined` after JSON round-trip
 * (form inputs render booleans as the strings "true"/"false"). This helper
 * normalizes both representations to a JS boolean.
 */
function asBool(v: unknown): boolean {
  return v === true || v === 'true';
}

/**
 * Verify a JWT in HS256/384/512 (HMAC) or RS/ES256/384/512 (asymmetric).
 * Returns true if the token is valid, the signature matches, and the
 * exp/iss/aud claims (when expected) pass.
 *
 * We intentionally implement this with node:crypto rather than pulling a
 * third-party JWT lib — the surface is small and we don't need every
 * algorithm in the JOSE spec.
 */
function verifyJwt(
  token: string,
  algo: string,
  secretOrKey: string,
  expectedIssuer: string,
  expectedAudience: string,
): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  const fromB64Url = (s: string): Buffer => {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    return Buffer.from(s.replace(/-/gu, '+').replace(/_/gu, '/') + pad, 'base64');
  };

  let header: { alg?: string };
  let payload: { iss?: string; aud?: string | string[]; exp?: number };
  try {
    header = JSON.parse(fromB64Url(headerB64).toString('utf8')) as { alg?: string };
    payload = JSON.parse(fromB64Url(payloadB64).toString('utf8')) as { iss?: string; aud?: string | string[]; exp?: number };
  } catch {
    return false;
  }

  // Pin the algorithm — never trust header.alg blindly (alg-confusion attack).
  if (header.alg !== algo) return false;

  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = fromB64Url(sigB64);

  let sigValid = false;
  if (algo.startsWith('HS')) {
    const expected = createHmac(algo.replace('HS', 'sha'), secretOrKey).update(signingInput).digest();
    // timingSafeEqual richiede length match → check esplicito prima.
    // Senza, l'oracle di lunghezza permette di restringere il search-space
    // dell'HMAC secret via tempi di risposta differenziali (Buffer.equals
    // ha short-circuit byte-per-byte non costante).
    sigValid = expected.length === signature.length && timingSafeEqual(expected, signature);
  } else if (algo.startsWith('RS') || algo.startsWith('ES')) {
    const hashAlgo = `RSA-SHA${algo.slice(2)}`;
    try {
      const verifier = createVerify(hashAlgo);
      verifier.update(signingInput);
      sigValid = verifier.verify(secretOrKey, signature);
    } catch {
      sigValid = false;
    }
  } else {
    return false;
  }
  if (!sigValid) return false;

  if (typeof payload.exp === 'number' && Date.now() / 1000 > payload.exp) return false;
  if (expectedIssuer && payload.iss !== expectedIssuer) return false;
  if (expectedAudience) {
    const aud = payload.aud;
    if (Array.isArray(aud)) {
      if (!aud.includes(expectedAudience)) return false;
    } else if (aud !== expectedAudience) {
      return false;
    }
  }
  return true;
}

function findWebhookNode(workflow: Workflow): CanvasNode | undefined {
  return workflow.nodes.find((n) => n.defId === 'trigger_webhook');
}

/**
 * Scan run steps in REVERSE order (last respond wins, normally the only
 * one in the pipeline) and return the structured response payload that
 * `action_webhook_respond` left in its step output. Returns undefined if
 * no such step ran — caller falls back to the default {runId, status} envelope.
 *
 * step.output e` JSON-stringified dal workflow-engine (CONTRACT documentato
 * in lib/safe-parse-json.ts). safeParseJson() ricompone l'object prima del
 * type-check. Pre-fix: `typeof output !== 'object'` continue sempre →
 * extractor undefined → utente riceveva JSON envelope invece dell'HTML del
 * nodo action_webhook_respond. Validato 2026-05-29 su flowforge standalone.
 *
 * Defensive: the engine returns `steps: unknown[]`; we type-narrow at
 * every access so a malformed step shape can never crash the HTTP reply.
 */
export function extractWebhookResponse(steps: unknown[]): WebhookResponsePayload | undefined {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (!step || typeof step !== 'object') continue;
    const output = safeParseJson((step as { output?: unknown }).output);
    if (!output || typeof output !== 'object') continue;
    const payload = (output as Record<string, unknown>)[WEBHOOK_RESPONSE_KEY];

    if (!payload || typeof payload !== 'object') continue;
    const p = payload as Record<string, unknown>;
    if (
      typeof p.status === 'number'
      && typeof p.contentType === 'string'
      && typeof p.body === 'string'
    ) {
      return {
        status: p.status,
        contentType: p.contentType,
        body: p.body,
        bodyIsBase64: p.bodyIsBase64 === true,
        headers: typeof p.headers === 'object' && p.headers !== null
          ? (p.headers as Record<string, string>)
          : {},
      };
    }
  }
  return undefined;
}

/**
 * Confronto a tempo costante via primitiva NATIVA `crypto.timingSafeEqual`
 * (garantita constant-time a livello macchina) invece di un loop XOR in JS, che
 * il JIT di V8 potrebbe ottimizzare in modi non realmente constant-time.
 * Il check di lunghezza è necessario (timingSafeEqual lancia su buffer di
 * lunghezza diversa) e non leaka segreti: la lunghezza di una firma HMAC/token
 * è pubblica e fissa.
 */
function constantTimeCompare(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function ipMatchesAllowlist(ip: string, allowlist: string): boolean {
  if (!allowlist.trim()) return true;
  const allowed = allowlist.split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) return true;
  for (const entry of allowed) {
    if (entry === ip) return true;
    if (entry.includes('/')) {
      const [base, bitsRaw] = entry.split('/');
      const bits = Number(bitsRaw);
      if (!base || !Number.isFinite(bits)) continue;
      if (ipv4InCidr(ip, base, bits)) return true;
    }
  }
  return false;
}

function ipv4InCidr(ip: string, baseIp: string, bits: number): boolean {
  const toInt = (s: string): number | null => {
    const parts = s.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
    return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
  };
  const a = toInt(ip);
  const b = toInt(baseIp);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

/**
 * AUDIT FIX WE-4 (2026-06-09 CRITICAL): LRU dedup signature webhook anti-replay.
 *
 * Globale al processo, scope per (nodeId, signature). TTL 10min. Cap 10k
 * entry (=~ 10k webhook req/10min, oltre = eviction). Sotto sostained DoS,
 * il caller può semplicemente aspettare 10min + replay → mitigation via
 * tolerance window + timestamp ±300s.
 */
const WEBHOOK_SIGNATURE_TTL_MS = 10 * 60 * 1000;
const WEBHOOK_SIGNATURE_CACHE_MAX = 10_000;
const webhookSignatureCache = new Map<string, number>(); // key → expiresAt ms

/**
 * Returns true se la signature è già stata vista nei ultimi 10min per quel
 * nodo (= replay attempt). False = prima volta → record + accept.
 * Esportato per test.
 */
export function webhookSignatureSeen(nodeId: string, signature: string): boolean {
  const key = `${nodeId}:${signature}`;
  const now = Date.now();
  // Eviction lazy: scan + remove expired su ogni call.
  for (const [k, exp] of webhookSignatureCache) {
    if (exp < now) webhookSignatureCache.delete(k);
  }
  const existing = webhookSignatureCache.get(key);
  if (existing !== undefined && existing > now) return true; // replay
  // Cap LRU: rimuovi entry più vecchia se cap raggiunto
  if (webhookSignatureCache.size >= WEBHOOK_SIGNATURE_CACHE_MAX) {
    const oldest = webhookSignatureCache.keys().next().value;
    if (oldest !== undefined) webhookSignatureCache.delete(oldest);
  }
  webhookSignatureCache.set(key, now + WEBHOOK_SIGNATURE_TTL_MS);
  return false;
}

/** Esportato SOLO per test. Reset cache fra test cases. */
export function __resetWebhookSignatureCache(): void {
  webhookSignatureCache.clear();
}

/**
 * Derivazione token di default estratta in `lib/webhook-token.ts` (SSOT,
 * condivisa con il resolver `ref://` e l'endpoint /workflows/:id/webhook-url).
 * Ri-esportata da qui per back-compat con i consumer esistenti.
 */
export { deriveDefaultWebhookToken } from '@/lib/webhook-token.js';

export function authorize(node: CanvasNode, headers: Record<string, string>, body: string, providedToken: string, remoteIp: string, workflowId: string): boolean {
  const mode = node.config.authMode ?? 'none';
  const secret = node.config.authSecret ?? '';
  const ipAllowlist = node.config.ipAllowlist ?? '';

  if (!ipMatchesAllowlist(remoteIp, ipAllowlist)) return false;

  if (mode === 'none') {
    // FIX HIGH security audit 2026-05-31: prima accettava chiunque conoscesse
    // il workflowId UUID. Adesso verifico che il path `:token` matchi il token
    // deterministico derivato da HMAC(workflowId, MEDEA_SSO_SECRET).
    // Grace window (rotazione secret): accetta anche token da
    // MEDEA_WEBHOOK_GRACE_SECRETS — loggato SEMPRE, finestra temporanea.
    const verdict = verifyDefaultWebhookToken(workflowId, providedToken);
    if (verdict.viaGraceSecret) {
      logger.warn(
        { workflowId },
        '[SECURITY] webhook token accettato via GRACE secret (rotazione in corso) — rigenera i link col token corrente e rimuovi MEDEA_WEBHOOK_GRACE_SECRETS a migrazione finita',
      );
    }
    return verdict.valid;
  }

  if (mode === 'header-token') {
    return constantTimeCompare(providedToken, secret);
  }

  if (mode === 'basic-auth') {
    const auth = headers.authorization ?? '';
    if (!auth.startsWith('Basic ')) return false;
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    // New shape: basicAuthUsername field + authSecret holds only the password.
    // Old shape (back-compat): authSecret holds the entire "user:pass" string.
    const username = typeof node.config.basicAuthUsername === 'string' ? node.config.basicAuthUsername : '';
    const expected = username ? `${username}:${secret}` : secret;
    return constantTimeCompare(decoded, expected);
  }

  if (mode === 'hmac-signature') {
    // New shape: hmacSecret + hmacHeader + hmacAlgo allow per-provider config.
    // Old shape (back-compat): authSecret + hardcoded x-flowforge-signature + sha256.
    const hmacSecret = typeof node.config.hmacSecret === 'string' && node.config.hmacSecret !== ''
      ? node.config.hmacSecret
      : secret;
    const headerName = typeof node.config.hmacHeader === 'string' && node.config.hmacHeader !== ''
      ? node.config.hmacHeader.toLowerCase()
      : 'x-flowforge-signature';
    const algo = typeof node.config.hmacAlgo === 'string' && ['sha256', 'sha1', 'sha512'].includes(node.config.hmacAlgo)
      ? node.config.hmacAlgo
      : 'sha256';
    let signature = headers[headerName] ?? '';
    // Provider quirks: GitHub uses "sha256=<hex>" format, strip the prefix.
    if (signature.startsWith(`${algo}=`)) signature = signature.slice(algo.length + 1);

    // AUDIT FIX WE-4 (2026-06-09 CRITICAL): replay protection.
    //
    // Pre-fix: HMAC su body solo → un signed POST captured = replay infinito
    // (un "crea ordine" webhook firmato può essere replicato N volte → N
    // ordini duplicati). Pattern industry (GitHub/Stripe/Slack/Linear):
    // include timestamp nel signed payload + reject se |now - ts| > 300s +
    // dedup recent signatures.
    //
    // Implementazione opt-in via config:
    //   hmacTimestampHeader: nome header con timestamp Unix (es. "x-stripe-timestamp")
    //   hmacTimestampToleranceSec: window ±N secondi (default 300)
    //   hmacSignedPayloadFormat: "ts.body" (Stripe-like, default) | "body" (GitHub-like)
    //
    // Quando timestamp header configurato:
    //   1. Reject se header mancante
    //   2. Reject se |now - ts| > tolerance
    //   3. HMAC verify su `${ts}.${body}` invece di `body`
    //   4. Dedup LRU global sulla signature (10min TTL) → anche con
    //      timestamp valid, signature duplicata = replay tentativo
    //
    // Quando timestamp header NON configurato → legacy mode (back-compat
    // GitHub-style) ma WARN log per security audit visibility.
    const tsHeaderName = typeof node.config.hmacTimestampHeader === 'string' && node.config.hmacTimestampHeader !== ''
      ? node.config.hmacTimestampHeader.toLowerCase()
      : '';
    if (tsHeaderName !== '') {
      const tsRaw = headers[tsHeaderName] ?? '';
      const ts = Number(tsRaw);
      if (!Number.isFinite(ts) || ts <= 0) return false;
      const tolerance = Number(node.config.hmacTimestampToleranceSec ?? 300);
      const nowSec = Math.floor(Date.now() / 1000);
      if (Math.abs(nowSec - ts) > tolerance) return false;
      // signed payload format: default "ts.body" (Stripe-like)
      const fmt = typeof node.config.hmacSignedPayloadFormat === 'string'
        ? node.config.hmacSignedPayloadFormat
        : 'ts.body';
      const signedBody = fmt === 'body' ? body : `${tsRaw}.${body}`;
      const expected = createHmac(algo, hmacSecret).update(signedBody).digest('hex');
      const sigValid = constantTimeCompare(signature, expected);
      if (!sigValid) return false;
      // Dedup LRU: signature già usata in ultimi 10min → replay tentativo
      if (webhookSignatureSeen(node.id, signature)) return false;
      return true;
    }

    // Legacy mode: signature su body solo. No replay protection.
    // Log security warning per visibility (Sentinel può alertare se >N/min).
    const expected = createHmac(algo, hmacSecret).update(body).digest('hex');
    const valid = constantTimeCompare(signature, expected);
    if (valid) {
      logger.warn(
        { workflowId, mode, headerName, algo },
        '[SECURITY WE-4] webhook HMAC accepted WITHOUT replay protection — set hmacTimestampHeader for production',
      );
    }
    return valid;
  }

  if (mode === 'jwt') {
    // Bearer token in Authorization header.
    const auth = headers.authorization ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!bearer) return false;
    const algo = typeof node.config.jwtAlgo === 'string' ? node.config.jwtAlgo : 'HS256';
    const key = typeof node.config.jwtSecret === 'string' ? node.config.jwtSecret : '';
    if (!key) return false;
    const iss = typeof node.config.jwtIssuer === 'string' ? node.config.jwtIssuer : '';
    const aud = typeof node.config.jwtAudience === 'string' ? node.config.jwtAudience : '';
    return verifyJwt(bearer, algo, key, iss, aud);
  }

  return false;
}

export function createWebhookRoutes(eventBus: IEventBus): Hono {
  const app = new Hono();
  const workflows = new WorkflowService(eventBus);
  const runs = new RunService(eventBus);

  /**
   * Build a CORS response header map from the node config. Applied to every
   * response (preflight + actual). Stays empty when corsOrigin isn't set.
   */
  function corsHeaders(node: CanvasNode): Record<string, string> {
    const origin = typeof node.config.corsOrigin === 'string' ? node.config.corsOrigin.trim() : '';
    if (!origin) return {};
    const out: Record<string, string> = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Tenant-Id, X-Webhook-Signature, Stripe-Signature, X-Hub-Signature-256, X-Shopify-Hmac-Sha256, X-Twilio-Signature, X-Webhook-Signature',
      'Access-Control-Max-Age': '86400',
    };
    if (asBool(node.config.corsAllowCredentials)) {
      out['Access-Control-Allow-Credentials'] = 'true';
    }
    return out;
  }

  /**
   * Core handler. Takes the resolved workflowId+token instead of pulling them
   * from c.req.param so we can share code between the default path and the
   * custom-path route without monkey-patching the Hono context.
   */
  async function runWebhook(c: Context, workflowId: string, token: string): Promise<Response> {
    if (!workflowId || !token) return c.json({ error: 'Bad request' }, 400);

    // Webhooks are PUBLIC routes — no JWT, no auth context. The auth is the
    // workflowId+token pair, verified below against the workflow's own
    // config. Cross-tenant lookup is therefore SAFE: a leaked token only
    // works for the workflow it was issued for, regardless of tenant.
    const workflow = await workflows.getByIdAnyTenant(workflowId);
    if (!workflow) return c.json({ error: 'Workflow not found' }, 404);
    if (!workflow.enabled) return c.json({ error: 'Workflow disabled' }, 409);
    const tenantId = workflow.tenantId ?? 'default';

    const node = findWebhookNode(workflow);
    if (!node) return c.json({ error: 'Workflow has no webhook trigger' }, 409);

    const cors = corsHeaders(node);

    // OPTIONS preflight: short-circuit before auth — browsers send no auth
    // headers on preflight, so requiring them here would block CORS entirely.
    if (c.req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Enforce configured method (default POST). 'ANY' = accept everything.
    const allowedMethod = typeof node.config.method === 'string' ? node.config.method.toUpperCase() : 'POST';
    if (allowedMethod !== 'ANY' && c.req.method !== allowedMethod) {
      return new Response(JSON.stringify({ error: `Method ${c.req.method} not allowed; expected ${allowedMethod}` }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', Allow: allowedMethod, ...cors },
      });
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.req.header())) {
      headers[k.toLowerCase()] = typeof v === 'string' ? v : String(v);
    }

    // Bot filter — checked AFTER OPTIONS but BEFORE doing any other work.
    if (asBool(node.config.ignoreBots)) {
      const ua = headers['user-agent'] ?? '';
      if (BOT_UA_PATTERN.test(ua)) {
        return new Response(JSON.stringify({ error: 'Bot user-agent rejected' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
    }

    const remoteIp = (c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? '').split(',')[0]?.trim() ?? '';

    // Rate-limit per-webhook (fixed window 1 min) — PRIMA di leggere il body, così un
    // flood viene respinto a costo ~0. Chiave per (nodeId, ip): un IP abusivo non
    // esaurisce la quota degli altri chiamanti. rateLimitPerMin<=0 = disabilitato.
    const rateLimitPerMin = Number(node.config.rateLimitPerMin ?? 0);
    const rate = checkWebhookRateLimit(`${node.id}:${remoteIp}`, rateLimitPerMin);
    if (!rate.allowed) {
      logger.warn({ workflowId, ip: remoteIp, limitPerMin: rateLimitPerMin }, 'Webhook rate-limited');
      return new Response(JSON.stringify({ error: 'Too Many Requests' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': String(rate.retryAfterSec), ...cors },
      });
    }

    const body = await c.req.text();

    if (!authorize(node, headers, body, token, remoteIp, workflowId)) {
      logger.warn({ workflowId, ip: remoteIp }, 'Webhook auth failed');
      const challengeHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...cors };
      // basic-auth: SENZA l'header WWW-Authenticate il browser non mostra il
      // popup di login nativo (vede solo il JSON {"error":"Unauthorized"}). Con
      // esso, il browser chiede user/password e ritenta con l'header Authorization.
      if ((node.config.authMode ?? 'none') === 'basic-auth') {
        challengeHeaders['WWW-Authenticate'] = 'Basic realm="FlowForge Webhook", charset="UTF-8"';
      }
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: challengeHeaders,
      });
    }

    // Audit on-hit: traccia ogni hit AUTORIZZATO con ip + method + digest del body
    // (SHA-256, non il payload in chiaro → niente PII nei log). Forensics + dedup-debug.
    const hitBodyHash = bodyHash(body);
    logger.info({ workflowId, nodeId: node.id, ip: remoteIp, method: c.req.method, bodyHash: hitBodyHash, bytes: body.length }, 'Webhook hit');

    // Idempotency-Key dedup (pattern Stripe): se il client manda lo stesso
    // Idempotency-Key entro il TTL, è un retry → NON rieseguiamo il workflow,
    // rispondiamo 200 {duplicate:true}. Header assente = nessuna idempotenza richiesta.
    const idempotencyKey = (headers['idempotency-key'] ?? '').trim();
    if (idempotencyKey !== '' && webhookIdempotencySeen(node.id, idempotencyKey)) {
      logger.info({ workflowId, nodeId: node.id, idempotencyKey }, 'Webhook duplicate Idempotency-Key — skip run');
      return new Response(JSON.stringify({ ok: true, duplicate: true, idempotencyKey }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }

    let parsedBody: unknown = body;
    try {
      parsedBody = JSON.parse(body);
    } catch {
      // keep raw text
    }

    const query = Object.fromEntries(new URL(c.req.url).searchParams.entries());

    // rawBody capture — surface the exact bytes received so downstream nodes
    // can rebuild HMAC signatures or feed raw payloads to external verifiers.
    const includeRawBody = asBool(node.config.rawBody);
    const triggerInput: { method: string; headers: Record<string, string>; body: unknown; query: Record<string, string>; rawBody?: string } = {
      method: c.req.method,
      headers,
      body: parsedBody,
      query,
    };
    if (includeRawBody) triggerInput.rawBody = body;

    publishTestEvent(tenantId, workflowId, triggerInput);

    // responseMode: 'immediate' returns 202 Accepted at once (best for noisy
    // providers like Stripe/Shopify that retry on > 10s). 'wait-for-workflow'
    // waits and returns an envelope shaped by responseShape. 'use-respond-node'
    // waits for the run AND falls through to scan for an action_webhook_respond
    // step output to build the actual response body.
    //
    // ⚠️ AUTO-PROMOTION: if the workflow CONTAINS an action_webhook_respond
    // node, we override 'immediate' → 'use-respond-node' transparently.
    // Otherwise the caller would get a 202 envelope and never see the body
    // the Respond node carefully built — Federico-reported bug: "vedo
    // success ma non funziona". Now: a Webhook→Respond pair just works,
    // no matter what the trigger has configured.
    const hasRespondNode = workflow.nodes.some((n) => n.defId === 'action_webhook_respond');
    const responseModeRaw = typeof node.config.responseMode === 'string' ? node.config.responseMode : 'immediate';
    let responseMode = ['immediate', 'wait-for-workflow', 'use-respond-node'].includes(responseModeRaw)
      ? responseModeRaw
      : 'immediate';
    if (hasRespondNode && responseMode === 'immediate') {
      logger.info({ workflowId }, 'Auto-promoting responseMode immediate→use-respond-node because workflow contains action_webhook_respond');
      responseMode = 'use-respond-node';
    }

    const runArgs = {
      workflowId,
      triggerType: 'webhook' as const,
      triggerInput,
      tenantId,
    };

    if (responseMode === 'immediate') {
      void runs.execute(runArgs)
        .then((r) => { logger.info({ runId: r.runId, status: r.status, workflowId }, 'Webhook fire-and-forget run completed'); })
        .catch((err: unknown) => { logger.error({ err, workflowId }, 'Webhook fire-and-forget run failed'); });
      return new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }

    const result = await runs.execute(runArgs);

    // Look for an `action_webhook_respond` step output. The executor returns
    // { __webhookResponse: { status, contentType, body, headers } } when it
    // runs; we scan ALL step outputs (last-write-wins if multiple respond
    // nodes exist — though normally there's just one at the end of the
    // pipeline). When found, shape the HTTP reply from it instead of the
    // generic {runId, status} envelope.
    const customResponse = extractWebhookResponse(result.steps);
    if (customResponse) {
      const responseHeaders: Record<string, string> = {
        'Content-Type': customResponse.contentType,
        'X-FlowForge-Run-Id': result.runId,
        ...cors,
        ...customResponse.headers,
      };
      // For 3xx / 204 we never want a Content-Type that implies a body.
      if (customResponse.status === 204 || customResponse.status === 304) {
        delete responseHeaders['Content-Type'];
      }
      // Binary mode: the executor stored the body as base64; decode to a
      // Buffer the Response constructor serializes as raw bytes.
      // 204 / 304 must have NO body.
      let bodyOut: string | Uint8Array | null = customResponse.body;
      if (customResponse.status === 204 || customResponse.status === 304) {
        bodyOut = null;
      } else if (customResponse.bodyIsBase64) {
        bodyOut = Buffer.from(customResponse.body, 'base64');
      }
      // Normalizza i byte a Uint8Array<ArrayBuffer> (via new Uint8Array) → body
      // valido sia con la lib DOM del typecheck locale sia con la lib Node della
      // build Docker, senza nominare BodyInit (assente in quest'ultima).
      const responseBody = typeof bodyOut === 'string' || bodyOut === null ? bodyOut : new Uint8Array(bodyOut);
      return new Response(responseBody, {
        status: customResponse.status,
        headers: responseHeaders,
      });
    }

    // Default envelope shape — driven by responseShape (envelope|last-step-output|all-steps-output).
    // step.output e` JSON-stringified dal workflow-engine: safeParseJson()
    // ricompone l'object prima del JSON.stringify finale, altrimenti il
    // client riceveva la stringa nidificata escaped invece dell'object.
    const shape = typeof node.config.responseShape === 'string' ? node.config.responseShape : 'envelope';
    let envelopeBody: unknown;
    if (shape === 'last-step-output') {
      const last = result.steps[result.steps.length - 1] as { output?: unknown } | undefined;
      envelopeBody = safeParseJson(last?.output);
    } else if (shape === 'all-steps-output') {
      envelopeBody = (result.steps as { output?: unknown }[]).map((s) => safeParseJson(s.output));
    } else {
      envelopeBody = { runId: result.runId, status: result.status };
    }
    return new Response(JSON.stringify(envelopeBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-FlowForge-Run-Id': result.runId, ...cors },
    });
  }

  // Adapter to plug runWebhook into Hono route handlers.
  const defaultPathHandler = (c: Context): Promise<Response> =>
    runWebhook(c, c.req.param('workflowId') ?? '', c.req.param('token') ?? '');

  // Default path: /webhooks/:workflowId/:token (POST/PUT/GET/PATCH/DELETE/OPTIONS/HEAD)
  for (const m of ['post', 'put', 'get', 'patch', 'delete', 'options'] as const) {
    app[m]('/:workflowId/:token', defaultPathHandler);
  }
  app.on('HEAD', '/:workflowId/:token', defaultPathHandler);

  /**
   * Custom-path routes: /webhooks/c/<...customPath>/<token>
   * The customPath may contain slashes (e.g. /webhooks/c/orders/v2/<token>).
   *
   * We avoid Hono's regex-constrained params (which had unreliable greedy
   * behavior with slash-containing captures) and parse manually: the LAST
   * segment is the token, everything in between is the customPath.
   *
   * Resolves the workflow by scanning tenant workflows for a trigger_webhook
   * node with a matching `customPath` config. Same runWebhook() pipeline as
   * the default route — single source of truth.
   */
  const customPathHandler = async (c: Context): Promise<Response> => {
    const url = new URL(c.req.url);
    // Strip mount prefix ("/webhooks") if Hono mounted us under one, plus the leading "/c/"
    const afterC = url.pathname.replace(/^.*\/c\//u, '');
    const segments = afterC.split('/').filter((s) => s !== '');
    if (segments.length < 2) return c.json({ error: 'Bad request' }, 400);
    const rawToken = segments[segments.length - 1]!;
    const customPath = segments.slice(0, -1).join('/');
    if (!customPath || !rawToken) return c.json({ error: 'Bad request' }, 400);

    // HLS extension hint (2026-06-06 BUG #137):
    //   HLS-capable clients (VLC, ffmpeg) inspect the LAST URL path segment
    //   for an extension that signals the response media type, even when the
    //   Content-Type response header is set correctly. If the last segment
    //   carries no extension (es. a raw token), ffmpeg rejects sub-playlist
    //   children with `is not in allowed_segment_extensions`, breaking
    //   playback. Solution: allow the rewriter (stream_proxy) to append
    //   `.m3u8` / `.ts` / `.vtt` / `.key` to the token; strip it here before
    //   matching the workflow's token secret so authentication is unchanged.
    //   Old clients sending the bare token still match — back-compat preserved.
    const HLS_HINT = /\.(?:m3u8|m3u|ts|vtt|key|mp4|m4s|aac|webvtt)$/iu;
    const token = rawToken.replace(HLS_HINT, '');

    // Public route: scan across all tenants. Token-based auth on the matched
    // workflow itself prevents impersonation between tenants.
    const matches = await workflows.listByCustomWebhookPathAnyTenant(customPath);
    if (matches.length === 0) return c.json({ error: 'No webhook for that custom path' }, 404);
    if (matches.length > 1) {
      logger.warn({ customPath, count: matches.length }, 'Multiple webhooks share the same customPath — using the first');
    }
    return runWebhook(c, matches[0]!.id, token);
  };
  app.all('/c/*', customPathHandler);

  /**
   * Wait/resume endpoint — paired with the wait executor's webhook mode.
   * POST /webhooks/wait/:token with any JSON body resumes the paused workflow.
   * The body becomes the wait node's `payload` output.
   */
  app.post('/wait/:token', async (c) => {
    const token = c.req.param('token');
    if (!token) return c.json({ error: 'Bad request' }, 400);
    let body: unknown = null;
    try {
      const text = await c.req.text();
      if (text) body = JSON.parse(text);
    } catch {
      body = await c.req.text();
    }
    const resumed = resumeWait(token, body);
    if (!resumed) return c.json({ error: 'Token not found or already completed' }, 404);
    return c.json({ ok: true, token });
  });

  return app;
}
