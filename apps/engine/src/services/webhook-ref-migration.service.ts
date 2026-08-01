/**
 * webhook-ref-migration — migrazione IDEMPOTENTE dei link webhook cablati
 * nei workflow ESISTENTI verso l'indirection `ref://` (post-mortem Streammy).
 *
 * Gira a ogni boot del runtime (main.ts, non-bloccante): la prima passata
 * converte i link storici, le successive sono no-op per costruzione (un ref
 * non matcha i pattern cablati). I workflow che non cambiano NON vengono
 * riscritti (zero write inutili, zero updatedAt bump spurii).
 *
 * Scrive nodesJson DIRETTAMENTE via Drizzle invece di WorkflowService.update():
 * update() azzera il draft autosaved e emette workflow.updated — effetti
 * collaterali sbagliati per una migrazione di sistema. L'audit trail resta:
 * ogni workflow convertito ha un evento `workflow.webhook_links_migrated`.
 *
 * I draft autosaved NON sono migrati qui: vengono normalizzati alla
 * promozione (update() ha la stessa guardia del normalizzatore).
 */

import { eq, and } from 'drizzle-orm';
import { getDatabase } from '@/storage/db.js';
import { workflows } from '@/storage/schema.js';
import { WorkflowService, makeWebhookOwnerLookup } from './workflow.service.js';
import { AuditLogService } from './audit.service.js';
import { normalizeNodesWebhookLinks, defaultSameHosts } from '@/lib/webhook-link-normalizer.js';
import { logger } from '@/lib/logger.js';
import type { IEventBus } from '@/ports/event-bus.js';

export interface WebhookRefMigrationReport {
  /** Workflow scansionati (tutti i tenant del container). */
  scanned: number;
  /** Workflow effettivamente riscritti. */
  workflowsConverted: number;
  /** Occorrenze di link convertite in totale. */
  linksConverted: number;
  /** Link trovati ma lasciati intatti, con motivo (host estraneo, authMode, ambiguità). */
  skipped: string[];
}

export async function runWebhookRefMigration(eventBus: IEventBus): Promise<WebhookRefMigrationReport> {
  const service = new WorkflowService(eventBus);
  const audit = new AuditLogService();
  const lookup = makeWebhookOwnerLookup(service);
  const sameHosts = defaultSameHosts();
  const { db } = getDatabase();

  const all = await service.listAllAcrossTenants();
  const report: WebhookRefMigrationReport = { scanned: all.length, workflowsConverted: 0, linksConverted: 0, skipped: [] };

  for (const wf of all) {
    const { nodes, converted, skipped } = await normalizeNodesWebhookLinks(wf.nodes, lookup, { sameHosts });
    report.skipped.push(...skipped);
    if (converted === 0) continue;

    const tenantId = wf.tenantId ?? 'default';
    await db
      .update(workflows)
      .set({ nodesJson: JSON.stringify(nodes), updatedAt: new Date().toISOString() })
      .where(and(eq(workflows.id, wf.id), eq(workflows.tenantId, tenantId)));

    await audit.append({
      tenantId,
      action: 'workflow.webhook_links_migrated',
      resourceType: 'workflow',
      resourceId: wf.id,
      metadata: { linksConverted: converted },
    });

    report.workflowsConverted += 1;
    report.linksConverted += converted;
    logger.info({ workflowId: wf.id, tenantId, converted }, 'Migrazione webhook-ref: link cablati convertiti in ref://');
  }

  if (report.skipped.length > 0) {
    logger.warn({ skipped: report.skipped }, 'Migrazione webhook-ref: link NON convertibili — restano com\'erano');
  }
  return report;
}
