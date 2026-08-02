/**
 * Test 2026-grade — forms-list admin routes.
 *
 * 🚨 TENANT ISOLATION: tutti i query usano getTenantId(c). Non-owner di
 *    tenant A non può vedere submissions di tenant B.
 *
 * 🚨 CSV EXPORT RFC 4180: quote wrapping su comma/newline/quote interno,
 *    escape quote come "" (double).
 *
 * 🚨 PAYLOAD PARSING: triggerPayloadJson { fields: {...} } shape
 *    estratto; fallback a parsed root se manca 'fields'.
 *
 * 🚨 SUBMISSIONS LIMIT cap 500 (anti-abuse query).
 */
import { Hono } from 'hono';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsonBody } from '@/lib/test-json-body.js';

/** Il corpo di `/forms-list`: i workflow che espongono un form. */
interface FormsListBody {
  forms: {
    workflowId: string;
    workflowName: string;
    enabled: boolean;
    title: string;
    fieldsCount: number;
  }[];
}

/** Il corpo di `/forms-list/:id/submissions`: gli invii ricevuti dal form. */
interface SubmissionsBody {
  workflowName: string;
  submissions: { input: Record<string, unknown> }[];
}

const workflowsListMock = vi.hoisted(() => vi.fn());
const workflowsGetMock = vi.hoisted(() => vi.fn());
const workflowsCreateMock = vi.hoisted(() => vi.fn());

const dbChain = vi.hoisted(() => {
  const selectRows: unknown[] = [];
  const aggRows: unknown[] = [];
  /** orderBy() ritorna un thenable che funge da array (awaitable direct) E ha .limit() */
  const makeOrderBy = () => {
    const p = Promise.resolve(selectRows);
    return Object.assign(p, {
      limit: vi.fn(async () => selectRows),
    });
  };
  /** where() ritorna thenable (await → aggRows per count) + ha .orderBy/.limit per JSON/CSV */
  const makeWhere = () => {
    const p = Promise.resolve(aggRows);
    return Object.assign(p, {
      orderBy: vi.fn(() => makeOrderBy()),
      limit: vi.fn(async () => aggRows),
    });
  };
  return {
    selectRows, aggRows,
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => makeWhere()),
          orderBy: vi.fn(() => makeOrderBy()),
        })),
      })),
    },
  };
});

vi.mock('@/services/workflow.service.js', () => ({
  WorkflowService: vi.fn(() => ({
    list: workflowsListMock,
    get: workflowsGetMock,
    create: workflowsCreateMock,
  })),
}));

vi.mock('@/adapters/event-bus-memory.js', () => ({
  InMemoryEventBus: vi.fn(),
}));

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => dbChain,
}));

