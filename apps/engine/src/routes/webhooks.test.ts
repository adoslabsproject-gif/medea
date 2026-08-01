/**
 * Webhook router contract tests — exercises the new v2.0 surface end-to-end:
 *   • Method enforcement (405 when method ≠ configured)
 *   • OPTIONS preflight (204 + CORS headers, no auth)
 *   • Bot user-agent rejection
 *   • JWT auth (HS256 valid + invalid sig + wrong issuer)
 *   • Raw body capture in triggerInput
 *   • Custom path resolution via /webhooks/c/<path>/<token>
 *   • responseShape envelope variants
 *   • CORS headers on every response
 *
 * Tests run against an in-memory webhook router with stubbed
 * WorkflowService + RunService — no Drizzle, no DB, no event bus.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';

// FIX HIGH-1 security audit 2026-05-31: authMode='none' ora richiede
// :token URL = HMAC-SHA256(workflowId, FLOWFORGE_SSO_SECRET). I test che
// usavano `/wf-1/${TOK}` devono usare il token derivato.
process.env.FLOWFORGE_SSO_SECRET = process.env.FLOWFORGE_SSO_SECRET ?? 'test-sso-secret-32-chars-long-min!!';

import { createWebhookRoutes, extractWebhookResponse, deriveDefaultWebhookToken } from './webhooks.js';

// Token derivato per workflowId 'wf-1' (deterministico, calcolato all'import).
const TOK = deriveDefaultWebhookToken('wf-1');
import type { IEventBus } from '@/ports/event-bus.js';
import { WorkflowService } from '@/services/workflow.service.js';
import { RunService } from '@/services/run.service.js';
import { WEBHOOK_RESPONSE_KEY } from '@/executors/webhook-respond.js';
import { __resetWebhookRateLimit, __resetWebhookIdempotency } from './webhook-guards.js';

const eventBus: IEventBus = {
  emit: vi.fn(),
  on: vi.fn(),
} as unknown as IEventBus;

function makeWorkflow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'wf-1',
    tenantId: 'default',
    name: 'Test',
    enabled: true,
    nodes: [
      {
        id: 'webhook-1',
        defId: 'trigger_webhook',
        config: { method: 'POST', authMode: 'none', ...overrides },
        x: 0, y: 0,
      },
    ],
    edges: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

let workflowGet: ReturnType<typeof vi.fn>;
let workflowGetAnyTenant: ReturnType<typeof vi.fn>;
let workflowListByCustomPath: ReturnType<typeof vi.fn>;
let workflowListByCustomPathAnyTenant: ReturnType<typeof vi.fn>;
let runExecute: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // After the public-routes refactor (webhooks/forms no longer require JWT),
  // the webhook router calls getByIdAnyTenant() / listByCustomWebhookPathAnyTenant()
  // for cross-tenant lookup (token validates auth, not JWT). Keep the
  // old mocks for any non-webhook code path that still uses get().
  workflowGet = vi.fn(async (id: string, _t: string) => id === 'wf-1' ? makeWorkflow() : null);
  workflowGetAnyTenant = vi.fn(async (id: string) => id === 'wf-1' ? makeWorkflow() : null);
  workflowListByCustomPath = vi.fn(async (_t: string, _p: string) => [] as unknown[]);
  workflowListByCustomPathAnyTenant = vi.fn(async (_p: string) => [] as unknown[]);
  runExecute = vi.fn(async () => ({ runId: 'r-1', status: 'completed', steps: [] }));

  vi.spyOn(WorkflowService.prototype, 'get').mockImplementation(workflowGet as never);
  vi.spyOn(WorkflowService.prototype, 'getByIdAnyTenant').mockImplementation(workflowGetAnyTenant as never);
  vi.spyOn(WorkflowService.prototype, 'listByCustomWebhookPath').mockImplementation(workflowListByCustomPath as never);
  vi.spyOn(WorkflowService.prototype, 'listByCustomWebhookPathAnyTenant').mockImplementation(workflowListByCustomPathAnyTenant as never);
  vi.spyOn(RunService.prototype, 'execute').mockImplementation(runExecute as never);
});

function makeApp() {
  return createWebhookRoutes(eventBus);
}

describe('webhook router — grace window rotazione secret (authMode none)', () => {
  const OLD_SECRET = 'old-rotated-secret-abcdefghij-0123456789';
  const NEW_SECRET = 'new-current-secret-abcdefghij-9876543210';
  let ssoBackup: string | undefined;
  let graceBackup: string | undefined;

  beforeEach(() => {
    ssoBackup = process.env.FLOWFORGE_SSO_SECRET;
    graceBackup = process.env.FLOWFORGE_WEBHOOK_GRACE_SECRETS;
    delete process.env.FLOWFORGE_WEBHOOK_GRACE_SECRETS;
  });

  afterEach(() => {
    if (ssoBackup === undefined) delete process.env.FLOWFORGE_SSO_SECRET;
    else process.env.FLOWFORGE_SSO_SECRET = ssoBackup;
    if (graceBackup === undefined) delete process.env.FLOWFORGE_WEBHOOK_GRACE_SECRETS;
    else process.env.FLOWFORGE_WEBHOOK_GRACE_SECRETS = graceBackup;
  });

  const oldToken = () => createHmac('sha256', OLD_SECRET).update('webhook:wf-1').digest('hex').slice(0, 32);
  const newToken = () => createHmac('sha256', NEW_SECRET).update('webhook:wf-1').digest('hex').slice(0, 32);

  it('ANTI-REGRESSIONE (il bug Streammy): dopo rotazione, il token cablato vecchio dà 401 senza grace', async () => {
    process.env.FLOWFORGE_SSO_SECRET = NEW_SECRET;
    const res = await makeApp().request(`/wf-1/${oldToken()}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('GRACE: con FLOWFORGE_WEBHOOK_GRACE_SECRETS il token del secret precedente passa', async () => {
    process.env.FLOWFORGE_SSO_SECRET = NEW_SECRET;
    process.env.FLOWFORGE_WEBHOOK_GRACE_SECRETS = OLD_SECRET;
    const res = await makeApp().request(`/wf-1/${oldToken()}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(202);
    // Il token CORRENTE resta il canale principale.
    const res2 = await makeApp().request(`/wf-1/${newToken()}`, { method: 'POST', body: '{}' });
    expect(res2.status).toBe(202);
  });

  it('la grace NON apre un buco: token inventato resta 401 anche con grace attiva', async () => {
    process.env.FLOWFORGE_SSO_SECRET = NEW_SECRET;
    process.env.FLOWFORGE_WEBHOOK_GRACE_SECRETS = OLD_SECRET;
    const res = await makeApp().request(`/wf-1/${'f'.repeat(32)}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });
});

describe('webhook router — method enforcement', () => {
  it('rejects method != configured with 405', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ method: 'POST' }));
    const res = await makeApp().request(`/wf-1/${TOK}`, { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
  });

  it('accepts the configured method', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ method: 'GET' }));
    const res = await makeApp().request(`/wf-1/${TOK}`, { method: 'GET' });
    expect(res.status).toBe(202);
  });

  it('ANY accepts everything', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ method: 'ANY' }));
    const res1 = await makeApp().request(`/wf-1/${TOK}`, { method: 'PATCH' });
    expect(res1.status).toBe(202);
  });
});

describe('webhook router — CORS', () => {
  it('OPTIONS preflight returns 204 with CORS headers, no auth check', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({
      authMode: 'header-token',
      authSecret: 'should-not-be-checked',
      corsOrigin: 'https://app.example.com',
    }));
    const res = await makeApp().request(`/wf-1/${TOK}`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('attaches CORS headers to actual response when corsOrigin set', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ corsOrigin: '*' }));
    const res = await makeApp().request(`/wf-1/${TOK}`, { method: 'POST', body: '{}' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('CORS Allow-Credentials toggled by config', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ corsOrigin: 'https://x.com', corsAllowCredentials: 'true' }));
    const res = await makeApp().request(`/wf-1/${TOK}`, { method: 'POST', body: '{}' });
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });
});

describe('webhook router — bot filter', () => {
  it('rejects bot UA when ignoreBots=true', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ ignoreBots: 'true' }));
    const res = await makeApp().request(`/wf-1/${TOK}`, {
      method: 'POST',
      headers: { 'User-Agent': 'Googlebot/2.1' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('allows non-bot UA', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ ignoreBots: 'true' }));
    const res = await makeApp().request(`/wf-1/${TOK}`, {
      method: 'POST',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      body: '{}',
    });
    expect(res.status).toBe(202);
  });
});

describe('webhook router — basic-auth challenge (popup browser)', () => {
  const creds = (u: string, p: string): string => Buffer.from(`${u}:${p}`).toString('base64');

  it('🔒 basic-auth fallita (no credenziali) → 401 CON WWW-Authenticate → il browser mostra il popup', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ authMode: 'basic-auth', basicAuthUsername: 'nico', authSecret: 'segreto' }));
    const res = await makeApp().request(`/wf-1/${TOK}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Basic realm=/);
  });

  it('basic-auth corretta (user:pass) → accettata (non 401)', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ authMode: 'basic-auth', basicAuthUsername: 'nico', authSecret: 'segreto' }));
    const res = await makeApp().request(`/wf-1/${TOK}`, {
      method: 'POST', body: '{}',
      headers: { Authorization: `Basic ${creds('nico', 'segreto')}` },
    });
    expect(res.status).not.toBe(401);
  });

  it('basic-auth password ERRATA → 401 CON WWW-Authenticate (richiede di nuovo)', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ authMode: 'basic-auth', basicAuthUsername: 'nico', authSecret: 'segreto' }));
    const res = await makeApp().request(`/wf-1/${TOK}`, {
      method: 'POST', body: '{}',
      headers: { Authorization: `Basic ${creds('nico', 'WRONG')}` },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Basic realm=/);
  });

  it('🔒 ANTI-REGRESSIONE: altra modalità (jwt) fallita → 401 SENZA WWW-Authenticate (niente popup spurio)', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ authMode: 'jwt', jwtSecret: 'x', jwtAlgo: 'HS256' }));
    const res = await makeApp().request(`/wf-1/${TOK}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });
});

describe('webhook router — JWT auth', () => {
  function makeJwt(payload: Record<string, unknown>, secret: string, algo = 'HS256'): string {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const header = enc({ alg: algo, typ: 'JWT' });
    const body = enc(payload);
    const signature = createHmac(algo.replace('HS', 'sha'), secret).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${signature}`;
  }

  it('accepts valid HS256 token', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ authMode: 'jwt', jwtSecret: 'shhh', jwtAlgo: 'HS256' }));
    const tok = makeJwt({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 60 }, 'shhh');
    const res = await makeApp().request(`/wf-1/${TOK}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}` },
      body: '{}',
    });
    expect(res.status).toBe(202);
  });

  it('rejects invalid signature', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ authMode: 'jwt', jwtSecret: 'shhh', jwtAlgo: 'HS256' }));
    const tok = makeJwt({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 60 }, 'wrong-secret');
    const res = await makeApp().request(`/wf-1/${TOK}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}` },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('rejects signature SAME length but DIFFERENT bytes (timingSafeEqual regression #194 C4)', async () => {
    // Verifica che il fix `Buffer.equals` → `crypto.timingSafeEqual` non
    // abbia regressione: signature stessa lunghezza dell'expected ma byte
    // diversi DEVE essere rigettata (e in modo timing-safe, ma quello e`
    // best-effort: qui verifichiamo solo correctness, non timing).
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ authMode: 'jwt', jwtSecret: 'shhh', jwtAlgo: 'HS256' }));
    // Costruiamo manualmente JWT con signature di lunghezza HS256 (32 bytes)
    // ma valori sbagliati — same length della firma corretta.
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
    const fakeSig = Buffer.alloc(32, 0xff).toString('base64url');     // 32 byte di 0xff
    const tok = `${header}.${payload}.${fakeSig}`;
    const res = await makeApp().request(`/wf-1/${TOK}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}` },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('rejects when issuer mismatch', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({
      authMode: 'jwt',
      jwtSecret: 'shhh',
      jwtAlgo: 'HS256',
      jwtIssuer: 'https://expected.example.com/',
    }));
    const tok = makeJwt({ iss: 'https://attacker.com/', exp: Math.floor(Date.now() / 1000) + 60 }, 'shhh');
    const res = await makeApp().request(`/wf-1/${TOK}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}` },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('rejects expired token', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ authMode: 'jwt', jwtSecret: 'shhh', jwtAlgo: 'HS256' }));
    const tok = makeJwt({ exp: Math.floor(Date.now() / 1000) - 10 }, 'shhh');
    const res = await makeApp().request(`/wf-1/${TOK}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}` },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
});

describe('webhook router — rawBody capture', () => {
  it('includes rawBody in triggerInput when enabled', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ rawBody: 'true', responseMode: 'wait-for-workflow' }));
    runExecute.mockResolvedValue({ runId: 'r-2', status: 'completed', steps: [] });
    await makeApp().request(`/wf-1/${TOK}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"hello":"world"}',
    });
    expect(runExecute).toHaveBeenCalledTimes(1);
    const args = runExecute.mock.calls[0]![0] as { triggerInput: { rawBody?: string; body: unknown } };
    expect(args.triggerInput.rawBody).toBe('{"hello":"world"}');
    expect(args.triggerInput.body).toEqual({ hello: 'world' });
  });

  it('omits rawBody when not enabled', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ responseMode: 'wait-for-workflow' }));
    runExecute.mockResolvedValue({ runId: 'r-3', status: 'completed', steps: [] });
    await makeApp().request(`/wf-1/${TOK}`, { method: 'POST', body: '{}' });
    const args = runExecute.mock.calls[0]![0] as { triggerInput: { rawBody?: string } };
    expect(args.triggerInput.rawBody).toBeUndefined();
  });
});

describe('webhook router — custom path', () => {
  it('resolves /c/<path>/<token> via listByCustomWebhookPath', async () => {
    workflowListByCustomPathAnyTenant.mockResolvedValue([makeWorkflow({ customPath: 'tesi' })]);
    runExecute.mockResolvedValue({ runId: 'r-c', status: 'completed', steps: [] });
    const res = await makeApp().request(`/c/tesi/${TOK}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(202);
    // Public route — cross-tenant lookup. Path is the only argument.
    expect(workflowListByCustomPathAnyTenant).toHaveBeenCalledWith('tesi');
  });

  it('returns 404 when no workflow matches the custom path', async () => {
    workflowListByCustomPathAnyTenant.mockResolvedValue([]);
    const res = await makeApp().request(`/c/nonexistent/${TOK}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('supports nested custom paths like /c/orders/v2/tok', async () => {
    workflowListByCustomPathAnyTenant.mockResolvedValue([makeWorkflow({ customPath: 'orders/v2' })]);
    const res = await makeApp().request(`/c/orders/v2/${TOK}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(202);
    expect(workflowListByCustomPathAnyTenant).toHaveBeenCalledWith('orders/v2');
  });
});

describe('webhook router — responseShape envelope', () => {
  it('envelope (default) returns {runId, status}', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ responseMode: 'wait-for-workflow' }));
    runExecute.mockResolvedValue({
      runId: 'r-e',
      status: 'completed',
      steps: [{ output: { hello: 'world' } }, { output: 42 }],
    });
    const res = await makeApp().request(`/wf-1/${TOK}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    const body = await res.json() as { runId: string; status: string };
    expect(body).toEqual({ runId: 'r-e', status: 'completed' });
  });

  it('last-step-output returns the final step\'s output', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({
      responseMode: 'wait-for-workflow',
      responseShape: 'last-step-output',
    }));
    runExecute.mockResolvedValue({
      runId: 'r-l',
      status: 'completed',
      steps: [{ output: { hello: 'world' } }, { output: { final: true, n: 5 } }],
    });
    const res = await makeApp().request(`/wf-1/${TOK}`, { method: 'POST', body: '{}' });
    const body = await res.json();
    expect(body).toEqual({ final: true, n: 5 });
  });

  it('all-steps-output returns the full array', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({
      responseMode: 'wait-for-workflow',
      responseShape: 'all-steps-output',
    }));
    runExecute.mockResolvedValue({
      runId: 'r-a',
      status: 'completed',
      steps: [{ output: 'a' }, { output: 'b' }, { output: 'c' }],
    });
    const res = await makeApp().request(`/wf-1/${TOK}`, { method: 'POST', body: '{}' });
    const body = await res.json();
    expect(body).toEqual(['a', 'b', 'c']);
  });
});

/**
 * Regression suite — 2026-05-29: il workflow-engine serializza step.output
 * via safeStringify (JSON.stringify) per il DB write. Pre-fix
 * extractWebhookResponse + responseShape (last/all) vedevano la stringa,
 * fallivano il check object e l'utente riceveva envelope {runId,status} o
 * stringa JSON escaped invece di HTML/object. Validato anche su flowforge
 * standalone (nha) lo stesso giorno.
 */
