/**
 * webhook-ref-migration — test della migrazione boot (caso Streammy).
 *
 * Strategia: normalizzatore e lookup REALI (integrazione), spy chirurgici
 * sui reader del WorkflowService (listAllAcrossTenants / getByIdAnyTenant /
 * listByCustomWebhookPathAnyTenant) + cattura dell'UPDATE Drizzle.
 *
 * Contract:
 *   • i link cablati nei workflow esistenti diventano ref:// (il DB non
 *     contiene più il token morto)
 *   • IDEMPOTENZA: seconda passata = zero write
 *   • zero write sui workflow che non cambiano (no updatedAt bump spurii)
 *   • audit trail per ogni workflow riscritto
 *   • ambiguità customPath → skip onesto, mai indovinare
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  capturedPatches: [] as Record<string, unknown>[],
  auditAppend: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({
    db: {
      update: () => ({
        set: (patch: Record<string, unknown>) => {
          m.capturedPatches.push(patch);
          return { where: () => Promise.resolve() };
        },
      }),
    },
  }),
}));

vi.mock('./audit.service.js', () => ({
  AuditLogService: vi.fn().mockImplementation(() => ({ append: m.auditAppend })),
}));

vi.mock('@/lib/logger.js');

import { runWebhookRefMigration } from './webhook-ref-migration.service.js';
import { WorkflowService } from './workflow.service.js';
import { AuditLogService } from './audit.service.js';
import type { IEventBus } from '@/ports/event-bus.js';

const eventBus = { emit: vi.fn(), on: vi.fn() } as unknown as IEventBus;

const OLD_TOKEN = 'bde9139b'.repeat(4); // 32 hex — il token morto del caso reale

function triggerNode(config: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'trig', defId: 'trigger_webhook', config: { authMode: 'none', ...config }, x: 0, y: 0 };
}

function wfTarget(): Record<string, unknown> {
  return {
    id: 'wf_search', tenantId: 't1', name: 'Search', enabled: true,
    nodes: [triggerNode({ customPath: 'streammy/search' })], edges: [],
  };
}

function wfConsumer(nodes: unknown[]): Record<string, unknown> {
  return { id: 'wf_pages', tenantId: 't1', name: 'Pages', enabled: true, nodes, edges: [] };
}

function cabledNodes(): unknown[] {
  return [{
    id: 'html', defId: 'action_webhook_respond', x: 0, y: 0,
    config: {
      body: `<a href="/webhooks/c/streammy/search/${OLD_TOKEN}">cerca</a> <a href="/webhooks/wf_search/${OLD_TOKEN}">alt</a>`,
    },
  }];
}

function spyReaders(all: Record<string, unknown>[]): void {
  vi.spyOn(WorkflowService.prototype, 'listAllAcrossTenants').mockResolvedValue(all as never);
  vi.spyOn(WorkflowService.prototype, 'getByIdAnyTenant').mockImplementation((async (id: string) =>
    all.find((w) => w.id === id) ?? null) as never);
  vi.spyOn(WorkflowService.prototype, 'listByCustomWebhookPathAnyTenant').mockImplementation((async (path: string) =>
    all.filter((w) => (w.nodes as { defId: string; config: Record<string, unknown> }[])
      .some((n) => n.defId === 'trigger_webhook' && n.config.customPath === path))) as never);
}

beforeEach(() => {
  vi.restoreAllMocks();
  // restoreAllMocks azzera anche l'implementation della factory mockata:
  // il service istanzia AuditLogService a CALL-time → va ri-primata qui.
  vi.mocked(AuditLogService).mockImplementation(() => ({ append: m.auditAppend }) as never);
  m.capturedPatches = [];
  m.auditAppend.mockClear();
});

describe('runWebhookRefMigration', () => {
  it('converte i link cablati in ref:// e NON riscrive i workflow invariati', async () => {
    spyReaders([wfTarget(), wfConsumer(cabledNodes())]);
    const report = await runWebhookRefMigration(eventBus);

    expect(report).toMatchObject({ scanned: 2, workflowsConverted: 1, linksConverted: 2 });
    // UN solo UPDATE: il target non aveva link cablati → intatto.
    expect(m.capturedPatches).toHaveLength(1);
    const nodesJson = m.capturedPatches[0]!.nodesJson as string;
    expect(nodesJson).toContain('ref://wf/wf_search/webhook/c/streammy/search');
    expect(nodesJson).toContain('ref://wf/wf_search/webhook\\">alt'); // link default → ref senza /c/
    expect(nodesJson).not.toContain(OLD_TOKEN); // il token morto è SPARITO dal DB
    // Audit trail del write di sistema.
    expect(m.auditAppend).toHaveBeenCalledTimes(1);
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      action: 'workflow.webhook_links_migrated',
      resourceId: 'wf_pages',
      tenantId: 't1',
    }));
  });

  it('IDEMPOTENZA: sul risultato della prima passata, la seconda non scrive nulla', async () => {
    spyReaders([wfTarget(), wfConsumer(cabledNodes())]);
    await runWebhookRefMigration(eventBus);
    const converted = JSON.parse(m.capturedPatches[0]!.nodesJson as string) as unknown[];

    m.capturedPatches = [];
    m.auditAppend.mockClear();
    vi.restoreAllMocks();
    vi.mocked(AuditLogService).mockImplementation(() => ({ append: m.auditAppend }) as never);
    spyReaders([wfTarget(), wfConsumer(converted)]);
    const report = await runWebhookRefMigration(eventBus);

    expect(report.workflowsConverted).toBe(0);
    expect(report.linksConverted).toBe(0);
    expect(m.capturedPatches).toHaveLength(0);
    expect(m.auditAppend).not.toHaveBeenCalled();
  });

  it('customPath AMBIGUO (2 workflow) → skip onesto, zero write', async () => {
    const twin = { ...wfTarget(), id: 'wf_search_2' };
    spyReaders([wfTarget(), twin, wfConsumer([{
      id: 'html', defId: 'action_webhook_respond', x: 0, y: 0,
      config: { body: `<a href="/webhooks/c/streammy/search/${OLD_TOKEN}">x</a>` },
    }])]);
    const report = await runWebhookRefMigration(eventBus);

    expect(report.workflowsConverted).toBe(0);
    expect(m.capturedPatches).toHaveLength(0);
    expect(report.skipped.length).toBeGreaterThan(0);
  });

  it('nessun workflow: report vuoto, zero write, nessun crash', async () => {
    spyReaders([]);
    const report = await runWebhookRefMigration(eventBus);
    expect(report).toEqual({ scanned: 0, workflowsConverted: 0, linksConverted: 0, skipped: [] });
  });
});