vi.mock('@/storage/schema.js', () => ({
  runs: {
    workflowId: 'workflowId', triggerType: 'triggerType', startedAt: 'startedAt',
    id: 'id', status: 'status', endedAt: 'endedAt',
    totalDurationMs: 'totalDurationMs', triggerPayloadJson: 'triggerPayloadJson',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: () => ({}), and: () => ({}), sql: (s: TemplateStringsArray) => ({ _sql: s }), desc: () => ({}),
}));

vi.mock('@/lib/tenant.js', () => ({
  getTenantId: () => 'tenant-1',
}));

vi.mock('nanoid', () => ({ nanoid: (_n?: number) => 'mockid12' }));

const { createFormsListRoutes } = await import('./forms-list.js');

function makeApp() {
  const app = new Hono();
  app.route('/', createFormsListRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbChain.selectRows.length = 0;
  dbChain.aggRows.length = 0;
  workflowsListMock.mockReset();
  workflowsGetMock.mockReset();
  workflowsCreateMock.mockReset();
});

describe('🚨 GET /forms-list', () => {
  it('🚨 nessun workflow con trigger_form → forms []', async () => {
    workflowsListMock.mockResolvedValue([
      { id: 'wf-1', name: 'A', enabled: true, nodes: [
        { id: 'n1', defId: 'action_http', config: {} },
      ] },
    ]);
    const app = makeApp();
    const res = await app.request('/forms-list');
    const body = await jsonBody(res);
    expect(body.forms).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('🚨 workflow con trigger_form → summary con fieldsCount + formUrl', async () => {
    workflowsListMock.mockResolvedValue([{
      id: 'wf-2', name: 'Contact', enabled: true,
      nodes: [{
        id: 'form-x', defId: 'trigger_form',
        config: {
          title: 'Contact Us',
          fieldsJson: JSON.stringify([
            { key: 'name' }, { key: 'email' }, { key: 'msg' },
          ]),
        },
      }],
    }]);
    dbChain.aggRows.push({ c: 5, last: '2026-06-01' });
    const app = makeApp();
    const res = await app.request('/forms-list', {
      headers: { origin: 'https://x.app.zeli.com' },
    });
    const body = await jsonBody<FormsListBody>(res);
    expect(body.forms).toHaveLength(1);
    expect(body.forms[0]).toMatchObject({
      workflowId: 'wf-2', workflowName: 'Contact',
      enabled: true, title: 'Contact Us', fieldsCount: 3,
      formUrl: 'https://x.app.zeli.com/forms/wf-2/form-x',
      submissionCount: 5,
      lastSubmissionAt: '2026-06-01',
    });
  });

  it('🚨 fieldsJson invalido → fieldsCount=0 (no crash)', async () => {
    workflowsListMock.mockResolvedValue([{
      id: 'wf-3', name: 'X', enabled: false,
      nodes: [{
        id: 'f', defId: 'trigger_form',
        config: { fieldsJson: 'NOT-JSON{' },
      }],
    }]);
    dbChain.aggRows.push({ c: 0, last: null });
    const app = makeApp();
    const res = await app.request('/forms-list');
    const body = await jsonBody<FormsListBody>(res);
    expect(body.forms[0]!.fieldsCount).toBe(0);
  });

  it('🚨 title mancante → fallback workflowName', async () => {
    workflowsListMock.mockResolvedValue([{
      id: 'wf-4', name: 'WF Name', enabled: true,
      nodes: [{
        id: 'f', defId: 'trigger_form',
        config: { fieldsJson: '[]' },
      }],
    }]);
    dbChain.aggRows.push({ c: 0, last: null });
    const app = makeApp();
    const res = await app.request('/forms-list');
    const body = await jsonBody<FormsListBody>(res);
    expect(body.forms[0]!.title).toBe('WF Name');
  });
});

describe('🚨 POST /forms-list/quick-create', () => {
  it('🚨 nome default "Nuovo form" se body vuoto', async () => {
    workflowsCreateMock.mockResolvedValue({ id: 'wf-new', name: 'Nuovo form' });
    const app = makeApp();
    const res = await app.request('/forms-list/quick-create', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    expect(workflowsCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Nuovo form',
    }));
  });

  it('🚨 nome custom + title custom', async () => {
    workflowsCreateMock.mockResolvedValue({ id: 'wf-c', name: 'Survey' });
    const app = makeApp();
    await app.request('/forms-list/quick-create', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Survey', title: 'Quick Survey' }),
    });
    expect(workflowsCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Survey',
      nodes: expect.arrayContaining([
        expect.objectContaining({
          config: expect.objectContaining({ title: 'Quick Survey' }),
        }),
      ]),
    }));
  });

  it('🚨 enabled=false by default (user customizza poi enabla)', async () => {
    workflowsCreateMock.mockResolvedValue({ id: 'wf-c' });
    const app = makeApp();
    await app.request('/forms-list/quick-create', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(workflowsCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      enabled: false,
    }));
  });

  it('🚨 default fields nome/email/messaggio', async () => {
    workflowsCreateMock.mockResolvedValue({ id: 'wf-c' });
    const app = makeApp();
    await app.request('/forms-list/quick-create', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const call = workflowsCreateMock.mock.calls[0]![0] as Record<string, unknown>;
    const node = (call.nodes as Record<string, unknown>[])[0]!;
    const fieldsJson = (node.config as Record<string, string>).fieldsJson;
    const fields = JSON.parse(fieldsJson ?? '[]') as { key: string }[];
    expect(fields.map((f) => f.key)).toEqual(['nome', 'email', 'messaggio']);
  });

  it('🚨 body invalido (non-JSON) → fallback no-crash', async () => {
    workflowsCreateMock.mockResolvedValue({ id: 'wf-c' });
    const app = makeApp();
    const res = await app.request('/forms-list/quick-create', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: 'NOT-JSON{',
    });
    expect(res.status).toBe(201);
  });
});

