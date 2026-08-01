/**
 * Test 2026-grade — forms route (auto-rendered HTML form per workflow trigger).
 *
 * 🚨 TIMING ATTACK: safeTokenCompare usa Buffer + crypto.timingSafeEqual.
 *   Pre-fix: string comparison normale leak posizione di mismatch.
 *
 * 🚨 LEGACY WORKFLOW (pre-2026-05-23): no publicToken → 410 "rigenera link"
 *   non 404 (UX: capire perché link smesso di funzionare).
 *
 * 🚨 XSS: escapeHtml su title/fields/options/help/placeholder/successMessage.
 *   Bug = field.label malicious "<script>" eseguito in cliente.
 *
 * 🚨 RATE LIMIT per IP: x-forwarded-for o x-real-ip. Default 10/min.
 *   429 oltre, NO esecuzione workflow.
 *
 * 🚨 SAME TOKEN GATE per GET (form render) E POST (submit) — entrambi
 *   passano da authFormRequest.
 */
import { Hono } from 'hono';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const workflowsMock = vi.hoisted(() => ({ getByIdAnyTenant: vi.fn() }));
const runsExecuteMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/workflow.service.js', () => ({
  WorkflowService: vi.fn(() => workflowsMock),
}));
vi.mock('@/services/run.service.js', () => ({
  RunService: vi.fn(() => ({ execute: runsExecuteMock })),
}));
vi.mock('@/lib/logger.js');

const { createFormRoutes } = await import('./forms.js');

function makeApp() {
  const app = new Hono();
  app.route('/', createFormRoutes({} as never));
  return app;
}

const wf = (over: Record<string, unknown> = {}) => ({
  id: 'wf-1',
  tenantId: 'tenant-1',
  nodes: [{
    id: 'form-1',
    defId: 'trigger_form',
    config: {
      publicToken: 'valid-token-32-chars-long-abcdefg',
      title: 'Contact',
      submitLabel: 'Send',
      fieldsJson: JSON.stringify([{ key: 'name', label: 'Name', type: 'text', required: true }]),
      rateLimitPerMin: '10',
      successMessage: 'Thanks!',
    },
  }],
  edges: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  workflowsMock.getByIdAnyTenant.mockReset();
  runsExecuteMock.mockReset();
  runsExecuteMock.mockResolvedValue({ runId: 'r-1' });
});

describe('🚨 SECURITY: token gate', () => {
  it('🚨 workflow inesistente → 404', async () => {
    workflowsMock.getByIdAnyTenant.mockResolvedValue(null);
    const app = makeApp();
    const res = await app.request('/wf-1/anytoken');
    expect(res.status).toBe(404);
  });

  it('🚨 workflow senza trigger_form → 404', async () => {
    workflowsMock.getByIdAnyTenant.mockResolvedValue({
      ...wf(), nodes: [{ id: 'other', defId: 'action_http', config: {} }],
    });
    const app = makeApp();
    const res = await app.request('/wf-1/token');
    expect(res.status).toBe(404);
  });

  it('🚨 LEGACY workflow senza publicToken → 410 (rigenera link)', async () => {
    workflowsMock.getByIdAnyTenant.mockResolvedValue({
      ...wf(),
      nodes: [{ id: 'form-1', defId: 'trigger_form', config: { fieldsJson: '[]' } }],
    });
    const app = makeApp();
    const res = await app.request('/wf-1/anytoken');
    expect(res.status).toBe(410);
    const text = await res.text();
    expect(text).toContain('editor');
  });

  it('🚨 SECURITY: token wrong → 403 (timing-safe compare)', async () => {
    workflowsMock.getByIdAnyTenant.mockResolvedValue(wf());
    const app = makeApp();
    const res = await app.request('/wf-1/WRONG');
    expect(res.status).toBe(403);
  });

  it('🚨 SECURITY: token con length diversa NON crasha (timing-safe)', async () => {
    workflowsMock.getByIdAnyTenant.mockResolvedValue(wf());
    const app = makeApp();
    const res = await app.request('/wf-1/X');
    expect(res.status).toBe(403);
  });

  it('🚨 token valido → 200 + HTML form', async () => {
    workflowsMock.getByIdAnyTenant.mockResolvedValue(wf());
    const app = makeApp();
    const res = await app.request('/wf-1/valid-token-32-chars-long-abcdefg');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Contact');
    expect(html).toContain('Send');
  });
});

