/**
 * Test 2026-grade — client-errors sink (PUBLIC, no auth).
 *
 * 🚨 F1 FIX (2026-06-10): il `tenantId` loggato viene dall'env del container
 *    (getContainerTenantId), NON dall'header `x-tenant-id` controllato dal
 *    client. Pre-fix un attaccante poteva attribuire log-spoof a un altro
 *    tenant inviando l'header.
 *
 * 🚨 ROBUSTEZZA: body non-JSON / mancante → 200 graceful (non deve mai 500 su
 *    un sink di error-reporting, altrimenti l'editor entra in loop di errori).
 *
 * 🚨 SANITIZE: campi non-string → null; stack troncato a 1000 char (no log
 *    flooding / no leak di payload enormi nei file di log).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger.js';

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

const tenantMock = vi.hoisted(() => ({ container: 'default' }));
vi.mock('@/lib/tenant.js', () => ({
  getContainerTenantId: () => tenantMock.container,
}));

const { createClientErrorsRoutes } = await import('./client-errors.js');

/** Estrae il primo argomento (oggetto strutturato) dell'ultima logger.warn. */
function lastWarnFields(): Record<string, unknown> {
  const calls = loggerMock.warn.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  tenantMock.container = 'default';
});

describe('🚨 POST /client-errors — tenant da env, mai header', () => {
  it("🚨 logga il tenant del container (env), non l'header", async () => {
    tenantMock.container = 'real-tenant-uuid';
    const app = createClientErrorsRoutes();
    const res = await app.request('/client-errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': 'attacker-tenant' },
      body: JSON.stringify({ message: 'boom' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ logged: true });
    const fields = lastWarnFields();
    expect(fields.tenantId).toBe('real-tenant-uuid');
    expect(fields.tenantId).not.toBe('attacker-tenant');
  });

  it('🚨 SPOOF: anche con header e env="default", vince l\'env', async () => {
    tenantMock.container = 'default';
    const app = createClientErrorsRoutes();
    await app.request('/client-errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': 'evil' },
      body: JSON.stringify({ message: 'x' }),
    });
    expect(lastWarnFields().tenantId).toBe('default');
  });
});

describe('🚨 robustezza body', () => {
  it('🚨 body non-JSON → 200 graceful (nessun 500 sul sink)', async () => {
    const app = createClientErrorsRoutes();
    const res = await app.request('/client-errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json{{{',
    });
    expect(res.status).toBe(200);
    const fields = lastWarnFields();
    // Tutti i campi opzionali → null, ma il log avviene comunque.
    expect(fields.message).toBeNull();
    expect(fields.clientError).toBe(true);
  });

  it('🚨 body completamente assente → 200', async () => {
    const app = createClientErrorsRoutes();
    const res = await app.request('/client-errors', { method: 'POST' });
    expect(res.status).toBe(200);
  });
});

describe('🚨 sanitizzazione campi', () => {
  it('🚨 campi non-string → null (no injection di tipi arbitrari nel log)', async () => {
    const app = createClientErrorsRoutes();
    await app.request('/client-errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: { evil: 'object' },
        source: 42,
        stack: ['array'],
        url: null,
        userAgent: true,
      }),
    });
    const fields = lastWarnFields();
    expect(fields.message).toBeNull();
    expect(fields.source).toBeNull();
    expect(fields.stack).toBeNull();
    expect(fields.url).toBeNull();
    expect(fields.userAgent).toBeNull();
  });

  it('🚨 stack troncato a 1000 char (anti log-flooding)', async () => {
    const app = createClientErrorsRoutes();
    const hugeStack = 'A'.repeat(5000);
    await app.request('/client-errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'm', stack: hugeStack }),
    });
    const fields = lastWarnFields();
    expect(typeof fields.stack).toBe('string');
    expect((fields.stack as string).length).toBe(1000);
  });

  it('🚨 campi string validi passano intatti', async () => {
    const app = createClientErrorsRoutes();
    await app.request('/client-errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'TypeError: x is undefined',
        source: 'editor.js',
        url: 'https://slug.app.automazionezeli.com/editor',
        userAgent: 'Mozilla/5.0',
      }),
    });
    const fields = lastWarnFields();
    expect(fields.message).toBe('TypeError: x is undefined');
    expect(fields.source).toBe('editor.js');
    expect(fields.url).toBe('https://slug.app.automazionezeli.com/editor');
    expect(fields.userAgent).toBe('Mozilla/5.0');
  });
});
