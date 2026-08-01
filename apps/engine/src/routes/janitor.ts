/**
 * Routes — /api/v1/janitor/*
 *
 * Admin API per il Janitor framework. Tutte le route applicano
 * `getTenantId(c)` per RLS lato applicazione. Le mutate richiedono
 * autenticazione e generano audit log via use case.
 *
 * Endpoints:
 *   GET    /datasources                       — lista data sources del tenant
 *   GET    /rules                             — lista rule + config effettivo
 *   GET    /rules/:ruleId                     — dettaglio rule + config
 *   PATCH  /rules/:ruleId                     — aggiorna config (enabled, schedule, params)
 *   POST   /rules/:ruleId/run                 — esegui adesso (dryRun opzionale)
 *   POST   /rules/:ruleId/reset               — reset config ai default
 *   POST   /cycle/run                         — esegui ciclo completo (tutte rules tenant)
 *   GET    /history                           — lista esecuzioni recenti
 *   GET    /history/trend?days=30             — bucket giornalieri (chart UI)
 *   GET    /quarantine                        — lista righe quarantinate (filtri)
 *   GET    /quarantine/stats                  — counters
 *   POST   /quarantine/:id/restore            — restore di una riga
 *   DELETE /quarantine/:id                    — purge (richiede confirmationToken)
 *   GET    /dsl-rules                         — lista DSL rules del tenant
 *   POST   /dsl-rules                         — crea DSL rule
 *   PATCH  /dsl-rules/:id                     — aggiorna DSL rule
 *   DELETE /dsl-rules/:id                     — elimina DSL rule
 *   GET    /locks                             — diagnostica lock attivi
 */

import type { Rule } from '../services/janitor/index.js';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { getTenantId } from '@/lib/tenant.js';
import { getActorId } from '@/lib/actor.js';
import { logger } from '@/lib/logger.js';
import { isSeverity, type DataSourceRef, isDataSourceRef } from '@/services/janitor/index.js';
import type { JanitorRuntime } from '@/services/janitor/index.js';
import { requireRole } from '@/middleware/rbac.js';

const SeverityEnum = z.enum(['critical', 'warning']);

const RuleConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  schedule: z.string().min(1).max(80).optional(),
  dataSourceRef: z.string().min(1).max(200).optional(),
  maxRowsPerRun: z.number().int().positive().max(100_000).optional(),
  severity: SeverityEnum.optional(),
  params: z.record(z.unknown()).optional(),
  notifyOnDetection: z.boolean().optional(),
});

const RunRuleSchema = z.object({
  dryRun: z.boolean().default(false),
  overrides: z
    .object({
      maxRowsPerRun: z.number().int().positive().max(100_000).optional(),
      params: z.record(z.unknown()).optional(),
      dataSourceRef: z.string().optional(),
    })
    .optional(),
});

const CycleRunSchema = z.object({
  dryRun: z.boolean().default(false),
  ruleIds: z.array(z.string()).optional(),
  tagFilter: z.array(z.string()).optional(),
});

const CreateDslSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  dataSourceRef: z.string().min(1).max(200),
  targetTable: z.string().min(1).max(64),
  targetPkColumn: z.string().min(1).max(64),
  detectSql: z.string().min(1).max(8000),
  repairSql: z.string().max(8000).optional(),
  placeholders: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  tags: z.array(z.string()).optional(),
  defaultSeverity: SeverityEnum.optional(),
  defaultSchedule: z.string().optional(),
  defaultMaxRowsPerRun: z.number().int().positive().max(100_000).optional(),
});

const UpdateDslSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  detectSql: z.string().min(1).max(8000).optional(),
  repairSql: z.string().max(8000).nullable().optional(),
  placeholders: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  tags: z.array(z.string()).optional(),
  defaultSeverity: SeverityEnum.optional(),
  defaultSchedule: z.string().optional(),
  defaultMaxRowsPerRun: z.number().int().positive().max(100_000).optional(),
});

const PurgeSchema = z.object({
  confirmationToken: z.literal('DELETE-PERMANENT'),
  dataSourceRef: z.string().min(1).max(200),
});

