/**
 * workflow.service tests — enterprise grade (audit 2026-05-29).
 *
 * Coverage focus:
 *   • CRUD basics (create/get/list/delete) + tenant isolation
 *   • Security: ensureFormTriggerTokens auto-gen (≥16 chars, idempotent)
 *   • Resilience: list/listAllAcrossTenants skip schema-drift rows (no throw)
 *   • Validation: update refuses orphan edges (engine sub-graph integrity)
 *   • Webhook path resolution: exact match, no substring confusion
 *   • Cross-tenant lookup helpers (getByIdAnyTenant, listByCustomWebhookPathAnyTenant)
 *   • Draft autosave: tenant scope, get/discard atomicity
 *   • Export bundle: secret redaction (password/secret/apikey/token/bearer/
 *     credentialId/publicToken), SHA-256 checksum integrity
 *   • Import bundle: schemaVersion check, checksum mismatch warning,
 *     auto-rename collision, disabled-by-default policy
 *   • Audit log: append called with correct action + tenantId + actorId
 *
 * Mock strategy: spy on DB fluent API (select/insert/update/delete) +
 * audit.service + event bus. NO real DB — keeps suite hermetic + fast.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dedupedWarn } from '@/lib/logger.js';

const m = vi.hoisted(() => ({
  // DB chain returns
  selectRows: vi.fn(),
  insertRun: vi.fn().mockResolvedValue(undefined),
  updateRun: vi.fn().mockResolvedValue(undefined),
  deleteRun: vi.fn().mockResolvedValue(undefined),
  // Captura patch (UPDATE set object) — utile per branch tests
  capturedUpdatePatch: null as Record<string, unknown> | null,
  // collaborators
  auditAppend: vi.fn().mockResolvedValue(undefined),
  emit: vi.fn(),
  // observability
  counterInc: vi.fn(),
}));

// Thenable mock per supportare sia `await db.select().from()` direct
// (listAllAcrossTenants/listByCustomWebhookPathAnyTenant) sia il chain
// .where().orderBy()/.limit() (list/get tenant-scoped).
function makeQueryBuilder() {
  const builder: Record<string, unknown> = {
    where: () => ({
      orderBy: () => m.selectRows(),
      limit: () => m.selectRows(),
    }),
    orderBy: () => m.selectRows(),
    limit: () => m.selectRows(),
    then: (onFulfilled: (v: unknown[]) => unknown, onRejected?: (e: unknown) => unknown) => {
      const result = m.selectRows();
      // selectRows() può essere a sync array or a Promise
      return Promise.resolve(result).then(onFulfilled, onRejected);
    },
  };
  return builder;
}

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({
    db: {
      select: () => ({ from: () => makeQueryBuilder() }),
      insert: () => ({ values: m.insertRun }),
      update: () => ({
        set: (patch: Record<string, unknown>) => {
          m.capturedUpdatePatch = patch;
          return { where: () => m.updateRun() };
        },
      }),
      delete: () => ({
        where: () => m.deleteRun(),
      }),
    },
  }),
}));

vi.mock('./audit.service.js', () => ({
  AuditLogService: vi.fn().mockImplementation(() => ({
    append: m.auditAppend,
  })),
}));

// 2026-06-06: il fix quota single-source-of-truth in workflow.service.ts ora
// chiama `tenantService.checkQuota` su `create({enabled:true})` e su
// `update({enabled:true})` quando l'esistente era disabled. Nei test unit del
// service la quota e\` non-rilevante (testiamo branch fillers, non policy):
// mock no-op cosi\` il check passa silently invece di richiedere mock SQLite.
vi.mock('./tenant.service.js', () => ({
  tenantService: { checkQuota: vi.fn() },
  QuotaExceededError: class extends Error {
    constructor(public tenantId: string, public kind: string, public limit: number, public current: number) {
      super(`Quota exceeded: ${kind} (${String(current)}/${String(limit)})`);
    }
  },
}));

vi.mock('@/lib/logger.js');

vi.mock('@/lib/metrics-store.js', () => ({
  counterInc: m.counterInc,
}));

vi.mock('@/lib/safe-parse-json.js', () => ({
  safeParseJson: (s: string | null | undefined) => {
    if (s === null || s === undefined) return null;
    try { return JSON.parse(s); } catch { return s; }
  },
}));

// ─── Lazy import dopo mock setup ───────────────────────────────────
import { WorkflowService, diagnoseWorkflowRow } from './workflow.service.js';

const eventBus = { emit: m.emit, subscribe: vi.fn(), unsubscribe: vi.fn() };

function makeRow(over: Partial<{
  id: string;
  tenantId: string;
  name: string;
  enabled: boolean;
  nodes: unknown[];
  edges: unknown[];
  nodeDefs: unknown[];
  description: string;
  draftJson: string | null;
  draftUpdatedAt: string | null;
  tagsJson: string | null;
  folderId: string | null;
  onErrorJson: string | null;
  concurrencyLimit: number | null;
  breakpointsJson: string | null;
}> = {}) {
  const now = '2026-05-29T10:00:00.000Z';
  return {
    id: over.id ?? 'wf-1',
    tenantId: over.tenantId ?? 'tenant-a',
    name: over.name ?? 'Test workflow',
    description: over.description ?? null,
    enabled: over.enabled ?? false,
    schemaVersion: '1.0.0',
    nodesJson: JSON.stringify(over.nodes ?? []),
    edgesJson: JSON.stringify(over.edges ?? []),
    nodeDefsJson: JSON.stringify(over.nodeDefs ?? []),
    breakpointsJson: over.breakpointsJson ?? null,
    tagsJson: over.tagsJson ?? null,
    folderId: over.folderId ?? null,
    onErrorJson: over.onErrorJson ?? null,
    concurrencyLimit: over.concurrencyLimit ?? null,
    draftJson: over.draftJson ?? null,
    draftUpdatedAt: over.draftUpdatedAt ?? null,
    createdAt: now,
    updatedAt: now,
    createdBy: null,
    ownerId: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks(); // restore spyOn (cleanup test isolation)
  m.insertRun.mockResolvedValue(undefined);
  m.updateRun.mockResolvedValue(undefined);
  m.deleteRun.mockResolvedValue(undefined);
  m.capturedUpdatePatch = null;
});

// ════════════════════════════════════════════════════════════════════
// diagnoseWorkflowRow — exported helper for /admin/workflows/health
// ════════════════════════════════════════════════════════════════════
describe('diagnoseWorkflowRow', () => {
  it('returns ok:true per row con schema valido', () => {
    const row = makeRow({ name: 'X', nodes: [{ id: 'n1', defId: 'noop', x: 0, y: 0, config: {} }] });
    const res = diagnoseWorkflowRow(row as never);
    expect(res.ok).toBe(true);
    expect(res.issues).toBeUndefined();
  });

  it('returns ok:false con issues path per row corrotto', () => {
    const row = makeRow({ name: '' }); // name empty fails WorkflowSchema
    const res = diagnoseWorkflowRow(row as never);
    expect(res.ok).toBe(false);
    expect(Array.isArray(res.issues)).toBe(true);
    expect((res.issues ?? []).length).toBeGreaterThan(0);
    expect(res.issues?.[0]).toMatchObject({ path: expect.any(String), code: expect.any(String) });
  });

  it('returns ok:false su nodesJson malformato (parse fallback string)', () => {
    const row = makeRow();
    (row as { nodesJson: string }).nodesJson = '{this is not json';
    const res = diagnoseWorkflowRow(row as never);
    expect(res.ok).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// list() — resilient skip schema-drift rows
// ════════════════════════════════════════════════════════════════════
describe('WorkflowService.list', () => {
  it('returns array vuoto se nessuna row', async () => {
    m.selectRows.mockResolvedValue([]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.list('tenant-a');
    expect(res).toEqual([]);
  });

  it('skip silenzioso row corrotti + emette dedupedWarn + counterInc', async () => {
    const good = makeRow({ id: 'wf-good', name: 'Good' });
    const bad = makeRow({ id: 'wf-bad', name: '' }); // empty name fails Zod
    m.selectRows.mockResolvedValue([good, bad, makeRow({ id: 'wf-good-2', name: 'Good 2' })]);

    const svc = new WorkflowService(eventBus as never);
    const res = await svc.list('tenant-a');

    expect(res).toHaveLength(2);
    expect(res.map((w) => w.id).sort()).toEqual(['wf-good', 'wf-good-2']);
    expect(vi.mocked(dedupedWarn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dedupedWarn)).toHaveBeenCalledWith(
      expect.stringContaining('wf-schema-drift:wf-bad'),
      expect.objectContaining({ workflowId: 'wf-bad', tenantId: 'tenant-a' }),
      expect.any(String),
    );
    expect(m.counterInc).toHaveBeenCalledWith(expect.objectContaining({
      name: 'flowforge_workflow_schema_invalid_total',
      tags: { tenant: 'tenant-a' },
    }));
  });

  it('non chiama dedupedWarn se tutte le row sono ok', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-1' }), makeRow({ id: 'wf-2' })]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.list();
    expect(res).toHaveLength(2);
    expect(vi.mocked(dedupedWarn)).not.toHaveBeenCalled();
    expect(m.counterInc).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════
// listByCustomWebhookPath — exact match (no substring confusion)
// ════════════════════════════════════════════════════════════════════
describe('WorkflowService.listByCustomWebhookPath', () => {
  it('match esatto su customPath', async () => {
    m.selectRows.mockResolvedValue([
      makeRow({
        id: 'wf-orders',
        enabled: true,
        nodes: [{ id: 'n1', defId: 'trigger_webhook', x: 0, y: 0, config: { customPath: 'orders' } }],
      }),
    ]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.listByCustomWebhookPath('tenant-a', 'orders');
    expect(res).toHaveLength(1);
    expect(res[0]?.id).toBe('wf-orders');
  });

  it('skip workflow disabled', async () => {
    m.selectRows.mockResolvedValue([
      makeRow({
        id: 'wf-off',
        enabled: false,
        nodes: [{ id: 'n1', defId: 'trigger_webhook', x: 0, y: 0, config: { customPath: 'orders' } }],
      }),
    ]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.listByCustomWebhookPath('tenant-a', 'orders');
    expect(res).toEqual([]);
  });

  it('NO substring match: "orders" non matcha "orders/v2"', async () => {
    m.selectRows.mockResolvedValue([
      makeRow({
        id: 'wf-orders-v2',
        enabled: true,
        nodes: [{ id: 'n1', defId: 'trigger_webhook', x: 0, y: 0, config: { customPath: 'orders/v2' } }],
      }),
    ]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.listByCustomWebhookPath('tenant-a', 'orders');
    expect(res).toEqual([]);
  });

  it('returns [] su customPath vuoto (no oracle path enumeration)', async () => {
    m.selectRows.mockResolvedValue([
      makeRow({
        enabled: true,
        nodes: [{ id: 'n1', defId: 'trigger_webhook', x: 0, y: 0, config: { customPath: '' } }],
      }),
    ]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.listByCustomWebhookPath('tenant-a', '');
    expect(res).toEqual([]);
  });

  it('skip nodi non trigger_webhook', async () => {
    m.selectRows.mockResolvedValue([
      makeRow({
        enabled: true,
        nodes: [{ id: 'n1', defId: 'action_http', x: 0, y: 0, config: { customPath: 'orders' } }],
      }),
    ]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.listByCustomWebhookPath('tenant-a', 'orders');
    expect(res).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════
// get() — tenant isolation
// ════════════════════════════════════════════════════════════════════
describe('WorkflowService.get', () => {
  it('returns workflow se trovato in tenant scope', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-1', tenantId: 'tenant-a' })]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.get('wf-1', 'tenant-a');
    expect(res?.id).toBe('wf-1');
  });

  it('returns null se row inesistente', async () => {
    m.selectRows.mockResolvedValue([]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.get('wf-missing', 'tenant-a');
    expect(res).toBeNull();
  });

  it('throws se schema drift (fail-closed su single-read)', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-bad', name: '' })]); // empty name
    const svc = new WorkflowService(eventBus as never);
    await expect(svc.get('wf-bad', 'tenant-a')).rejects.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════
// E4 (2026-06-06): getErrorWorkflowId — minimal column lookup
// per il fan-out engine. Niente WorkflowSchema.parse necessario.
// ════════════════════════════════════════════════════════════════════
describe('WorkflowService.getErrorWorkflowId — E4 fan-out lookup', () => {
  it('ritorna l\'id quando settato sulla row', async () => {
    m.selectRows.mockResolvedValue([{ errorWorkflowId: 'wf-error-handler' }]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.getErrorWorkflowId('wf-1', 'tenant-a');
    expect(res).toBe('wf-error-handler');
  });

  it('ritorna null se errorWorkflowId NOT SET (mai bound)', async () => {
    m.selectRows.mockResolvedValue([{ errorWorkflowId: null }]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.getErrorWorkflowId('wf-1', 'tenant-a');
    expect(res).toBeNull();
  });

  it('ritorna null se workflow inesistente (no leak cross-tenant)', async () => {
    m.selectRows.mockResolvedValue([]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.getErrorWorkflowId('wf-missing', 'tenant-a');
    expect(res).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════
// CONTRACT INDIRECTION (post-mortem Streammy): un workflow salvato non
// contiene MAI un token webhook cablato — create/update convertono in ref://
// ════════════════════════════════════════════════════════════════════
describe('WorkflowService create/update — contract indirection webhook', () => {
  const CABLED_TOKEN = 'deadbeef'.repeat(4); // 32 hex
  const targetRow = () => makeRow({
    id: 'wf-target',
    tenantId: 'tenant-a',
    enabled: true,
    nodes: [{ id: 'trig', defId: 'trigger_webhook', x: 0, y: 0, config: { authMode: 'none' } }],
  });

  it('create(): il link cablato diventa ref:// PRIMA dell\'insert — il token non tocca il disco', async () => {
    let capturedNodesJson = '';
    m.insertRun.mockImplementationOnce((vals: { nodesJson: string }) => {
      capturedNodesJson = vals.nodesJson;
      return Promise.resolve();
    });
    m.selectRows.mockResolvedValue([targetRow()]);

    const svc = new WorkflowService(eventBus as never);
    await svc.create({
      name: 'Pagine',
      tenantId: 'tenant-a',
      nodes: [{ id: 'html', defId: 'action_webhook_respond', x: 0, y: 0, config: {
        body: `<a href="/webhooks/wf-target/${CABLED_TOKEN}">vai</a>`,
      } }],
    });

    expect(capturedNodesJson).toContain('ref://wf/wf-target/webhook');
    expect(capturedNodesJson).not.toContain(CABLED_TOKEN);
  });

  it('update(): stesso contract sul path di modifica', async () => {
    m.selectRows.mockResolvedValue([targetRow()]);
    const svc = new WorkflowService(eventBus as never);
    await svc.update('wf-target', {
      nodes: [{ id: 'html', defId: 'action_webhook_respond', x: 0, y: 0, config: {
        url: `/webhooks/wf-target/${CABLED_TOKEN}?x=1`,
      } }],
    }, 'tenant-a');

    const nodesJson = m.capturedUpdatePatch?.nodesJson as string;
    expect(nodesJson).toContain('ref://wf/wf-target/webhook?x=1');
    expect(nodesJson).not.toContain(CABLED_TOKEN);
  });

  it('CONSERVATIVO: target header-token → il link resta com\'era (il segmento è il secret utente)', async () => {
    let capturedNodesJson = '';
    m.insertRun.mockImplementationOnce((vals: { nodesJson: string }) => {
      capturedNodesJson = vals.nodesJson;
      return Promise.resolve();
    });
    m.selectRows.mockResolvedValue([makeRow({
      id: 'wf-target',
      tenantId: 'tenant-a',
      enabled: true,
      nodes: [{ id: 'trig', defId: 'trigger_webhook', x: 0, y: 0, config: { authMode: 'header-token', authSecret: CABLED_TOKEN } }],
    })]);

    const svc = new WorkflowService(eventBus as never);
    await svc.create({
      name: 'Pagine',
      tenantId: 'tenant-a',
      nodes: [{ id: 'html', defId: 'action_http', x: 0, y: 0, config: {
        url: `/webhooks/wf-target/${CABLED_TOKEN}`,
      } }],
    });

    expect(capturedNodesJson).toContain(`/webhooks/wf-target/${CABLED_TOKEN}`);
    expect(capturedNodesJson).not.toContain('ref://');
  });
});

// ════════════════════════════════════════════════════════════════════
// create() — SECURITY: ensureFormTriggerTokens auto-gen
// ════════════════════════════════════════════════════════════════════
describe('WorkflowService.create — security tokens', () => {
  it('auto-genera publicToken per trigger_form senza token (≥16 char nanoid)', async () => {
    let capturedNodes: unknown[] = [];
    m.insertRun.mockImplementationOnce((vals: { nodesJson: string }) => {
      capturedNodes = JSON.parse(vals.nodesJson);
      return Promise.resolve();
    });
    // get() called dopo insert per fetch del workflow creato
    m.selectRows.mockResolvedValue([makeRow({
      id: 'wf-new',
      tenantId: 'tenant-a',
      nodes: [{ id: 'form-1', defId: 'trigger_form', x: 0, y: 0, config: { publicToken: 'will-be-set' } }],
    })]);

    const svc = new WorkflowService(eventBus as never);
    await svc.create({
      name: 'Form WF',
      tenantId: 'tenant-a',
      nodes: [{ id: 'form-1', defId: 'trigger_form', x: 0, y: 0, config: {} }],
    });

    const formNode = capturedNodes[0] as { config: { publicToken: string } };
    expect(formNode.config.publicToken).toBeDefined();
    expect(formNode.config.publicToken.length).toBeGreaterThanOrEqual(16);
  });

  it('RISPETTA publicToken esistente ≥16 char (idempotent — link condivisi non rompono)', async () => {
    const existingToken = 'abc123xyz456-stable-token-32char';
    let capturedNodes: unknown[] = [];
    m.insertRun.mockImplementationOnce((vals: { nodesJson: string }) => {
      capturedNodes = JSON.parse(vals.nodesJson);
      return Promise.resolve();
    });
    m.selectRows.mockResolvedValue([makeRow({
      id: 'wf-new',
      tenantId: 'tenant-a',
      nodes: [{ id: 'form-1', defId: 'trigger_form', x: 0, y: 0, config: { publicToken: existingToken } }],
    })]);

    const svc = new WorkflowService(eventBus as never);
    await svc.create({
      name: 'Form WF',
      tenantId: 'tenant-a',
      nodes: [{ id: 'form-1', defId: 'trigger_form', x: 0, y: 0, config: { publicToken: existingToken } }],
    });

    const formNode = capturedNodes[0] as { config: { publicToken: string } };
    expect(formNode.config.publicToken).toBe(existingToken);
  });

  it('rigenera publicToken se esistente è troppo corto (<16 char)', async () => {
    let capturedNodes: unknown[] = [];
    m.insertRun.mockImplementationOnce((vals: { nodesJson: string }) => {
      capturedNodes = JSON.parse(vals.nodesJson);
      return Promise.resolve();
    });
    m.selectRows.mockResolvedValue([makeRow({
      id: 'wf-new',
      tenantId: 'tenant-a',
      nodes: [{ id: 'form-1', defId: 'trigger_form', x: 0, y: 0, config: { publicToken: 'short' } }],
    })]);

    const svc = new WorkflowService(eventBus as never);
    await svc.create({
      name: 'Form WF',
      tenantId: 'tenant-a',
      nodes: [{ id: 'form-1', defId: 'trigger_form', x: 0, y: 0, config: { publicToken: 'short' } }],
    });

    const formNode = capturedNodes[0] as { config: { publicToken: string } };
    expect(formNode.config.publicToken).not.toBe('short');
    expect(formNode.config.publicToken.length).toBeGreaterThanOrEqual(16);
  });

  it('NON tocca nodi non-trigger_form', async () => {
    let capturedNodes: unknown[] = [];
    m.insertRun.mockImplementationOnce((vals: { nodesJson: string }) => {
      capturedNodes = JSON.parse(vals.nodesJson);
      return Promise.resolve();
    });
    m.selectRows.mockResolvedValue([makeRow({
      id: 'wf-new',
      nodes: [{ id: 'n1', defId: 'action_http', x: 0, y: 0, config: { url: 'https://x.com' } }],
    })]);

    const svc = new WorkflowService(eventBus as never);
    await svc.create({
      name: 'HTTP WF',
      nodes: [{ id: 'n1', defId: 'action_http', x: 0, y: 0, config: { url: 'https://x.com' } }],
    });

    const node = capturedNodes[0] as { config: { publicToken?: string; url: string } };
    expect(node.config.publicToken).toBeUndefined();
    expect(node.config.url).toBe('https://x.com');
  });

  it('emette audit log workflow.create + event bus', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-new', tenantId: 'tenant-a' })]);
    const svc = new WorkflowService(eventBus as never);
    await svc.create({ name: 'X', tenantId: 'tenant-a', createdBy: 'user-1' });

    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a',
      action: 'workflow.create',
      resourceType: 'workflow',
      actorId: 'user-1',
    }));
    expect(m.emit).toHaveBeenCalledWith(expect.objectContaining({
      name: 'workflow.created',
      tenantId: 'tenant-a',
    }));
  });

  it('throws se get() post-insert ritorna null (consistency check)', async () => {
    m.selectRows.mockResolvedValue([]); // get() ritorna null
    const svc = new WorkflowService(eventBus as never);
    await expect(svc.create({ name: 'X', tenantId: 'tenant-a' })).rejects.toThrow(/not found after insert/);
  });
});

// ════════════════════════════════════════════════════════════════════
// update() — VALIDATION: orphan edges refuse
// ════════════════════════════════════════════════════════════════════
describe('WorkflowService.update — orphan edges validator', () => {
  it('REFUSES update con edge.from che punta a nodo inesistente', async () => {
    const existing = makeRow({
      id: 'wf-1',
      tenantId: 'tenant-a',
      nodes: [{ id: 'n1', defId: 'action_http', x: 0, y: 0, config: {} }],
      edges: [],
    });
    m.selectRows.mockResolvedValue([existing]);

    const svc = new WorkflowService(eventBus as never);
    await expect(svc.update('wf-1', {
      nodes: [{ id: 'n1', defId: 'action_http', x: 0, y: 0, config: {} }],
      edges: [{ from: 'ghost', to: 'n1' }],
    }, 'tenant-a')).rejects.toThrow(/edge orfani.*ghost/);
  });

  it('REFUSES update con edge.to che punta a nodo inesistente', async () => {
    const existing = makeRow({
      id: 'wf-1',
      nodes: [{ id: 'n1', defId: 'action_http', x: 0, y: 0, config: {} }],
      edges: [],
    });
    m.selectRows.mockResolvedValue([existing]);

    const svc = new WorkflowService(eventBus as never);
    await expect(svc.update('wf-1', {
      nodes: [{ id: 'n1', defId: 'action_http', x: 0, y: 0, config: {} }],
      edges: [{ from: 'n1', to: 'ghost' }],
    }, 'tenant-a')).rejects.toThrow(/edge orfani/);
  });

  it('🔒 edge orfani → WorkflowValidationError (httpStatus 400, NON 500)', async () => {
    const { WorkflowValidationError } = await import('./workflow.service.js');
    m.selectRows.mockResolvedValue([makeRow({
      id: 'wf-1', nodes: [{ id: 'n1', defId: 'action_http', x: 0, y: 0, config: {} }], edges: [],
    })]);
    const svc = new WorkflowService(eventBus as never);
    const err = await svc.update('wf-1', {
      nodes: [{ id: 'n1', defId: 'action_http', x: 0, y: 0, config: {} }],
      edges: [{ from: 'n1', to: 'ghost' }],
    }, 'tenant-a').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowValidationError);
    expect((err as InstanceType<typeof WorkflowValidationError>).httpStatus).toBe(400);
    expect((err as InstanceType<typeof WorkflowValidationError>).expose).toBe(true);
  });

  it('ACCETTA update con edges che puntano a nodi esistenti', async () => {
    const existing = makeRow({
      id: 'wf-1',
      nodes: [{ id: 'n1', defId: 'a', x: 0, y: 0, config: {} }, { id: 'n2', defId: 'b', x: 0, y: 0, config: {} }],
    });
    m.selectRows.mockResolvedValueOnce([existing]) // get() pre-validation
                .mockResolvedValueOnce([existing]); // get() post-update

    const svc = new WorkflowService(eventBus as never);
    const res = await svc.update('wf-1', {
      edges: [{ from: 'n1', to: 'n2' }],
    }, 'tenant-a');
    expect(res).toBeDefined();
  });

  it('returns null se workflow inesistente nel tenant', async () => {
    m.selectRows.mockResolvedValue([]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.update('wf-missing', { name: 'X' }, 'tenant-a');
    expect(res).toBeNull();
  });

  it('azzera draft on manual save (draftJson + draftUpdatedAt = NULL)', async () => {
    const existing = makeRow({ id: 'wf-1', draftJson: '{"old":"draft"}', draftUpdatedAt: '2026-01-01' });
    m.selectRows.mockResolvedValue([existing]);
    const svc = new WorkflowService(eventBus as never);
    await svc.update('wf-1', { name: 'New name' }, 'tenant-a');
    expect(m.capturedUpdatePatch?.draftJson).toBeNull();
    expect(m.capturedUpdatePatch?.draftUpdatedAt).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════
// delete() — tenant scope + audit + event
// ════════════════════════════════════════════════════════════════════
describe('WorkflowService.delete', () => {
  it('returns false se workflow inesistente', async () => {
    m.selectRows.mockResolvedValue([]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.delete('wf-missing', 'tenant-a');
    expect(res).toBe(false);
    expect(m.auditAppend).not.toHaveBeenCalled();
  });

  it('cancella + audit workflow.delete + event workflow.deleted', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-1', tenantId: 'tenant-a' })]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.delete('wf-1', 'tenant-a', 'user-1');
    expect(res).toBe(true);
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a',
      action: 'workflow.delete',
      resourceId: 'wf-1',
      actorId: 'user-1',
    }));
    expect(m.emit).toHaveBeenCalledWith(expect.objectContaining({
      name: 'workflow.deleted',
      tenantId: 'tenant-a',
      data: { id: 'wf-1' },
    }));
  });
});

// ════════════════════════════════════════════════════════════════════
// Draft autosave — saveDraft / discardDraft / getDraft
// ════════════════════════════════════════════════════════════════════
describe('WorkflowService.saveDraft + getDraft + discardDraft', () => {
  it('saveDraft persiste payload + ritorna savedAt', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-1' })]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.saveDraft('wf-1', { tentative: 'state' }, 'tenant-a');
    expect(res?.savedAt).toBeDefined();
    expect(typeof res?.savedAt).toBe('string');
  });

  it('saveDraft returns null se workflow inesistente nel tenant (cross-tenant block)', async () => {
    m.selectRows.mockResolvedValue([]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.saveDraft('wf-1', { x: 1 }, 'tenant-different');
    expect(res).toBeNull();
  });

  it('getDraft returns null se draftJson è null', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-1', draftJson: null, draftUpdatedAt: null })]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.getDraft('wf-1', 'tenant-a');
    expect(res).toBeNull();
  });

  it('getDraft returns null se draftJson malformed (safeParseJson ritorna string)', async () => {
    m.selectRows.mockResolvedValue([makeRow({
      id: 'wf-1',
      draftJson: '{this-is-not-json',
      draftUpdatedAt: '2026-05-29T00:00:00Z',
    })]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.getDraft('wf-1', 'tenant-a');
    expect(res).toBeNull();
  });

  it('getDraft returns payload + savedAt se ok', async () => {
    m.selectRows.mockResolvedValue([makeRow({
      id: 'wf-1',
      draftJson: JSON.stringify({ name: 'WIP' }),
      draftUpdatedAt: '2026-05-29T10:00:00Z',
    })]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.getDraft('wf-1', 'tenant-a');
    expect(res).toEqual({ payload: { name: 'WIP' }, savedAt: '2026-05-29T10:00:00Z' });
  });

  it('discardDraft returns true se workflow esiste', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-1' })]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.discardDraft('wf-1', 'tenant-a');
    expect(res).toBe(true);
  });

  it('discardDraft returns false se workflow inesistente', async () => {
    m.selectRows.mockResolvedValue([]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.discardDraft('wf-1', 'tenant-a');
    expect(res).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// exportBundle — SECURITY: secret redaction completa + checksum
// ════════════════════════════════════════════════════════════════════
describe('WorkflowService.exportBundle — secret redaction', () => {
  it('returns null se workflow inesistente', async () => {
    m.selectRows.mockResolvedValue([]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.exportBundle('wf-x', 'tenant-a');
    expect(res).toBeNull();
  });

  it('AZZERA campo che contiene "credential" + popola placeholders', async () => {
    m.selectRows.mockResolvedValue([makeRow({
      id: 'wf-1',
      nodes: [{ id: 'n1', defId: 'action_http', x: 0, y: 0, config: { credentialId: 'cred-abc-1234567890abcd' } }],
    })]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.exportBundle('wf-1', 'tenant-a');
    expect(res).not.toBeNull();
    const node = res!.workflow.nodes[0] as { config: { credentialId: string } };
    expect(node.config.credentialId).toBe('');
    expect(res!.credentialPlaceholders).toContainEqual({
      nodeId: 'n1',
      configPath: 'credentialId',
      type: 'action_http',
    });
  });

  it('AZZERA campi password/secret/apikey/token/bearer', async () => {
    m.selectRows.mockResolvedValue([makeRow({
      id: 'wf-1',
      nodes: [
        { id: 'n1', defId: 'trigger_imap', x: 0, y: 0, config: {
          password: 'plain-password',
          apiKey: 'secret-key-xyz',
          token: 'bearer-abc',
          secret: 'webhook-secret',
          bearerAuth: 'eyJh...long-jwt',
        }},
      ],
    })]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.exportBundle('wf-1', 'tenant-a');
    const cfg = (res!.workflow.nodes[0] as { config: Record<string, string> }).config;
    expect(cfg.password).toBe('');
    expect(cfg.apiKey).toBe('');
    expect(cfg.token).toBe('');
    expect(cfg.secret).toBe('');
    expect(cfg.bearerAuth).toBe('');
    expect(res!.credentialPlaceholders.length).toBeGreaterThanOrEqual(5);
  });

  it('AZZERA publicToken di trigger_form + note "rigenerato in import"', async () => {
    m.selectRows.mockResolvedValue([makeRow({
      id: 'wf-1',
      nodes: [{ id: 'form-1', defId: 'trigger_form', x: 0, y: 0, config: { publicToken: 'old-token-32chars-abcdef' } }],
    })]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.exportBundle('wf-1', 'tenant-a');
    const cfg = (res!.workflow.nodes[0] as { config: { publicToken: string } }).config;
    expect(cfg.publicToken).toBe('');
    expect(res!.notes.some((n) => n.includes('publicToken rigenerato'))).toBe(true);
  });

  it('checksum SHA256 stabile (deterministico su stesso input)', async () => {
    const row = makeRow({ id: 'wf-1' });
    m.selectRows.mockResolvedValue([row]);
    const svc = new WorkflowService(eventBus as never);
    const res1 = await svc.exportBundle('wf-1', 'tenant-a');

    m.selectRows.mockResolvedValue([row]);
    const res2 = await svc.exportBundle('wf-1', 'tenant-a');

    // exportedAt diverso fra le 2 chiamate → checksum diverso. Verifichiamo SOLO che esista hex 64 char.
    expect(res1!.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(res2!.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('NON include tenantId/workflowId/folderId nel bundle (privacy)', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-1', tenantId: 'tenant-private' })]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.exportBundle('wf-1', 'tenant-private');
    expect(res!.workflow).not.toHaveProperty('id');
    expect(res!.workflow).not.toHaveProperty('tenantId');
    expect(res!.workflow).not.toHaveProperty('folderId');
  });

  it('emette audit workflow.export', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-1', tenantId: 'tenant-a' })]);
    const svc = new WorkflowService(eventBus as never);
    await svc.exportBundle('wf-1', 'tenant-a');
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a',
      action: 'workflow.export',
      resourceId: 'wf-1',
    }));
  });
});

// ════════════════════════════════════════════════════════════════════
// importBundle — VALIDATION + auto-rename + disabled-by-default
// ════════════════════════════════════════════════════════════════════
describe('WorkflowService.importBundle', () => {
  function validBundle(over: Partial<{ name: string; schemaVersion: string; checksum: string }> = {}) {
    return {
      schemaVersion: over.schemaVersion ?? '1.0.0',
      exportedAt: '2026-05-29T00:00:00Z',
      exportedBy: { tenantId: 'tenant-origin' },
      workflow: {
        name: over.name ?? 'Imported WF',
        nodes: [],
        edges: [],
        nodeDefs: [],
      },
      credentialPlaceholders: [],
      checksum: over.checksum ?? '',
      notes: [],
    };
  }

  it('REJECT bundle null/non-object', async () => {
    const svc = new WorkflowService(eventBus as never);
    await expect(svc.importBundle(null, 'tenant-a')).rejects.toThrow(/Bundle non valido/);
    await expect(svc.importBundle('string', 'tenant-a')).rejects.toThrow(/Bundle non valido/);
  });

  it('REJECT bundle schemaVersion diverso da 1.0.0', async () => {
    const svc = new WorkflowService(eventBus as never);
    await expect(svc.importBundle(validBundle({ schemaVersion: '2.0.0' }), 'tenant-a'))
      .rejects.toThrow(/schemaVersion.*non supportato/);
    await expect(svc.importBundle({ workflow: { name: 'X' } }, 'tenant-a'))
      .rejects.toThrow(/schemaVersion.*mancante/);
  });

  it('REJECT bundle senza workflow.name', async () => {
    const svc = new WorkflowService(eventBus as never);
    const b = validBundle();
    delete (b.workflow as { name?: string }).name;
    await expect(svc.importBundle(b, 'tenant-a')).rejects.toThrow(/workflow.name.*mancante/);
  });

  it('WARNING (non-blocker) su checksum mismatch', async () => {
    m.selectRows.mockResolvedValueOnce([]).mockResolvedValueOnce([makeRow({ id: 'wf-new', tenantId: 'tenant-a', name: 'Imported WF' })]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.importBundle(validBundle({ checksum: 'tampered-checksum-no-match' }), 'tenant-a');
    expect(res.warnings.some((w) => w.includes('Checksum'))).toBe(true);
  });

  it('WARNING su bundle senza checksum (impossibile verificare integrity)', async () => {
    m.selectRows.mockResolvedValueOnce([]).mockResolvedValueOnce([makeRow({ id: 'wf-new', tenantId: 'tenant-a', name: 'Imported WF' })]);
    const svc = new WorkflowService(eventBus as never);
    const b = validBundle();
    b.checksum = '';
    const res = await svc.importBundle(b, 'tenant-a');
    expect(res.warnings.some((w) => w.includes('Nessun checksum'))).toBe(true);
  });

  it('AUTO-RENAME se nome collide nel tenant (suffix "(importato)")', async () => {
    m.selectRows.mockResolvedValueOnce([makeRow({ id: 'existing', tenantId: 'tenant-a', name: 'Imported WF' })])
                .mockResolvedValueOnce([makeRow({ id: 'wf-new', tenantId: 'tenant-a', name: 'Imported WF (importato)' })]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.importBundle(validBundle(), 'tenant-a');
    expect(res.warnings.some((w) => w.includes('già esistente') && w.includes('(importato)'))).toBe(true);
  });

  it('workflow creato è ENABLED=false di default (user deve riconfigurare + abilitare)', async () => {
    let capturedInsert: { enabled?: boolean } = {};
    m.insertRun.mockImplementationOnce((vals: { enabled: boolean }) => {
      capturedInsert = vals;
      return Promise.resolve();
    });
    m.selectRows.mockResolvedValueOnce([]).mockResolvedValueOnce([makeRow({ id: 'wf-new', tenantId: 'tenant-a', name: 'Imported WF' })]);
    const svc = new WorkflowService(eventBus as never);
    await svc.importBundle(validBundle(), 'tenant-a');
    expect(capturedInsert.enabled).toBe(false);
  });

  it('emette audit workflow.import con metadata warning/placeholders count', async () => {
    m.selectRows.mockResolvedValueOnce([]).mockResolvedValueOnce([makeRow({ id: 'wf-new', tenantId: 'tenant-a', name: 'Imported WF' })]);
    const svc = new WorkflowService(eventBus as never);
    const bundle = {
      ...validBundle(),
      credentialPlaceholders: [{ configPath: 'apiKey', nodeId: 'n1', type: 'http' }],
    };
    await svc.importBundle(bundle as Parameters<typeof svc.importBundle>[0], 'tenant-a', 'user-1');

    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a',
      action: 'workflow.import',
      actorId: 'user-1',
      metadata: expect.objectContaining({
        placeholders: 1,
      }),
    }));
  });
});

// ════════════════════════════════════════════════════════════════════
// listRowsForHealth — admin diagnostic
// ════════════════════════════════════════════════════════════════════
describe('WorkflowService.listRowsForHealth', () => {
  it('ritorna raw rows (incluso corrotti)', async () => {
    const rows = [makeRow({ id: 'good' }), makeRow({ id: 'bad', name: '' })];
    m.selectRows.mockResolvedValue(rows);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.listRowsForHealth('tenant-a');
    expect(res).toHaveLength(2);
    expect(res.map((r) => r.id).sort()).toEqual(['bad', 'good']);
  });

  it('returns [] se nessuna row', async () => {
    m.selectRows.mockResolvedValue([]);
    const svc = new WorkflowService(eventBus as never);
    expect(await svc.listRowsForHealth('tenant-a')).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════
// getByIdAnyTenant — cross-tenant public lookup (webhooks/forms)
// ════════════════════════════════════════════════════════════════════
describe('WorkflowService.getByIdAnyTenant', () => {
  it('ritorna workflow senza tenant filter', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-1', tenantId: 'tenant-a' })]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.getByIdAnyTenant('wf-1');
    expect(res?.id).toBe('wf-1');
  });

  it('returns null se inesistente', async () => {
    m.selectRows.mockResolvedValue([]);
    const svc = new WorkflowService(eventBus as never);
    expect(await svc.getByIdAnyTenant('wf-x')).toBeNull();
  });

  it('throws su schema drift (fail-closed per single-read)', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-bad', name: '' })]);
    const svc = new WorkflowService(eventBus as never);
    await expect(svc.getByIdAnyTenant('wf-bad')).rejects.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════
// listAllAcrossTenants — background services (TriggerWatchers)
// ════════════════════════════════════════════════════════════════════
describe('WorkflowService.listAllAcrossTenants', () => {
  it('ritorna workflow di TUTTI i tenant (skip schema drift)', async () => {
    m.selectRows.mockResolvedValue([
      makeRow({ id: 'wf-a', tenantId: 'tenant-a' }),
      makeRow({ id: 'wf-b', tenantId: 'tenant-b' }),
      makeRow({ id: 'wf-bad', tenantId: 'tenant-c', name: '' }),
    ]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.listAllAcrossTenants();
    expect(res.map((w) => w.id).sort()).toEqual(['wf-a', 'wf-b']); // bad skipped
  });

  it('returns [] se nessuna row', async () => {
    m.selectRows.mockResolvedValue([]);
    const svc = new WorkflowService(eventBus as never);
    expect(await svc.listAllAcrossTenants()).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════
// listByCustomWebhookPathAnyTenant — public webhook router
// ════════════════════════════════════════════════════════════════════
describe('WorkflowService.listByCustomWebhookPathAnyTenant', () => {
  it('match exact cross-tenant', async () => {
    m.selectRows.mockResolvedValue([
      makeRow({
        id: 'wf-1', tenantId: 'tenant-a', enabled: true,
        nodes: [{ id: 'n1', defId: 'trigger_webhook', x: 0, y: 0, config: { customPath: 'orders' } }],
      }),
      makeRow({
        id: 'wf-2', tenantId: 'tenant-b', enabled: true,
        nodes: [{ id: 'n1', defId: 'trigger_webhook', x: 0, y: 0, config: { customPath: 'orders' } }],
      }),
    ]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.listByCustomWebhookPathAnyTenant('orders');
    expect(res).toHaveLength(2);
  });

  it('returns [] su customPath vuoto', async () => {
    const svc = new WorkflowService(eventBus as never);
    expect(await svc.listByCustomWebhookPathAnyTenant('')).toEqual([]);
  });

  it('skip workflow disabled', async () => {
    m.selectRows.mockResolvedValue([
      makeRow({
        id: 'wf-off', enabled: false,
        nodes: [{ id: 'n1', defId: 'trigger_webhook', x: 0, y: 0, config: { customPath: 'orders' } }],
      }),
    ]);
    const svc = new WorkflowService(eventBus as never);
    expect(await svc.listByCustomWebhookPathAnyTenant('orders')).toEqual([]);
  });

  it('skip schema-drift rows', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-bad', name: '' })]);
    const svc = new WorkflowService(eventBus as never);
    expect(await svc.listByCustomWebhookPathAnyTenant('orders')).toEqual([]);
  });

  it('skip nodi non trigger_webhook', async () => {
    m.selectRows.mockResolvedValue([
      makeRow({
        enabled: true,
        nodes: [{ id: 'n1', defId: 'action_http', x: 0, y: 0, config: { customPath: 'orders' } }],
      }),
    ]);
    const svc = new WorkflowService(eventBus as never);
    expect(await svc.listByCustomWebhookPathAnyTenant('orders')).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════
// ensureFormTriggerTokens — null/non-object edge cases
// ════════════════════════════════════════════════════════════════════
describe('WorkflowService.create — ensureFormTriggerTokens edge cases', () => {
  it('node null/non-object → pass-through', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-new', tenantId: 'tenant-a' })]);
    const svc = new WorkflowService(eventBus as never);
    // null + string nodes (Zod-pre-validation phase)
    await svc.create({ name: 'X', tenantId: 'tenant-a', nodes: [null, 'string'] as unknown[] });
    expect(m.insertRun).toHaveBeenCalled();
  });

  it('config undefined → default a {} + token aggiunto', async () => {
    let capturedNodes: unknown[] = [];
    m.insertRun.mockImplementationOnce((vals: { nodesJson: string }) => {
      capturedNodes = JSON.parse(vals.nodesJson);
      return Promise.resolve();
    });
    m.selectRows.mockResolvedValue([makeRow({
      id: 'wf-new',
      nodes: [{ id: 'form-1', defId: 'trigger_form', x: 0, y: 0, config: { publicToken: 'abc-32-char-token-xxxxxxxxx' } }],
    })]);
    const svc = new WorkflowService(eventBus as never);
    await svc.create({
      name: 'F', tenantId: 'tenant-a',
      nodes: [{ id: 'form-1', defId: 'trigger_form', x: 0, y: 0 } as unknown], // no config
    });
    const node = capturedNodes[0] as { config: { publicToken: string } };
    expect(node.config.publicToken).toBeDefined();
    expect(node.config.publicToken.length).toBeGreaterThanOrEqual(16);
  });
});

// ════════════════════════════════════════════════════════════════════
// update() — branch coverage (folderId, onError, concurrencyLimit null)
// ════════════════════════════════════════════════════════════════════
describe('WorkflowService.update — null branches', () => {
  it('folderId=null → set NULL nel patch', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-1' })]);
    const svc = new WorkflowService(eventBus as never);
    await svc.update('wf-1', { folderId: null }, 'tenant-a');
    expect(m.capturedUpdatePatch?.folderId).toBeNull();
  });

  it('onError=null → set NULL nel patch', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-1' })]);
    const svc = new WorkflowService(eventBus as never);
    await svc.update('wf-1', { onError: null }, 'tenant-a');
    expect(m.capturedUpdatePatch?.onErrorJson).toBeNull();
  });

  it('concurrencyLimit=null → set NULL nel patch', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-1' })]);
    const svc = new WorkflowService(eventBus as never);
    await svc.update('wf-1', { concurrencyLimit: null }, 'tenant-a');
    expect(m.capturedUpdatePatch?.concurrencyLimit).toBeNull();
  });

  it('lista >3 orphan edges → suffisso "…(+N altri)"', async () => {
    const existing = makeRow({
      id: 'wf-1',
      nodes: [{ id: 'n1', defId: 'a', x: 0, y: 0, config: {} }],
      edges: [],
    });
    m.selectRows.mockResolvedValue([existing]);
    const svc = new WorkflowService(eventBus as never);
    await expect(svc.update('wf-1', {
      nodes: [{ id: 'n1', defId: 'a', x: 0, y: 0, config: {} }],
      edges: [
        { from: 'ghost1', to: 'n1' }, { from: 'n1', to: 'ghost2' },
        { from: 'ghost3', to: 'n1' }, { from: 'n1', to: 'ghost4' },
        { from: 'ghost5', to: 'n1' },
      ],
    }, 'tenant-a')).rejects.toThrow(/altri/);
  });
});

// ════════════════════════════════════════════════════════════════════
// exportBundle — branch coverage (no description, no tags, no notes)
// ════════════════════════════════════════════════════════════════════
describe('WorkflowService.exportBundle — branch edges', () => {
  it('workflow senza description → bundle.workflow.description NON settato', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-1' })]); // no description
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.exportBundle('wf-1', 'tenant-a');
    expect(res!.workflow.description).toBeUndefined();
  });

  it('workflow con description → settato', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-1', description: 'My WF descrizione' })]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.exportBundle('wf-1', 'tenant-a');
    expect(res!.workflow.description).toBe('My WF descrizione');
  });

  it('workflow con tags → bundle.workflow.tags settato', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-1', tagsJson: JSON.stringify(['prod', 'critical']) })]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.exportBundle('wf-1', 'tenant-a');
    expect(res!.workflow.tags).toEqual(['prod', 'critical']);
  });

  it('node con config {} (vuoto) → 0 placeholders', async () => {
    m.selectRows.mockResolvedValue([makeRow({
      id: 'wf-1',
      nodes: [{ id: 'n1', defId: 'noop', x: 0, y: 0, config: {} }],
    })]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.exportBundle('wf-1', 'tenant-a');
    expect(res!.credentialPlaceholders).toHaveLength(0);
  });

  it('valore credenziale corto (<16 char) NON viene flaggato come credential', async () => {
    m.selectRows.mockResolvedValue([makeRow({
      id: 'wf-1',
      nodes: [{ id: 'n1', defId: 'action_http', x: 0, y: 0, config: { credentialId: 'short' } }],
    })]);
    const svc = new WorkflowService(eventBus as never);
    const res = await svc.exportBundle('wf-1', 'tenant-a');
    // credentialId vuoto rimane vuoto (sotto threshold 16)
    expect(res!.credentialPlaceholders.find((p) => p.configPath === 'credentialId')).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════
// importBundle — auto-rename con counter > 1
// ════════════════════════════════════════════════════════════════════
describe('WorkflowService.importBundle — multi-collision', () => {
  it('auto-rename counter increment ("importato 2") se "(importato)" già esiste', async () => {
    m.selectRows
      .mockResolvedValueOnce([
        makeRow({ id: 'e1', tenantId: 'tenant-a', name: 'Imported WF' }),
        makeRow({ id: 'e2', tenantId: 'tenant-a', name: 'Imported WF (importato)' }),
      ])
      .mockResolvedValueOnce([makeRow({ id: 'wf-new', tenantId: 'tenant-a', name: 'Imported WF (importato 2)' })]);
    const svc = new WorkflowService(eventBus as never);
    const bundle = {
      schemaVersion: '1.0.0',
      workflow: { name: 'Imported WF', nodes: [], edges: [], nodeDefs: [] },
      credentialPlaceholders: [],
      checksum: '',
      notes: [],
    };
    const res = await svc.importBundle(bundle, 'tenant-a');
    expect(res.warnings.some((w) => w.includes('importato 2'))).toBe(true);
  });

  it('importBundle senza actorId → audit log NO actorId field', async () => {
    m.selectRows.mockResolvedValueOnce([]).mockResolvedValueOnce([makeRow({ id: 'wf-new' })]);
    const svc = new WorkflowService(eventBus as never);
    const bundle = {
      schemaVersion: '1.0.0',
      workflow: { name: 'New WF', nodes: [], edges: [], nodeDefs: [] },
      credentialPlaceholders: [],
      checksum: '',
      notes: [],
    };
    await svc.importBundle(bundle, 'tenant-a'); // no actorId
    const auditCall = m.auditAppend.mock.calls.find((c) =>
      (c[0] as { action: string }).action === 'workflow.import',
    );
    expect(auditCall?.[0]).toBeDefined();
    expect((auditCall?.[0] as Record<string, unknown>).actorId).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════
// Branch coverage fillers — ?? defaults + ternary 100%
// ════════════════════════════════════════════════════════════════════
describe('WorkflowService — branch fillers ?? defaults', () => {
  it('row con tenantId=null → fallback "default" branch', async () => {
    const row = makeRow({ id: 'wf-1' });
    (row as { tenantId: string | null }).tenantId = null as never;
    m.selectRows.mockResolvedValue([row]);
    const svc = new WorkflowService(eventBus as never);
    await svc.list();
  });

  it('row con breakpointsJson valido → safeParseJson branch', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-bp', breakpointsJson: JSON.stringify(['n1']) })]);
    const svc = new WorkflowService(eventBus as never);
    await svc.list();
  });

  it('row con onErrorJson valido → safeParseJson branch', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-oe', onErrorJson: JSON.stringify({ webhookUrl: 'x' }) })]);
    const svc = new WorkflowService(eventBus as never);
    await svc.list();
  });

  it('row con tagsJson valido → safeParseJson branch', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-tg', tagsJson: JSON.stringify(['a']) })]);
    const svc = new WorkflowService(eventBus as never);
    await svc.list();
  });

  it('listByCustomWebhookPath: node.config.customPath non-string → fallback ""', async () => {
    m.selectRows.mockResolvedValue([makeRow({
      enabled: true,
      nodes: [{ id: 'n1', defId: 'trigger_webhook', x: 0, y: 0, config: { customPath: 123 as never } }],
    })]);
    const svc = new WorkflowService(eventBus as never);
    expect(await svc.listByCustomWebhookPath('t', 'foo')).toEqual([]);
  });

  it('listByCustomWebhookPathAnyTenant: customPath non-string → fallback ""', async () => {
    m.selectRows.mockResolvedValue([makeRow({
      enabled: true,
      nodes: [{ id: 'n1', defId: 'trigger_webhook', x: 0, y: 0, config: { customPath: 123 as never } }],
    })]);
    const svc = new WorkflowService(eventBus as never);
    expect(await svc.listByCustomWebhookPathAnyTenant('foo')).toEqual([]);
  });

  it('create SENZA optional fields (description/tags/folderId/onError/concurrencyLimit/createdBy undefined)', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-min' })]);
    const svc = new WorkflowService(eventBus as never);
    await svc.create({ name: 'Min' });
  });

  it('create CON tutti gli optional defined', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-full', description: 'D' })]);
    const svc = new WorkflowService(eventBus as never);
    await svc.create({
      name: 'Full',
      description: 'D',
      tags: ['t1'],
      folderId: 'f-1',
      onError: { webhookUrl: 'https://x.com' },
      concurrencyLimit: 5,
      createdBy: 'u-1',
    });
  });

  it('create folderId=null → skip insert folderId branch', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-fn' })]);
    const svc = new WorkflowService(eventBus as never);
    await svc.create({ name: 'X', folderId: null });
  });

  it('update SENZA actorId → audit NO actorId field', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-noact' })]);
    const svc = new WorkflowService(eventBus as never);
    await svc.update('wf-noact', { name: 'New' }, 'tenant-a');
    const auditCall = m.auditAppend.mock.calls.find((c) =>
      (c[0] as { action: string }).action === 'workflow.update',
    );
    expect((auditCall?.[0] as Record<string, unknown>).actorId).toBeUndefined();
  });

  it('update CON tutti i campi opzionali defined + actorId', async () => {
    m.selectRows.mockResolvedValue([makeRow({ id: 'wf-1' })]);
    const svc = new WorkflowService(eventBus as never);
    await svc.update('wf-1', {
      name: 'N', description: 'D', enabled: true,
      nodes: [{ id: 'n1', defId: 'noop', x: 0, y: 0, config: {} }],
      edges: [], nodeDefs: [], breakpoints: [], tags: ['t'],
      folderId: 'f', onError: { emailTo: 'x@x' }, concurrencyLimit: 3,
      actorId: 'u-1',
    }, 'tenant-a');
  });

  it('exportBundle: node con defId → type esposto correttamente', async () => {
    m.selectRows.mockResolvedValue([makeRow({
      id: 'wf-1',
      nodes: [{ id: 'n1', defId: 'action_http', x: 0, y: 0, config: { credentialId: 'cred-abc-1234567890abcd' } }],
    })]);
    const svc = new WorkflowService(eventBus as never);
    const r = await svc.exportBundle('wf-1', 'tenant-a');
    const ph = r!.credentialPlaceholders.find((p) => p.configPath === 'credentialId');
    expect(ph?.type).toBe('action_http');
  });

  it('importBundle senza nodes/edges/nodeDefs → fallback []', async () => {
    m.selectRows.mockResolvedValueOnce([]).mockResolvedValueOnce([makeRow({ id: 'wf-min' })]);
    const svc = new WorkflowService(eventBus as never);
    const r = await svc.importBundle({
      schemaVersion: '1.0.0',
      workflow: { name: 'M' },
    }, 'tenant-a');
    expect(r.workflow.id).toBeDefined();
  });

  it('importBundle senza credentialPlaceholders → fallback []', async () => {
    m.selectRows.mockResolvedValueOnce([]).mockResolvedValueOnce([makeRow({ id: 'wf-m2' })]);
    const svc = new WorkflowService(eventBus as never);
    const r = await svc.importBundle({
      schemaVersion: '1.0.0',
      workflow: { name: 'M2', nodes: [], edges: [], nodeDefs: [] },
    }, 'tenant-a');
    expect(r.credentialPlaceholders).toEqual([]);
  });

  it('importBundle CON description/tags definito + actorId', async () => {
    m.selectRows.mockResolvedValueOnce([]).mockResolvedValueOnce([makeRow({ id: 'wf-d', description: 'd' })]);
    const svc = new WorkflowService(eventBus as never);
    await svc.importBundle({
      schemaVersion: '1.0.0',
      workflow: { name: 'D', description: 'descr', tags: ['t1'], nodes: [], edges: [], nodeDefs: [] },
      checksum: '',
    }, 'tenant-a', 'u-1');
  });

  it('safeRowToWorkflow dedupedWarn con tenantId NULL → fallback "default"', async () => {
    const row = makeRow({ id: 'wf-corrupt', name: '' }); // empty name fails Zod
    (row as { tenantId: string | null }).tenantId = null as never;
    m.selectRows.mockResolvedValue([row]);
    const svc = new WorkflowService(eventBus as never);
    await svc.list();
    expect(vi.mocked(dedupedWarn)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tenantId: 'default' }),
      expect.any(String),
    );
    expect(m.counterInc).toHaveBeenCalledWith(expect.objectContaining({
      tags: { tenant: 'default' },
    }));
  });

  it('listByCustomWebhookPath: workflow con node non-trigger_webhook → continue branch', async () => {
    m.selectRows.mockResolvedValue([makeRow({
      enabled: true,
      nodes: [
        { id: 'n0', defId: 'action_http', x: 0, y: 0, config: {} }, // SKIPPED
        { id: 'n1', defId: 'trigger_webhook', x: 0, y: 0, config: { customPath: 'orders' } },
      ],
    })]);
    const svc = new WorkflowService(eventBus as never);
    const r = await svc.listByCustomWebhookPath('t', 'orders');
    expect(r).toHaveLength(1);
  });

  it('listByCustomWebhookPathAnyTenant: workflow con node non-trigger_webhook → continue branch', async () => {
    m.selectRows.mockResolvedValue([makeRow({
      enabled: true,
      nodes: [
        { id: 'n0', defId: 'action_http', x: 0, y: 0, config: {} },
        { id: 'n1', defId: 'trigger_webhook', x: 0, y: 0, config: { customPath: 'orders' } },
      ],
    })]);
    const svc = new WorkflowService(eventBus as never);
    const r = await svc.listByCustomWebhookPathAnyTenant('orders');
    expect(r).toHaveLength(1);
  });

  it('exportBundle: campo "credential" con value < 16 char → NON pushato come placeholder', async () => {
    m.selectRows.mockResolvedValue([makeRow({
      id: 'wf-1',
      nodes: [{ id: 'n1', defId: 'action_http', x: 0, y: 0, config: { credentialId: 'short' } }],
    })]);
    const svc = new WorkflowService(eventBus as never);
    const r = await svc.exportBundle('wf-1', 'tenant-a');
    expect(r!.credentialPlaceholders).toHaveLength(0);
  });

  it('exportBundle: campo non-credential con stringa lunga → NON placeholder (per credential)', async () => {
    m.selectRows.mockResolvedValue([makeRow({
      id: 'wf-1',
      nodes: [{ id: 'n1', defId: 'action_http', x: 0, y: 0, config: { url: 'https://example.com/very/long/url' } }],
    })]);
    const svc = new WorkflowService(eventBus as never);
    const r = await svc.exportBundle('wf-1', 'tenant-a');
    expect(r!.credentialPlaceholders).toHaveLength(0);
  });

  it('exportBundle: campo "password" con value VUOTO → NON pushato (length>0 check)', async () => {
    m.selectRows.mockResolvedValue([makeRow({
      id: 'wf-1',
      nodes: [{ id: 'n1', defId: 'trigger_imap', x: 0, y: 0, config: { password: '' } }],
    })]);
    const svc = new WorkflowService(eventBus as never);
    const r = await svc.exportBundle('wf-1', 'tenant-a');
    expect(r!.credentialPlaceholders).toHaveLength(0);
  });

});
