/**
 * Workflow versioning. On every successful save, the previous snapshot is
 * pushed to workflow_versions with an incrementing version number.
 * Rollback writes the chosen version back to the head and bumps version.
 *
 * Auto-snapshot 25 mag 2026: il service si sottoscrive a `workflow.updated`
 * sul bus eventi e crea snapshot automatici (comment='auto') con dedup:
 *   • Throttle: max 1 snapshot per 30s per workflowId (anti-burst su autosave)
 *   • Skip: se il content è IDENTICO all'ultimo snapshot (no-op save)
 * Senza questo, l'utente perdeva tutte le modifiche fatte tra due click
 * manuali su "Snapshot now" — bug Federico-style.
 */

import { getDatabase } from '@/storage/db.js';
import { WorkflowService } from './workflow.service.js';
import { AuditLogService } from './audit.service.js';
import type { IEventBus } from '@/ports/event-bus.js';
import type { Workflow } from '@flowforge/core-schema';
import { nanoid } from 'nanoid';
import { logger } from '@/lib/logger.js';

interface VersionRow {
  id: string;
  workflow_id: string;
  version_number: number;
  spec_json: string;
  created_at: string;
  created_by: string | null;
  comment: string | null;
}

function ensureVersionsTable(): void {
  const { sqlite } = getDatabase();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workflow_versions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      spec_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT,
      comment TEXT
    );
    CREATE INDEX IF NOT EXISTS workflow_versions_workflow_idx ON workflow_versions(workflow_id, version_number);
  `);
  // Schema evolution N1 (audit 2026-05-29): aggiungi tenant_id se manca.
  // Defense-in-depth contro IDOR — anche se container-per-tenant isola
  // oggi, se domani diventiamo shared runtime questo previene
  // /versions/:id che leak versioni cross-tenant.
  const cols = sqlite.prepare("PRAGMA table_info(workflow_versions)").all() as { name: string }[];
  if (!cols.some((c) => c.name === 'tenant_id')) {
    sqlite.exec(`ALTER TABLE workflow_versions ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
    sqlite.exec(`CREATE INDEX IF NOT EXISTS workflow_versions_tenant_workflow_idx ON workflow_versions(tenant_id, workflow_id, version_number)`);
  }
}

const audit = new AuditLogService();

/**
 * Throttle: l'ultimo timestamp di snapshot auto per workflowId. In-memory
 * (per processo) — single source of truth per il dedup. Sopravvive a
 * tutti gli autosave del browser ma non a restart del runtime: dopo un
 * restart il primo save crea uno snapshot (corretto: traccia il "primo
 * cambio dopo restart" = milestone).
 */
const lastAutoSnapshotAt = new Map<string, number>();
const AUTO_SNAPSHOT_THROTTLE_MS = 30_000; // 30s

export class WorkflowVersionsService {
  private readonly workflows: WorkflowService;
  private static autoSnapshotSubscribed = false;

  constructor(eventBus: IEventBus) {
    this.workflows = new WorkflowService(eventBus);
    ensureVersionsTable();
    // Sottoscrizione singleton (process-wide) al bus eventi. Il primo
    // WorkflowVersionsService che si istanzia registra il listener;
    // i successivi non duplicano (altrimenti N snapshot per N service).
    if (!WorkflowVersionsService.autoSnapshotSubscribed) {
      WorkflowVersionsService.autoSnapshotSubscribed = true;
      eventBus.subscribeTo('workflow.updated', (ev) => {
        // Il publisher emette `{ id, fields }` (vedi workflow.service.ts:400).
        // `id` qui è il workflowId.
        const data = ev.data as { id?: string; actorId?: string } | undefined;
        if (!data?.id) return;
        this.autoSnapshotIfNeeded(data.id, ev.tenantId ?? 'default', data.actorId)
          .catch((err: unknown) => {
            logger.warn({ err, workflowId: data.id }, 'Auto-snapshot fallito');
          });
      });
      logger.info('WorkflowVersionsService: auto-snapshot on workflow.updated attivo');
    }
  }