describe('🚨 GET /forms-list/:id/submissions JSON', () => {
  it('🚨 workflow non trovato → 404', async () => {
    workflowsGetMock.mockResolvedValue(null);
    const app = makeApp();
    const res = await app.request('/forms-list/wf-x/submissions');
    expect(res.status).toBe(404);
  });

  it('🚨 ritorna submissions con input parsed da fields shape', async () => {
    workflowsGetMock.mockResolvedValue({ id: 'wf-1', name: 'WF' });
    dbChain.selectRows.push({
      id: 'r-1', status: 'completed',
      startedAt: '2026-01-01', endedAt: '2026-01-01T00:00:01',
      totalDurationMs: 1000,
      triggerPayloadJson: JSON.stringify({ fields: { name: 'Mario', email: 'm@x.com' } }),
    });
    const app = makeApp();
    const res = await app.request('/forms-list/wf-1/submissions');
    const body = await jsonBody<SubmissionsBody>(res);
    expect(body.submissions[0]!.input).toEqual({ name: 'Mario', email: 'm@x.com' });
    expect(body.workflowName).toBe('WF');
  });

  it('🚨 payload senza fields → input = root', async () => {
    workflowsGetMock.mockResolvedValue({ id: 'wf-1', name: 'WF' });
    dbChain.selectRows.push({
      id: 'r-2', status: 'completed',
      startedAt: '2026-01-01', endedAt: null, totalDurationMs: 500,
      triggerPayloadJson: JSON.stringify({ direct: 'value' }),
    });
    const app = makeApp();
    const res = await app.request('/forms-list/wf-1/submissions');
    const body = await jsonBody<SubmissionsBody>(res);
    expect(body.submissions[0]!.input).toEqual({ direct: 'value' });
  });

  it('🚨 payload JSON invalido → input {} (no crash)', async () => {
    workflowsGetMock.mockResolvedValue({ id: 'wf-1', name: 'WF' });
    dbChain.selectRows.push({
      id: 'r-3', status: 'completed',
      startedAt: '2026-01-01', endedAt: null, totalDurationMs: 500,
      triggerPayloadJson: 'INVALID{',
    });
    const app = makeApp();
    const res = await app.request('/forms-list/wf-1/submissions');
    const body = await jsonBody<SubmissionsBody>(res);
    expect(body.submissions[0]!.input).toEqual({});
  });
});

describe('🚨 GET /forms-list/:id/submissions.csv (RFC 4180)', () => {
  beforeEach(() => {
    workflowsGetMock.mockResolvedValue({ id: 'wf-1', name: 'My Form' });
  });

  it('🚨 workflow non trovato → 404', async () => {
    workflowsGetMock.mockResolvedValue(null);
    const app = makeApp();
    const res = await app.request('/forms-list/wf-x/submissions.csv');
    expect(res.status).toBe(404);
  });

  it('🚨 header CSV con run_id, started_at, status + field discovery', async () => {
    dbChain.selectRows.push({
      id: 'r-1', status: 'completed', startedAt: '2026-01-01',
      triggerPayloadJson: JSON.stringify({ fields: { name: 'A', email: 'a@x' } }),
    });
    dbChain.selectRows.push({
      id: 'r-2', status: 'failed', startedAt: '2026-01-02',
      triggerPayloadJson: JSON.stringify({ fields: { name: 'B', extra: 'X' } }),
    });
    const app = makeApp();
    const res = await app.request('/forms-list/wf-1/submissions.csv');
    const csv = await res.text();
    const lines = csv.split('\r\n');
    expect(lines[0]).toContain('run_id');
    expect(lines[0]).toContain('email'); // discovered
    expect(lines[0]).toContain('extra'); // discovered
  });

  it('🚨 RFC 4180: comma nel valore → wrapping in quotes', async () => {
    dbChain.selectRows.push({
      id: 'r-1', status: 'ok', startedAt: '2026-01-01',
      triggerPayloadJson: JSON.stringify({ fields: { name: 'Rossi, Mario' } }),
    });
    const app = makeApp();
    const res = await app.request('/forms-list/wf-1/submissions.csv');
    const csv = await res.text();
    expect(csv).toContain('"Rossi, Mario"');
  });

  it('🚨 RFC 4180: quote nel valore → doppia quote', async () => {
    dbChain.selectRows.push({
      id: 'r-1', status: 'ok', startedAt: '2026-01-01',
      triggerPayloadJson: JSON.stringify({ fields: { name: 'Say "hi"' } }),
    });
    const app = makeApp();
    const res = await app.request('/forms-list/wf-1/submissions.csv');
    const csv = await res.text();
    expect(csv).toContain('"Say ""hi"""');
  });

  it('🚨 filename sanitizzato (no path traversal)', async () => {
    workflowsGetMock.mockResolvedValue({ id: 'wf-1', name: '../etc/passwd' });
    const app = makeApp();
    const res = await app.request('/forms-list/wf-1/submissions.csv');
    const disp = res.headers.get('content-disposition') ?? '';
    expect(disp).not.toContain('..');
    expect(disp).not.toContain('/');
  });

  it('🚨 Content-Type text/csv charset utf-8', async () => {
    const app = makeApp();
    const res = await app.request('/forms-list/wf-1/submissions.csv');
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-type')).toContain('utf-8');
  });
});