describe('🚨 XSS prevention escapeHtml', () => {
  it('🚨 title con HTML → escaped', async () => {
    workflowsMock.getByIdAnyTenant.mockResolvedValue(wf({
      nodes: [{
        id: 'form-1', defId: 'trigger_form',
        config: {
          publicToken: 'tok',
          title: '<script>alert(1)</script>',
          fieldsJson: '[]',
        },
      }],
    }));
    const app = makeApp();
    const res = await app.request('/wf-1/tok');
    const html = await res.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('🚨 field.label con HTML → escaped', async () => {
    workflowsMock.getByIdAnyTenant.mockResolvedValue(wf({
      nodes: [{
        id: 'form-1', defId: 'trigger_form',
        config: {
          publicToken: 'tok',
          fieldsJson: JSON.stringify([{
            key: 'k', label: '<img src=x onerror=alert(1)>', type: 'text',
          }]),
        },
      }],
    }));
    const app = makeApp();
    const res = await app.request('/wf-1/tok');
    const html = await res.text();
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  it('🚨 select options escaped', async () => {
    workflowsMock.getByIdAnyTenant.mockResolvedValue(wf({
      nodes: [{
        id: 'form-1', defId: 'trigger_form',
        config: {
          publicToken: 'tok',
          fieldsJson: JSON.stringify([{
            key: 'k', label: 'Choice', type: 'select',
            options: ['<script>1</script>'],
          }]),
        },
      }],
    }));
    const app = makeApp();
    const res = await app.request('/wf-1/tok');
    const html = await res.text();
    expect(html).not.toContain('<script>1</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('🚨 fieldsJson parsing', () => {
  it('🚨 JSON invalido → fields []', async () => {
    workflowsMock.getByIdAnyTenant.mockResolvedValue(wf({
      nodes: [{
        id: 'form-1', defId: 'trigger_form',
        config: { publicToken: 'tok', fieldsJson: 'NOT-JSON{' },
      }],
    }));
    const app = makeApp();
    const res = await app.request('/wf-1/tok');
    expect(res.status).toBe(200);
  });

  it('🚨 fieldsJson non array → fields []', async () => {
    workflowsMock.getByIdAnyTenant.mockResolvedValue(wf({
      nodes: [{
        id: 'form-1', defId: 'trigger_form',
        config: { publicToken: 'tok', fieldsJson: '{"not":"array"}' },
      }],
    }));
    const app = makeApp();
    const res = await app.request('/wf-1/tok');
    expect(res.status).toBe(200);
  });
});

describe('🚨 POST submission', () => {
  it('🚨 token wrong → 403 SAME GATE come GET', async () => {
    workflowsMock.getByIdAnyTenant.mockResolvedValue(wf());
    const app = makeApp();
    const fd = new FormData();
    fd.append('name', 'Mario');
    const res = await app.request('/wf-1/WRONG', { method: 'POST', body: fd });
    expect(res.status).toBe(403);
    expect(runsExecuteMock).not.toHaveBeenCalled();
  });

  it('🚨 submission valida → runs.execute con triggerInput', async () => {
    workflowsMock.getByIdAnyTenant.mockResolvedValue(wf());
    const app = makeApp();
    const fd = new FormData();
    fd.append('name', 'Mario Rossi');
    const res = await app.request('/wf-1/valid-token-32-chars-long-abcdefg', {
      method: 'POST', body: fd,
    });
    expect(res.status).toBe(200);
    expect(runsExecuteMock).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: 'wf-1',
      triggerType: 'form',
      triggerInput: { name: 'Mario Rossi' },
      tenantId: 'tenant-1',
    }));
  });

  it('🚨 successMessage escaped nel render', async () => {
    workflowsMock.getByIdAnyTenant.mockResolvedValue(wf({
      nodes: [{
        id: 'form-1', defId: 'trigger_form',
        config: {
          publicToken: 'tok',
          fieldsJson: '[]',
          successMessage: '<script>alert(1)</script>',
        },
      }],
    }));
    const app = makeApp();
    const fd = new FormData();
    const res = await app.request('/wf-1/tok', { method: 'POST', body: fd });
    const html = await res.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('🚨 file field → "[file]" marker (no leak nel triggerInput)', async () => {
    workflowsMock.getByIdAnyTenant.mockResolvedValue(wf());
    const app = makeApp();
    const fd = new FormData();
    fd.append('attachment', new File(['secret'], 'doc.pdf'));
    fd.append('name', 'plain');
    await app.request('/wf-1/valid-token-32-chars-long-abcdefg', {
      method: 'POST', body: fd,
    });
    expect(runsExecuteMock).toHaveBeenCalledWith(expect.objectContaining({
      triggerInput: expect.objectContaining({ attachment: '[file]', name: 'plain' }),
    }));
  });

  it('🚨 runs.execute throw → continua a renderizzare success (no crash)', async () => {
    workflowsMock.getByIdAnyTenant.mockResolvedValue(wf());
    runsExecuteMock.mockRejectedValueOnce(new Error('engine down'));
    const app = makeApp();
    const fd = new FormData();
    const res = await app.request('/wf-1/valid-token-32-chars-long-abcdefg', {
      method: 'POST', body: fd,
    });
    expect(res.status).toBe(200);
  });
});

describe('🚨 rate limit per IP', () => {
  it('🚨 oltre limite → 429 + NO esecuzione', async () => {
    const slow = wf({ nodes: [{
      id: 'form-1', defId: 'trigger_form',
      config: {
        publicToken: 'rl-tok',
        fieldsJson: '[]', rateLimitPerMin: '2',
      },
    }] });
    workflowsMock.getByIdAnyTenant.mockResolvedValue(slow);
    const app = makeApp();
    const ip = '1.2.3.4';
    const submit = () => app.request('/wf-1/rl-tok', {
      method: 'POST',
      headers: { 'x-forwarded-for': ip },
      body: new FormData(),
    });
    await submit();
    await submit();
    const third = await submit();
    expect(third.status).toBe(429);
    // Solo 2 esecuzioni
    expect(runsExecuteMock).toHaveBeenCalledTimes(2);
  });

  it('🚨 IP diversi → limit separato', async () => {
    const slow = wf({ nodes: [{
      id: 'form-1', defId: 'trigger_form',
      config: {
        publicToken: 'rl-tok-2',
        fieldsJson: '[]', rateLimitPerMin: '1',
      },
    }] });
    workflowsMock.getByIdAnyTenant.mockResolvedValue(slow);
    const app = makeApp();
    await app.request('/wf-1/rl-tok-2', {
      method: 'POST', headers: { 'x-forwarded-for': '1.1.1.1' }, body: new FormData(),
    });
    const r2 = await app.request('/wf-1/rl-tok-2', {
      method: 'POST', headers: { 'x-forwarded-for': '2.2.2.2' }, body: new FormData(),
    });
    expect(r2.status).toBe(200);
  });
});