  /**
   * Snapshot automatico su evento update. Gestisce:
   *   • Throttle: skip se l'ultimo auto-snapshot per quel workflowId
   *     è stato fatto < 30s fa
   *   • Dedup contenuto: skip se il workflow JSON è identico
   *     all'ultimo snapshot (no-op save, es. utente preme Salva senza
   *     aver modificato nulla)
   */
  private async autoSnapshotIfNeeded(workflowId: string, tenantId: string, actorId?: string): Promise<void> {
    // Throttle
    const lastAt = lastAutoSnapshotAt.get(workflowId) ?? 0;
    const now = Date.now();
    if (now - lastAt < AUTO_SNAPSHOT_THROTTLE_MS) return;

    // Recupera il workflow corrente
    const workflow = await this.workflows.get(workflowId, tenantId);
    if (!workflow) return;

    // Dedup contenuto (scoped per tenant — vedi N1)
    const { sqlite } = getDatabase();
    const lastRow = sqlite
      .prepare('SELECT spec_json FROM workflow_versions WHERE workflow_id = ? AND tenant_id = ? ORDER BY version_number DESC LIMIT 1')
      .get(workflowId, tenantId) as { spec_json: string } | undefined;
    if (lastRow) {
      // Confronto stabile via JSON normalizzato (chiavi ordinate non garantito
      // ma stringify produce risultato stabile per gli stessi input).
      const currentJson = JSON.stringify(workflow);
      if (lastRow.spec_json === currentJson) return; // no-op save
    }

    // Crea snapshot
    this.snapshot(workflow, tenantId, actorId, 'auto');
    lastAutoSnapshotAt.set(workflowId, now);
  }

  snapshot(workflow: Workflow, tenantId: string, actorId?: string, comment?: string): { versionId: string; versionNumber: number } {
    const { sqlite } = getDatabase();
    // version_number e\` scoped per (tenant_id, workflow_id) per evitare
    // collisioni cross-tenant (no UNIQUE constraint senza tenant).
    const last = sqlite
      .prepare('SELECT MAX(version_number) as n FROM workflow_versions WHERE workflow_id = ? AND tenant_id = ?')
      .get(workflow.id, tenantId) as { n: number | null };
    const versionNumber = (last.n ?? 0) + 1;
    const id = nanoid();
    sqlite
      .prepare(
        'INSERT INTO workflow_versions (id, workflow_id, tenant_id, version_number, spec_json, created_at, created_by, comment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, workflow.id, tenantId, versionNumber, JSON.stringify(workflow), new Date().toISOString(), actorId ?? null, comment ?? null);
    return { versionId: id, versionNumber };
  }

  list(workflowId: string, tenantId: string, limit = 50): { id: string; versionNumber: number; createdAt: string; createdBy: string | null; comment: string | null }[] {
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare(
        'SELECT id, version_number, created_at, created_by, comment FROM workflow_versions WHERE workflow_id = ? AND tenant_id = ? ORDER BY version_number DESC LIMIT ?',
      )
      .all(workflowId, tenantId, limit) as { id: string; version_number: number; created_at: string; created_by: string | null; comment: string | null }[];
    return rows.map((r) => ({
      id: r.id,
      versionNumber: r.version_number,
      createdAt: r.created_at,
      createdBy: r.created_by,
      comment: r.comment,
    }));
  }

  get(versionId: string, tenantId: string): Workflow | null {
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare('SELECT * FROM workflow_versions WHERE id = ? AND tenant_id = ?')
      .get(versionId, tenantId) as VersionRow | undefined;
    if (!row) return null;
    return JSON.parse(row.spec_json) as Workflow;
  }

  async rollback(workflowId: string, versionId: string, tenantId = 'default', actorId?: string): Promise<Workflow | null> {
    const target = this.get(versionId, tenantId);
    if (target?.id !== workflowId) return null;

    const updateInput: Parameters<WorkflowService['update']>[1] = {
      name: target.name,
      enabled: target.enabled,
      nodes: target.nodes,
      edges: target.edges,
      nodeDefs: target.nodeDefs,
    };
    if (target.description !== undefined) updateInput.description = target.description;
    if (target.breakpoints !== undefined) updateInput.breakpoints = target.breakpoints;
    if (target.tags !== undefined) updateInput.tags = target.tags;
    if (actorId !== undefined) updateInput.actorId = actorId;

    const updated = await this.workflows.update(workflowId, updateInput, tenantId);
    if (!updated) return null;

    this.snapshot(updated, tenantId, actorId, `Rolled back to version ${versionId}`);

    await audit.append({
      tenantId,
      action: 'workflow.rollback',
      resourceType: 'workflow',
      resourceId: workflowId,
      ...(actorId !== undefined ? { actorId } : {}),
      metadata: { versionId },
    });

    return updated;
  }

  diff(versionAId: string, versionBId: string, tenantId: string): { added: string[]; removed: string[]; changed: string[] } | null {
    const a = this.get(versionAId, tenantId);
    const b = this.get(versionBId, tenantId);
    if (!a || !b) return null;
    const aIds = new Set(a.nodes.map((n) => n.id));
    const bIds = new Set(b.nodes.map((n) => n.id));
    const added = [...bIds].filter((id) => !aIds.has(id));
    const removed = [...aIds].filter((id) => !bIds.has(id));
    const changed: string[] = [];
    for (const id of aIds) {
      if (!bIds.has(id)) continue;
      const an = a.nodes.find((n) => n.id === id);
      const bn = b.nodes.find((n) => n.id === id);
      if (JSON.stringify(an) !== JSON.stringify(bn)) changed.push(id);
    }
    return { added, removed, changed };
  }
}
