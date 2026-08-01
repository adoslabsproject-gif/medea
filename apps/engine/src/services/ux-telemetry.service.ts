/**
 * UxTelemetryService — opt-in product analytics on user friction.
 *
 * Tracks "milestone events" in the editor — NOT every click, NOT every
 * keystroke. The goal is signal, not surveillance:
 *
 *   ▸ workflow_created          — user creates a new (empty) workflow
 *   ▸ node_added_unconfigured    — node placed on canvas, required fields still empty after 30s
 *   ▸ run_blocked_validation     — user pressed Esegui but a node had missing required
 *   ▸ welcome_dismissed          — user closed the welcome modal
 *   ▸ tour_completed             — user finished the FirstRunTour
 *   ▸ helpchat_opened            — user opened the HelpChat widget
 *   ▸ wizard_started / finished  — user used the Wizard mode
 *
 * Privacy: no PII (no emails, no names, no message contents). Only event
 * type + opaque tenant/user/workflow ids + small structured metadata.
 *
 * Storage: SQLite table `ux_events`. Retention is the admin's choice —
 * no automatic purge; the table is small (~ N events/user/day).
 *
 * Consumers:
 *   • POST /api/v1/ux/events            ← client tracker fires here
 *   • GET  /api/v1/admin/ux/funnel      ← admin dashboard reads here
 */

import { getDatabase } from '@/storage/db.js';

export type UxEventType =
  | 'workflow_created'
  | 'node_added_unconfigured'
  | 'run_blocked_validation'
  | 'run_started'
  | 'run_completed'
  | 'welcome_dismissed'
  | 'tour_completed'
  | 'helpchat_opened'
  | 'helpchat_message_sent'
  | 'wizard_started'
  | 'wizard_finished'
  | 'template_used';

export interface UxEventInput {
  tenantId: string;
  userId?: string;
  eventType: UxEventType;
  workflowId?: string;
  nodeId?: string;
  metadata?: Record<string, unknown>;
}

export interface UxEventRow {
  id: number;
  tenantId: string;
  userId: string | null;
  eventType: string;
  workflowId: string | null;
  nodeId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface DbRow {
  id: number;
  tenant_id: string;
  user_id: string | null;
  event_type: string;
  workflow_id: string | null;
  node_id: string | null;
  metadata_json: string | null;
  created_at: string;
}

export interface FunnelSlice {
  eventType: string;
  count: number;
  uniqueUsers: number;
}

export class UxTelemetryService {
  /** Append-only event recording. Errors are swallowed — telemetry must
   *  never break the user's actual work. */
  record(input: UxEventInput): void {
    try {
      const { sqlite } = getDatabase();
      sqlite.prepare(`
        INSERT INTO ux_events (tenant_id, user_id, event_type, workflow_id, node_id, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        input.tenantId,
        input.userId ?? null,
        input.eventType,
        input.workflowId ?? null,
        input.nodeId ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      );
    } catch {
      // swallow — telemetry must never fail the request
    }
  }

  /** Cross-tenant funnel for the SaaS provider's admin dashboard. */
  funnel(opts: { sinceHours?: number } = {}): FunnelSlice[] {
    const { sqlite } = getDatabase();
    const sinceHours = opts.sinceHours ?? 24;
    const since = new Date(Date.now() - sinceHours * 3600_000).toISOString();
    return sqlite.prepare(`
      SELECT event_type AS eventType, COUNT(*) AS count, COUNT(DISTINCT user_id) AS uniqueUsers
      FROM ux_events
      WHERE created_at >= ?
      GROUP BY event_type
      ORDER BY count DESC
    `).all(since) as FunnelSlice[];
  }

  /** Recent events for the admin debugger. */
  recent(limit = 200, tenantId?: string): UxEventRow[] {
    const { sqlite } = getDatabase();
    const rows = tenantId
      ? sqlite.prepare(`SELECT * FROM ux_events WHERE tenant_id = ? ORDER BY id DESC LIMIT ?`).all(tenantId, limit) as DbRow[]
      : sqlite.prepare(`SELECT * FROM ux_events ORDER BY id DESC LIMIT ?`).all(limit) as DbRow[];
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      userId: r.user_id,
      eventType: r.event_type,
      workflowId: r.workflow_id,
      nodeId: r.node_id,
      metadata: r.metadata_json ? (JSON.parse(r.metadata_json) as Record<string, unknown>) : null,
      createdAt: r.created_at,
    }));
  }

  /**
   * "Stuck users" report — users with workflow_created but no run_started in
   * the last N hours. The signal that someone tried but gave up.
   */
  stuckUsers(opts: { sinceHours?: number } = {}): { userId: string; tenantId: string; createdAt: string; workflowId: string | null }[] {
    const { sqlite } = getDatabase();
    const sinceHours = opts.sinceHours ?? 24;
    const since = new Date(Date.now() - sinceHours * 3600_000).toISOString();
    return sqlite.prepare(`
      SELECT u.user_id AS userId, u.tenant_id AS tenantId, u.workflow_id AS workflowId, u.created_at AS createdAt
      FROM ux_events u
      WHERE u.event_type = 'workflow_created'
        AND u.created_at >= ?
        AND u.user_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ux_events r
          WHERE r.user_id = u.user_id
            AND r.event_type = 'run_started'
            AND r.created_at >= u.created_at
        )
      ORDER BY u.created_at DESC
      LIMIT 100
    `).all(since) as { userId: string; tenantId: string; createdAt: string; workflowId: string | null }[];
  }
}
