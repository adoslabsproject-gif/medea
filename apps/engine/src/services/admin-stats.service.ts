/**
 * Cross-tenant statistics service for the superadmin dashboard.
 * All queries scoped to NO tenantId — superadmin sees the whole instance.
 */

import { getDatabase } from '@/storage/db.js';

export interface TenantSummary {
  tenantId: string;
  userCount: number;
  workflowCount: number;
  activeWorkflows: number;
  runsLast24h: number;
  errorsLast24h: number;
  lastActivity?: string;
}

export interface InstanceStats {
  tenants: number;
  users: number;
  workflows: number;
  activeWorkflows: number;
  runsLast24h: number;
  runsLast7d: number;
  errorsLast24h: number;
  successRate7d: number;
}

export class AdminStatsService {
  instance(): InstanceStats {
    const { sqlite } = getDatabase();
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const tenants = (sqlite.prepare('SELECT COUNT(DISTINCT tenant_id) AS c FROM users').get() as { c: number }).c;
    const users = (sqlite.prepare('SELECT COUNT(*) AS c FROM users WHERE enabled = 1').get() as { c: number }).c;
    const workflows = (sqlite.prepare('SELECT COUNT(*) AS c FROM workflows').get() as { c: number }).c;
    const activeWorkflows = (sqlite.prepare('SELECT COUNT(*) AS c FROM workflows WHERE enabled = 1').get() as { c: number }).c;
    const runsLast24h = (sqlite.prepare('SELECT COUNT(*) AS c FROM runs WHERE started_at >= ?').get(dayAgo) as { c: number }).c;
    const runsLast7d = (sqlite.prepare('SELECT COUNT(*) AS c FROM runs WHERE started_at >= ?').get(weekAgo) as { c: number }).c;
    const errorsLast24h = (sqlite.prepare("SELECT COUNT(*) AS c FROM runs WHERE started_at >= ? AND status = 'error'").get(dayAgo) as { c: number }).c;
    const successLast7d = (sqlite.prepare("SELECT COUNT(*) AS c FROM runs WHERE started_at >= ? AND status = 'success'").get(weekAgo) as { c: number }).c;
    const successRate7d = runsLast7d > 0 ? (successLast7d / runsLast7d) * 100 : 100;

    return {
      tenants,
      users,
      workflows,
      activeWorkflows,
      runsLast24h,
      runsLast7d,
      errorsLast24h,
      successRate7d: Math.round(successRate7d * 10) / 10,
    };
  }

  tenants(): TenantSummary[] {
    const { sqlite } = getDatabase();
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = sqlite.prepare(`
      SELECT
        u.tenant_id AS tenantId,
        COUNT(DISTINCT u.id) AS userCount,
        (SELECT COUNT(*) FROM workflows w WHERE w.tenant_id = u.tenant_id) AS workflowCount,
        (SELECT COUNT(*) FROM workflows w WHERE w.tenant_id = u.tenant_id AND w.enabled = 1) AS activeWorkflows,
        (SELECT COUNT(*) FROM runs r WHERE r.tenant_id = u.tenant_id AND r.started_at >= ?) AS runsLast24h,
        (SELECT COUNT(*) FROM runs r WHERE r.tenant_id = u.tenant_id AND r.started_at >= ? AND r.status = 'error') AS errorsLast24h,
        (SELECT MAX(started_at) FROM runs r WHERE r.tenant_id = u.tenant_id) AS lastActivity
      FROM users u
      GROUP BY u.tenant_id
      ORDER BY runsLast24h DESC
    `).all(dayAgo, dayAgo) as TenantSummary[];
    return rows;
  }

  /**
   * Per-tenant read-only stats — same shape used by superadmin AND public
   * viewer-share dashboard. Single source of truth for what the client sees.
   */
  tenantDashboard(tenantId: string): {
    workflows: number;
    activeWorkflows: number;
    runsLast24h: number;
    runsLast7d: number;
    successLast7d: number;
    errorsLast7d: number;
    successRate7d: number;
    avgDurationMs7d: number;
    recentRuns: { id: string; workflowName: string; status: string; startedAt: string; durationMs: number; errorCount: number }[];
    currentlyRunning: { id: string; workflowName: string; startedAt: string }[];
  } {
    const { sqlite } = getDatabase();
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const workflows = (sqlite.prepare('SELECT COUNT(*) AS c FROM workflows WHERE tenant_id = ?').get(tenantId) as { c: number }).c;
    const activeWorkflows = (sqlite.prepare('SELECT COUNT(*) AS c FROM workflows WHERE tenant_id = ? AND enabled = 1').get(tenantId) as { c: number }).c;
    const runsLast24h = (sqlite.prepare('SELECT COUNT(*) AS c FROM runs WHERE tenant_id = ? AND started_at >= ?').get(tenantId, dayAgo) as { c: number }).c;
    const runsLast7d = (sqlite.prepare('SELECT COUNT(*) AS c FROM runs WHERE tenant_id = ? AND started_at >= ?').get(tenantId, weekAgo) as { c: number }).c;
    const successLast7d = (sqlite.prepare("SELECT COUNT(*) AS c FROM runs WHERE tenant_id = ? AND started_at >= ? AND status = 'success'").get(tenantId, weekAgo) as { c: number }).c;
    const errorsLast7d = (sqlite.prepare("SELECT COUNT(*) AS c FROM runs WHERE tenant_id = ? AND started_at >= ? AND status = 'error'").get(tenantId, weekAgo) as { c: number }).c;
    const successRate7d = runsLast7d > 0 ? (successLast7d / runsLast7d) * 100 : 100;
    const avgDur = sqlite.prepare("SELECT AVG(total_duration_ms) AS a FROM runs WHERE tenant_id = ? AND started_at >= ? AND status = 'success'").get(tenantId, weekAgo) as { a: number | null };
    const avgDurationMs7d = Math.round(avgDur.a ?? 0);

    const recentRuns = sqlite.prepare(`
      SELECT r.id, w.name AS workflowName, r.status, r.started_at AS startedAt, r.total_duration_ms AS durationMs, r.error_count AS errorCount
      FROM runs r
      LEFT JOIN workflows w ON w.id = r.workflow_id
      WHERE r.tenant_id = ?
      ORDER BY r.started_at DESC
      LIMIT 20
    `).all(tenantId) as { id: string; workflowName: string; status: string; startedAt: string; durationMs: number; errorCount: number }[];

    const currentlyRunning = sqlite.prepare(`
      SELECT r.id, w.name AS workflowName, r.started_at AS startedAt
      FROM runs r
      LEFT JOIN workflows w ON w.id = r.workflow_id
      WHERE r.tenant_id = ? AND r.ended_at IS NULL
      ORDER BY r.started_at DESC
      LIMIT 10
    `).all(tenantId) as { id: string; workflowName: string; startedAt: string }[];

    return {
      workflows,
      activeWorkflows,
      runsLast24h,
      runsLast7d,
      successLast7d,
      errorsLast7d,
      successRate7d: Math.round(successRate7d * 10) / 10,
      avgDurationMs7d,
      recentRuns,
      currentlyRunning,
    };
  }
}