describe('extractWebhookResponse — regression workflow-engine safeStringify', () => {
  const validPayload = {
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<h1>Hello</h1>',
    bodyIsBase64: false,
    headers: { 'X-Custom': '1' },
  };

  it('estrae payload quando step.output e` OGGETTO JS', () => {
    const steps = [{ output: { [WEBHOOK_RESPONSE_KEY]: validPayload } }];
    expect(extractWebhookResponse(steps)).toEqual(validPayload);
  });

  it('estrae payload quando step.output e` STRINGA JSON (caso real engine)', () => {
    const steps = [{ output: JSON.stringify({ [WEBHOOK_RESPONSE_KEY]: validPayload }) }];
    expect(extractWebhookResponse(steps)).toEqual(validPayload);
  });

  it('skippa silenzioso se la stringa non e` JSON valido', () => {
    const steps = [{ output: 'garbage{' }];
    expect(extractWebhookResponse(steps)).toBeUndefined();
  });

  it('itera dalla coda alla testa: usa l\'ULTIMO respond se ce ne sono 2', () => {
    const first = { ...validPayload, body: '<h1>First</h1>' };
    const last = { ...validPayload, body: '<h1>Last</h1>' };
    const steps = [
      { output: JSON.stringify({ [WEBHOOK_RESPONSE_KEY]: first }) },
      { output: JSON.stringify({ [WEBHOOK_RESPONSE_KEY]: last }) },
    ];
    expect(extractWebhookResponse(steps)?.body).toBe('<h1>Last</h1>');
  });

  it('ignora step senza __webhookResponse', () => {
    const steps = [
      { output: JSON.stringify({ foo: 'bar' }) },
      { output: JSON.stringify({ [WEBHOOK_RESPONSE_KEY]: validPayload }) },
    ];
    expect(extractWebhookResponse(steps)?.body).toBe(validPayload.body);
  });

  it('valida schema: scarta payload con field type sbagliati', () => {
    const bad = { [WEBHOOK_RESPONSE_KEY]: { status: 'not-a-number', contentType: 'x', body: 'y' } };
    expect(extractWebhookResponse([{ output: bad }])).toBeUndefined();
  });

  it('manage steps non-object e null safely', () => {
    expect(extractWebhookResponse([null, undefined, 'string', 42])).toBeUndefined();
  });

  it('manage output null o non-string-non-object', () => {
    expect(extractWebhookResponse([{ output: null }])).toBeUndefined();
    expect(extractWebhookResponse([{ output: 42 }])).toBeUndefined();
  });
});