const QuarantineFilterSchema = z.object({
  table: z.string().optional(),
  ruleId: z.string().optional(),
  severity: SeverityEnum.optional(),
  dataSourceRef: z.string().optional(),
  cursor: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

export function createJanitorRoutes(janitor: JanitorRuntime): Hono {
  const app = new Hono();

  // ─── Data sources (UI selector) ─────────────────────────────
  app.get('/datasources', async (c) => {
    const tenantId = getTenantId(c);
    const list = await janitor.resolver.list(tenantId);
    return c.json({ datasources: list });
  });

  // ─── Rules ──────────────────────────────────────────────────
  app.get('/rules', async (c) => {
    const tenantId = getTenantId(c);
    const items = await janitor.manageRuleConfig.listForTenant(tenantId);
    const lastByRule = await janitor.runLog.lastByRule(tenantId);
    return c.json({
      rules: items.map((i) => ({
        rule: serializeRule(i.rule),
        config: i.config,
        isPersistedConfig: i.isPersistedConfig,
        lastRun: lastByRule[i.rule.id] ?? null,
      })),
    });
  });

  app.get('/rules/:ruleId', async (c) => {
    const tenantId = getTenantId(c);
    const ruleId = c.req.param('ruleId');
    const item = await janitor.manageRuleConfig.getEffective(ruleId, tenantId);
    if (!item) return c.json({ error: 'Rule non trovata' }, 404);
    return c.json({
      rule: serializeRule(item.rule),
      config: item.config,
      isPersistedConfig: item.isPersistedConfig,
    });
  });

  app.patch('/rules/:ruleId', zValidator('json', RuleConfigPatchSchema), async (c) => {
    const tenantId = getTenantId(c);
    const ruleId = c.req.param('ruleId');
    const patch = c.req.valid('json');
    const actorId = getActorId(c) ?? undefined;
    try {
      if (patch.dataSourceRef !== undefined && !isDataSourceRef(patch.dataSourceRef)) {
        return c.json({ error: 'dataSourceRef non valido' }, 400);
      }
      // Build immutable patch via spread conditionals — Federico-grade:
      // niente `assignment to readonly` warning, niente local `let` mutabili.
      const sanitized: Parameters<typeof janitor.manageRuleConfig.patch>[0]['patch'] = {
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
        ...(patch.dataSourceRef !== undefined ? { dataSourceRef: patch.dataSourceRef } : {}),
        ...(patch.maxRowsPerRun !== undefined ? { maxRowsPerRun: patch.maxRowsPerRun } : {}),
        ...((patch.severity !== undefined && isSeverity(patch.severity)) ? { severity: patch.severity } : {}),
        ...(patch.params !== undefined ? { params: patch.params } : {}),
        ...(patch.notifyOnDetection !== undefined ? { notifyOnDetection: patch.notifyOnDetection } : {}),
      };
      const updateArgs: Parameters<typeof janitor.manageRuleConfig.patch>[0] = {
        ruleId, tenantId, patch: sanitized,
      };
      if (actorId !== undefined) updateArgs.updatedBy = actorId;
      const updated = await janitor.manageRuleConfig.patch(updateArgs);
      return c.json({ config: updated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'errore sconosciuto';
      return c.json({ error: msg }, 400);
    }
  });

  app.post('/rules/:ruleId/run', zValidator('json', RunRuleSchema), async (c) => {
    const tenantId = getTenantId(c);
    const ruleId = c.req.param('ruleId');
    const body = c.req.valid('json');
    const actorId = getActorId(c) ?? 'admin';
    const rule = janitor.registry.get(ruleId);
    if (!rule) return c.json({ error: 'Rule non trovata' }, 404);

    const overrides = body.overrides
      ? {
        ...(body.overrides.maxRowsPerRun !== undefined ? { maxRowsPerRun: body.overrides.maxRowsPerRun } : {}),
        ...(body.overrides.params !== undefined ? { params: body.overrides.params } : {}),
        ...(body.overrides.dataSourceRef !== undefined && isDataSourceRef(body.overrides.dataSourceRef)
          ? { dataSourceRef: body.overrides.dataSourceRef }
          : {}),
      }
      : undefined;
    const execArgs: Parameters<typeof janitor.executeRule.execute>[0] = {
      rule,
      tenantId,
      triggeredBy: `admin:${actorId}`,
      dryRun: body.dryRun,
      ...(overrides && Object.keys(overrides).length > 0 ? { overrides } : {}),
    };
    try {
      const result = await janitor.executeRule.execute(execArgs);
      return c.json({ report: result.report, detected: result.detected }, 200);
    } catch (err) {
      logger.error({ err, ruleId }, 'janitor.rule.run failed');
      const msg = err instanceof Error ? err.message : 'errore sconosciuto';
      return c.json({ error: msg }, 500);
    }
  });

  app.post('/rules/:ruleId/reset', async (c) => {
    const tenantId = getTenantId(c);
    const ruleId = c.req.param('ruleId');
    const actorId = getActorId(c) ?? undefined;
    try {
      const config = await janitor.manageRuleConfig.resetToDefault(ruleId, tenantId, actorId);
      return c.json({ config });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'errore' }, 400);
    }
  });

  // ─── Cycle ──────────────────────────────────────────────────
  app.post('/cycle/run', zValidator('json', CycleRunSchema), async (c) => {
    const tenantId = getTenantId(c);
    const body = c.req.valid('json');
    const actorId = getActorId(c) ?? 'admin';
    const cycleArgs: Parameters<typeof janitor.executeCycle.execute>[0] = {
      tenantId,
      triggeredBy: `admin:${actorId}`,
      dryRun: body.dryRun,
      ...(body.ruleIds !== undefined ? { ruleIds: body.ruleIds } : {}),
      ...(body.tagFilter !== undefined ? { tagFilter: body.tagFilter } : {}),
    };
    const report = await janitor.executeCycle.execute(cycleArgs);
    return c.json({ report });
  });

  // ─── History / analytics ────────────────────────────────────
  app.get('/history', async (c) => {
    const tenantId = getTenantId(c);
    const ruleId = c.req.query('ruleId') ?? undefined;
    const cursor = parseIntOr(c.req.query('cursor'));
    const limit = parseIntOr(c.req.query('limit')) ?? 100;
    const q: Parameters<typeof janitor.runLog.listRuleReports>[0] = {
      tenantId,
      limit,
      ...(ruleId ? { ruleId } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    };
    const reports = await janitor.runLog.listRuleReports(q);
    return c.json({ reports });
  });

  app.get('/history/trend', async (c) => {
    const tenantId = getTenantId(c);
    const days = parseIntOr(c.req.query('days')) ?? 30;
    const buckets = await janitor.runLog.trendBuckets({ tenantId, daysBack: days });
    return c.json({ buckets });
  });

  // ─── Quarantine ─────────────────────────────────────────────
  app.get('/quarantine', zValidator('query', QuarantineFilterSchema), async (c) => {
    const tenantId = getTenantId(c);
    const q = c.req.valid('query');
    const filter: Parameters<typeof janitor.manageQuarantine.list>[0] = {
      tenantId,
      limit: q.limit,
      ...(q.table !== undefined ? { table: q.table } : {}),
      ...(q.ruleId !== undefined ? { ruleId: q.ruleId } : {}),
      ...(q.severity !== undefined ? { severity: q.severity } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.dataSourceRef !== undefined && isDataSourceRef(q.dataSourceRef)
        ? { dataSourceRef: q.dataSourceRef }
        : {}),
    };
    const records = await janitor.manageQuarantine.list(filter);
    return c.json({ records });
  });

  app.get('/quarantine/stats', async (c) => {
    const dsr = c.req.query('dataSourceRef');
    const stats = await janitor.manageQuarantine.stats(
      dsr && isDataSourceRef(dsr) ? (dsr) : undefined,
    );
    return c.json({ stats });
  });

  app.post('/quarantine/:id/restore', async (c) => {
    const tenantId = getTenantId(c);
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id)) return c.json({ error: 'id non valido' }, 400);
    const actorId = getActorId(c) ?? 'admin';
    let body: { dataSourceRef?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'body JSON richiesto' }, 400);
    }
    const dsr = body.dataSourceRef;
    if (typeof dsr !== 'string' || !isDataSourceRef(dsr)) {
      return c.json({ error: 'dataSourceRef richiesto' }, 400);
    }
    try {
      await janitor.manageQuarantine.restore({
        quarantineId: id, dataSourceRef: dsr, tenantId, actorId,
      });
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'errore';
      return c.json({ error: msg }, 400);
    }
  });

  app.delete('/quarantine/:id', zValidator('json', PurgeSchema), async (c) => {
    const tenantId = getTenantId(c);
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id)) return c.json({ error: 'id non valido' }, 400);
    const actorId = getActorId(c) ?? 'admin';
    const body = c.req.valid('json');
    try {
      await janitor.manageQuarantine.purge({
        quarantineId: id,
        dataSourceRef: body.dataSourceRef as DataSourceRef,
        tenantId,
        actorId,
        confirmationToken: body.confirmationToken,
      });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'errore' }, 400);
    }
  });

  // ─── DSL rules ──────────────────────────────────────────────
  app.get('/dsl-rules', async (c) => {
    const tenantId = getTenantId(c);
    const rules = await janitor.manageDslRules.listForTenant(tenantId);
    return c.json({ rules });
  });

  // N19 audit (2026-05-29): owner-only mutations on DSL rules.
  // A DSL rule embeds arbitrary SQL executed against the tenant data
  // source (potentially an external production DB connected via vault
  // credentials). Even with the read-only adapter gate + classify worst
  // fold, creating/editing/deleting rules is a privileged operation —
  // limit to owners + superadmins. List + run remain open to lower
  // roles (operator/editor) so day-to-day debugging still works.
  app.post('/dsl-rules', requireRole('owner'), zValidator('json', CreateDslSchema), async (c) => {
    const tenantId = getTenantId(c);
    const body = c.req.valid('json');
    const actorId = getActorId(c) ?? undefined;
    if (!isDataSourceRef(body.dataSourceRef)) {
      return c.json({ error: 'dataSourceRef non valido' }, 400);
    }
    const createArgs: Parameters<typeof janitor.manageDslRules.create>[0] = {
      tenantId,
      title: body.title,
      dataSourceRef: body.dataSourceRef,
      targetTable: body.targetTable,
      targetPkColumn: body.targetPkColumn,
      detectSql: body.detectSql,
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.repairSql !== undefined ? { repairSql: body.repairSql } : {}),
      ...(body.placeholders !== undefined ? { placeholders: body.placeholders } : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
      ...(body.defaultSeverity !== undefined ? { defaultSeverity: body.defaultSeverity } : {}),
      ...(body.defaultSchedule !== undefined ? { defaultSchedule: body.defaultSchedule } : {}),
      ...(body.defaultMaxRowsPerRun !== undefined ? { defaultMaxRowsPerRun: body.defaultMaxRowsPerRun } : {}),
      ...(actorId !== undefined ? { createdBy: actorId } : {}),
    };
    const r = await janitor.manageDslRules.create(createArgs);
    if (!r.ok) return c.json({ error: r.error }, 400);
    return c.json({ rule: r.value }, 201);
  });

  app.patch('/dsl-rules/:id', requireRole('owner'), zValidator('json', UpdateDslSchema), async (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const body = c.req.valid('json');
    const actorId = getActorId(c) ?? undefined;
    const updateArgs: Parameters<typeof janitor.manageDslRules.update>[0] = {
      id,
      tenantId,
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.detectSql !== undefined ? { detectSql: body.detectSql } : {}),
      ...(body.repairSql !== undefined ? { repairSql: body.repairSql } : {}),
      ...(body.placeholders !== undefined ? { placeholders: body.placeholders } : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
      ...(body.defaultSeverity !== undefined ? { defaultSeverity: body.defaultSeverity } : {}),
      ...(body.defaultSchedule !== undefined ? { defaultSchedule: body.defaultSchedule } : {}),
      ...(body.defaultMaxRowsPerRun !== undefined ? { defaultMaxRowsPerRun: body.defaultMaxRowsPerRun } : {}),
      ...(actorId !== undefined ? { updatedBy: actorId } : {}),
    };
    const r = await janitor.manageDslRules.update(updateArgs);
    if (!r.ok) return c.json({ error: r.error }, 400);
    return c.json({ rule: r.value });
  });

  app.delete('/dsl-rules/:id', requireRole('owner'), async (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const actorId = getActorId(c) ?? undefined;
    const r = await janitor.manageDslRules.delete(id, tenantId, actorId);
    if (!r.ok) return c.json({ error: r.error }, 400);
    return c.json({ ok: true });
  });

  // ─── Diagnostic ─────────────────────────────────────────────
  app.get('/locks', (c) => {
    const _tenantId = getTenantId(c); // tenant gate — non filtra ma forza auth
    void _tenantId;
    return c.json({ locks: [] }); // Implementation diagnostic only.
  });

  return app;
}

