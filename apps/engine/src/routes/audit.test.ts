/**
 * Test 2026-grade — audit routes (cursor pagination + CSV/JSON export).
 *
 * 🚨 SECURITY: tenant isolation via getTenantId (WHERE tenantId=?).
 *
 * 🚨 INPUT VALIDATION: ?before deve essere numero finito (Number.isFinite),
 *    altrimenti 400. Senza guard: `Number('abc')` → NaN → drizzle Less-Than
 *    NaN cmp → query rotto silenziosamente.
 *
 * 🚨 PAGINATION CORRECTNESS: query usa LIMIT (limit+1) per detect hasMore
 *    senza secondo round-trip. Cursor nextBefore = id ultimo elemento page.
 *
 * 🚨 CSV ESCAPE: campi con , " \n DEVONO essere quotati + " raddoppiato
 *    (RFC 4180). Bug = CSV import in Excel rotto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const auditRows: Record<string, unknown>[] = [];

// MockDb: chainable + thenable. Quando il sorgente fa
// `db.select().from().where().orderBy()` (export) → l'await su mockDb
// risolve via .then() che ritorna [...auditRows].
// Quando fa `.orderBy().limit(N)` (pagination) → limit ritorna Promise.
const mockDb: {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  then: (resolve: (rows: unknown[]) => void) => void;
} = {
  select: vi.fn(() => mockDb),
  from: vi.fn(() => mockDb),
  where: vi.fn(() => mockDb),
  orderBy: vi.fn(() => mockDb),
  limit: vi.fn(() => Promise.resolve([...auditRows])),
  then: (resolve) => resolve([...auditRows]),
};

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ db: mockDb }),
}));

vi.mock('@/storage/schema.js', () => ({
  auditLog: { tenantId: 'tenantId', id: 'id', action: 'action' },
}));

vi.mock('drizzle-orm', () => ({
  desc: (col: unknown) => ({ _kind: 'desc', col }),
  eq: (col: unknown, val: unknown) => ({ _kind: 'eq', col, val }),
  and: (...conds: unknown[]) => ({ _kind: 'and', conds }),
  lt: (col: unknown, val: unknown) => ({ _kind: 'lt', col, val }),
  like: (col: unknown, val: unknown) => ({ _kind: 'like', col, val }),
}));

vi.mock('@/lib/tenant.js', () => ({
  getTenantId: (c: { req: { header: (n: string) => string | undefined } }) =>
    c.req.header('x-tenant-id') ?? 'tenant-default',
}));

const { createAuditRoutes } = await import('./audit.js');

function makeRow(
  id: number,
  overrides: Partial<{
    action: string;
    metadataJson: string;
    tenantId: string;
    createdAt: string;
    hash: string;
    prevHash: string;
  }> = {},
) {
  return {
    id,
    tenantId: 'tenant-A',
    actorId: 'user-1',
    action: 'workflow.run',
    resourceType: 'workflow',
    resourceId: 'wf-1',
    metadataJson: '{"key":"value"}',
    createdAt: '2026-06-08T10:00:00Z',
    hash: 'hashAAA',
    prevHash: 'hashPREV',
    ...overrides,
  };
}

async function makeRequest(path: string, tenantId = 'tenant-A'): Promise<Response> {
  const app = new Hono();
  app.route('/api/v1', createAuditRoutes());
  return app.request(path, { headers: { 'x-tenant-id': tenantId } });
}

beforeEach(() => {
  vi.clearAllMocks();
  auditRows.length = 0;
  // Reset chain — drizzle è chainable
  mockDb.select.mockReturnValue(mockDb);
  mockDb.from.mockReturnValue(mockDb);
  mockDb.where.mockReturnValue(mockDb);
  mockDb.orderBy.mockReturnValue(mockDb);
  mockDb.limit.mockImplementation(() => Promise.resolve([...auditRows]));
});

describe('🚨 GET /audit — pagination + metadata parsing', () => {
  it('🚨 base query → entries + total + hasMore=false', async () => {
    auditRows.push(makeRow(3), makeRow(2), makeRow(1));
    const res = await makeRequest('/api/v1/audit');
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      entries: { id: number }[];
      total: number;
      hasMore: boolean;
      nextBefore: number | null;
    };
    expect(json.entries).toHaveLength(3);
    expect(json.total).toBe(3);
    expect(json.hasMore).toBe(false);
    expect(json.nextBefore).toBeNull();
  });

  it('🚨 hasMore: rows.length > limit → page = limit, nextBefore = last id', async () => {
    // Default limit = 100. Push 101 rows → drizzle LIMIT (100+1) ritorna 101.
    for (let i = 101; i >= 1; i--) auditRows.push(makeRow(i));
    const res = await makeRequest('/api/v1/audit');
    const json = (await res.json()) as { entries: unknown[]; hasMore: boolean; nextBefore: number };
    expect(json.entries).toHaveLength(100);
    expect(json.hasMore).toBe(true);
    expect(json.nextBefore).toBe(2); // 100° elemento (id descending 101..2)
  });

  it('🚨 INPUT VALIDATION: limit clamped a 500 max', async () => {
    auditRows.push(makeRow(1));
    await makeRequest('/api/v1/audit?limit=10000');
    // drizzle.limit() chiamato con 501 (clamped 500 + 1)
    expect(mockDb.limit).toHaveBeenCalledWith(501);
  });

  it('🚨 INPUT VALIDATION: limit clamped a 1 min', async () => {
    auditRows.push(makeRow(1));
    await makeRequest('/api/v1/audit?limit=0');
    expect(mockDb.limit).toHaveBeenCalledWith(2); // 1 + 1
  });

  it('🚨 INPUT VALIDATION: ?before=abc (non-numeric) → 400', async () => {
    const res = await makeRequest('/api/v1/audit?before=abc');
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/numeric/u);
  });

  it('🚨 ?before=NaN string → 400 (Number("NaN")=NaN)', async () => {
    const res = await makeRequest('/api/v1/audit?before=NaN');
    expect(res.status).toBe(400);
  });

  it('🚨 ?before=Infinity → 400 (NON Number.isFinite)', async () => {
    const res = await makeRequest('/api/v1/audit?before=Infinity');
    expect(res.status).toBe(400);
  });

  it('🚨 ?before=42 valido → lt(id, 42) condition aggiunta', async () => {
    auditRows.push(makeRow(40), makeRow(35));
    await makeRequest('/api/v1/audit?before=42');
    // where chiamato con and(eq tenant, lt id)
    expect(mockDb.where).toHaveBeenCalled();
    const whereArg = mockDb.where.mock.calls[0]![0] as {
      _kind: string;
      conds: { _kind: string; val: unknown }[];
    };
    expect(whereArg._kind).toBe('and');
    const ltCond = whereArg.conds.find((c) => c._kind === 'lt');
    expect(ltCond).toBeDefined();
    expect(ltCond!.val).toBe(42);
  });

  it('🚨 ?actionPrefix=workflow.test → LIKE workflow.test% condition', async () => {
    await makeRequest('/api/v1/audit?actionPrefix=workflow.test_node');
    const whereArg = mockDb.where.mock.calls[0]![0] as { conds: { _kind: string; val: unknown }[] };
    const likeCond = whereArg.conds.find((c) => c._kind === 'like');
    expect(likeCond).toBeDefined();
    expect(likeCond!.val).toBe('workflow.test_node%');
  });

  it('🚨 metadata JSON parsed nel response (NON raw string)', async () => {
    auditRows.push(makeRow(1, { metadataJson: '{"actorRole":"admin","ip":"1.2.3.4"}' }));
    const res = await makeRequest('/api/v1/audit');
    const json = (await res.json()) as { entries: { metadata: { actorRole: string } }[] };
    expect(json.entries[0]!.metadata).toEqual({ actorRole: 'admin', ip: '1.2.3.4' });
  });

  it('🚨 metadata JSON malformato → fallback a raw string (NO crash)', async () => {
    auditRows.push(makeRow(1, { metadataJson: 'NOT-JSON{{{' }));
    const res = await makeRequest('/api/v1/audit');
    const json = (await res.json()) as { entries: { metadata: string }[] };
    expect(json.entries[0]!.metadata).toBe('NOT-JSON{{{');
  });

  it('🚨 metadata null → fallback "{}" parsed = {}', async () => {
    auditRows.push(makeRow(1, { metadataJson: undefined as unknown as string }));
    const res = await makeRequest('/api/v1/audit');
    const json = (await res.json()) as { entries: { metadata: unknown }[] };
    expect(json.entries[0]!.metadata).toEqual({});
  });
});

describe('🚨 GET /audit/export — CSV/JSON download', () => {
  it('🚨 default format=csv → Content-Type CSV + Content-Disposition attachment', async () => {
    auditRows.push(makeRow(1));
    const res = await makeRequest('/api/v1/audit/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/u);
    const cd = res.headers.get('content-disposition')!;
    expect(cd).toMatch(/attachment/u);
    expect(cd).toMatch(/\.csv"$/u);
    expect(cd).toContain('audit-tenant-A');
  });

  it('🚨 format=json → Content-Type JSON', async () => {
    auditRows.push(makeRow(1));
    const res = await makeRequest('/api/v1/audit/export?format=json');
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('content-disposition')).toMatch(/\.json"$/u);
  });

  it('🚨 format=xml (invalid) → fallback CSV', async () => {
    auditRows.push(makeRow(1));
    const res = await makeRequest('/api/v1/audit/export?format=xml');
    expect(res.headers.get('content-type')).toMatch(/text\/csv/u);
  });

  it('🚨 CSV: header riga 1 con tutte le 10 colonne', async () => {
    auditRows.push(makeRow(1));
    const res = await makeRequest('/api/v1/audit/export');
    const csv = await res.text();
    const firstLine = csv.split('\n')[0]!;
    expect(firstLine).toBe(
      'id,tenant_id,actor_id,action,resource_type,resource_id,metadata,created_at,hash,prev_hash',
    );
  });

  it('🚨 CSV: data row contiene 10 colonne', async () => {
    auditRows.push(makeRow(1));
    const res = await makeRequest('/api/v1/audit/export');
    const csv = await res.text();
    const dataLine = csv.split('\n')[1]!;
    const cells = dataLine.split(',');
    expect(cells.length).toBeGreaterThanOrEqual(10);
    expect(cells[0]).toBe('1'); // id
  });

  it('🚨 CSV ESCAPE: campo con virgola → quotato', async () => {
    auditRows.push(makeRow(1, { action: 'workflow,with,commas' }));
    const res = await makeRequest('/api/v1/audit/export');
    const csv = await res.text();
    expect(csv).toContain('"workflow,with,commas"');
  });

  it('🚨 CSV ESCAPE: campo con virgolette → " raddoppiato (RFC 4180)', async () => {
    auditRows.push(makeRow(1, { action: 'has "quoted" text' }));
    const res = await makeRequest('/api/v1/audit/export');
    const csv = await res.text();
    expect(csv).toContain('"has ""quoted"" text"');
  });

  it('🚨 CSV ESCAPE: campo con newline → quotato', async () => {
    auditRows.push(makeRow(1, { action: 'line1\nline2' }));
    const res = await makeRequest('/api/v1/audit/export');
    const csv = await res.text();
    expect(csv).toContain('"line1\nline2"');
  });

  it('🚨 JSON export: pretty-printed 2-space indent', async () => {
    auditRows.push(makeRow(1));
    const res = await makeRequest('/api/v1/audit/export?format=json');
    const text = await res.text();
    // Array di oggetti → secondo livello (campi) = 4 spaces (2 indent + 2 nested)
    expect(text).toMatch(/\n {4}"id"/u);
    // E lo `{` dell'oggetto in array è a 2 spaces
    expect(text).toMatch(/\n {2}\{/u);
  });

  it('🚨 SECURITY tenant isolation: filename contiene tenant-A', async () => {
    auditRows.push(makeRow(1));
    const res = await makeRequest('/api/v1/audit/export', 'tenant-A');
    expect(res.headers.get('content-disposition')).toContain('audit-tenant-A');
  });
});