describe('webhook router — responseShape su STRINGA JSON (regression engine safeStringify)', () => {
  it('last-step-output deserializza step.output stringa → object', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({
      responseMode: 'wait-for-workflow',
      responseShape: 'last-step-output',
    }));
    // Replica EXACT format engine: step.output e` la stringa JSON
    const finalOutput = { emails: [{ email: 'info@test.it' }], primary_email: 'info@test.it' };
    runExecute.mockResolvedValue({
      runId: 'r-stringified',
      status: 'completed',
      steps: [
        { output: JSON.stringify({ intermediate: true }) },
        { output: JSON.stringify(finalOutput) },
      ],
    });
    const res = await makeApp().request(`/wf-1/${TOK}`, { method: 'POST', body: '{}' });
    const body = await res.json();
    expect(body).toEqual(finalOutput);
    // Bug pre-fix avrebbe ritornato stringa nidificata escaped come testo
    expect(typeof body).toBe('object');
  });

  it('all-steps-output deserializza ogni step.output stringa → array di object', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({
      responseMode: 'wait-for-workflow',
      responseShape: 'all-steps-output',
    }));
    runExecute.mockResolvedValue({
      runId: 'r-stringified-all',
      status: 'completed',
      steps: [
        { output: JSON.stringify({ a: 1 }) },
        { output: JSON.stringify({ b: 2 }) },
        { output: JSON.stringify({ c: 3 }) },
      ],
    });
    const res = await makeApp().request(`/wf-1/${TOK}`, { method: 'POST', body: '{}' });
    const body = await res.json();
    expect(body).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it('last-step-output con stringa non-JSON resta stringa (no crash)', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({
      responseMode: 'wait-for-workflow',
      responseShape: 'last-step-output',
    }));
    runExecute.mockResolvedValue({
      runId: 'r-broken-json',
      status: 'completed',
      steps: [{ output: 'plain text not json' }],
    });
    const res = await makeApp().request(`/wf-1/${TOK}`, { method: 'POST', body: '{}' });
    const body = await res.json();
    expect(body).toBe('plain text not json');
  });

  it('extractWebhookResponse via richiesta HTTP: webhook→respond HTML restituito correttamente', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ responseMode: 'wait-for-workflow' }));
    runExecute.mockResolvedValue({
      runId: 'r-html',
      status: 'completed',
      steps: [{
        output: JSON.stringify({
          [WEBHOOK_RESPONSE_KEY]: {
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: '<!DOCTYPE html><html><body><h1>Hi</h1></body></html>',
            bodyIsBase64: false,
            headers: {},
          },
        }),
      }],
    });
    const res = await makeApp().request(`/wf-1/${TOK}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    const text = await res.text();
    expect(text).toContain('<h1>Hi</h1>');
  });
});

describe('webhook router — rate-limit per-nodo (rateLimitPerMin)', () => {
  beforeEach(() => { __resetWebhookRateLimit(); });

  it('🚨 oltre rateLimitPerMin per lo stesso IP → 429 + Retry-After', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ rateLimitPerMin: 2 }));
    const app = makeApp();
    const hit = () => app.request(`/wf-1/${TOK}`, {
      method: 'POST', body: '{}', headers: { 'x-forwarded-for': '9.9.9.9' },
    });
    expect((await hit()).status).toBe(202);
    expect((await hit()).status).toBe(202);
    const blocked = await hit();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('🚨 IP diversi NON condividono la quota', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ rateLimitPerMin: 1 }));
    const app = makeApp();
    expect((await app.request(`/wf-1/${TOK}`, { method: 'POST', body: '{}', headers: { 'x-forwarded-for': '1.1.1.1' } })).status).toBe(202);
    expect((await app.request(`/wf-1/${TOK}`, { method: 'POST', body: '{}', headers: { 'x-forwarded-for': '1.1.1.1' } })).status).toBe(429);
    expect((await app.request(`/wf-1/${TOK}`, { method: 'POST', body: '{}', headers: { 'x-forwarded-for': '2.2.2.2' } })).status).toBe(202);
  });

  it('rateLimitPerMin=0 (default) → nessun limite', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ rateLimitPerMin: 0 }));
    const app = makeApp();
    for (let i = 0; i < 5; i += 1) {
      expect((await app.request(`/wf-1/${TOK}`, { method: 'POST', body: '{}', headers: { 'x-forwarded-for': '3.3.3.3' } })).status).toBe(202);
    }
  });
});

describe('webhook router — dedup Idempotency-Key', () => {
  beforeEach(() => { __resetWebhookIdempotency(); });

  it('🚨 stesso Idempotency-Key → 2ª request 200 {duplicate:true} e workflow NON rieseguito', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow());
    const app = makeApp();
    const first = await app.request(`/wf-1/${TOK}`, { method: 'POST', body: '{}', headers: { 'idempotency-key': 'abc-123' } });
    expect(first.status).toBe(202);
    const second = await app.request(`/wf-1/${TOK}`, { method: 'POST', body: '{}', headers: { 'idempotency-key': 'abc-123' } });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, duplicate: true, idempotencyKey: 'abc-123' });
    // immediate responseMode esegue async: runExecute parte 1 sola volta (la 2ª è dedup-skippata).
    expect(runExecute).toHaveBeenCalledTimes(1);
  });

  it('Idempotency-Key diversi → entrambi eseguiti (nessun falso-duplicato)', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow());
    const app = makeApp();
    expect((await app.request(`/wf-1/${TOK}`, { method: 'POST', body: '{}', headers: { 'idempotency-key': 'k1' } })).status).toBe(202);
    expect((await app.request(`/wf-1/${TOK}`, { method: 'POST', body: '{}', headers: { 'idempotency-key': 'k2' } })).status).toBe(202);
  });
});