function serializeRule(rule: Rule): Record<string, unknown> {
  if (rule.kind === 'code') {
    return {
      kind: rule.kind,
      id: rule.id,
      title: rule.title,
      description: rule.description,
      ...(rule.documentation ? { documentation: rule.documentation } : {}),
      defaultDataSource: rule.defaultDataSource,
      targetTable: rule.targetTable,
      targetPkColumn: rule.targetPkColumn,
      tags: rule.tags,
      paramsSchema: rule.paramsSchema,
      defaultSeverity: rule.defaultSeverity,
      defaultSchedule: rule.defaultSchedule,
      defaultMaxRowsPerRun: rule.defaultMaxRowsPerRun,
      hasRepair: typeof rule.repair === 'function',
    };
  }
  return {
    kind: rule.kind,
    id: rule.id,
    tenantId: rule.tenantId,
    title: rule.title,
    description: rule.description,
    dataSourceRef: rule.dataSourceRef,
    targetTable: rule.targetTable,
    targetPkColumn: rule.targetPkColumn,
    detectSql: rule.detectSql,
    ...(rule.repairSql ? { repairSql: rule.repairSql } : {}),
    placeholders: rule.placeholders,
    tags: rule.tags,
    defaultSeverity: rule.defaultSeverity,
    defaultSchedule: rule.defaultSchedule,
    defaultMaxRowsPerRun: rule.defaultMaxRowsPerRun,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

function parseIntOr(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) ? n : undefined;
}
