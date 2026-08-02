/**
 * Adapter — RuleConfigRepository sopra Drizzle / system SQLite.
 *
 * Tabella `janitor_rule_configs` con PK composto `(rule_id, tenant_id)`.
 * Upsert atomico via INSERT ... ON CONFLICT (rule_id, tenant_id) DO UPDATE.
 */

import { and, eq } from 'drizzle-orm';
import { getDatabase } from '@/storage/db.js';
import { janitorRuleConfigs, type JanitorRuleConfigRow } from '@/storage/schema.js';
import type { IRuleConfigRepository } from '@/services/janitor/ports/index.js';
import type {
  RuleConfig,
  RuleConfigPatch,
  DataSourceRef,
} from '@/services/janitor/domain/index.js';

export class SqliteRuleConfigRepository implements IRuleConfigRepository {
  async list(tenantId: string): Promise<readonly RuleConfig[]> {
    const { db } = getDatabase();
    const rows = await db
      .select()
      .from(janitorRuleConfigs)
      .where(eq(janitorRuleConfigs.tenantId, tenantId));
    return rows.map(rowToConfig);
  }

  async listAll(): Promise<readonly RuleConfig[]> {
    const { db } = getDatabase();
    const rows = await db.select().from(janitorRuleConfigs);
    return rows.map(rowToConfig);
  }

  async get(ruleId: string, tenantId: string): Promise<RuleConfig | null> {
    const { db } = getDatabase();
    const rows = await db
      .select()
      .from(janitorRuleConfigs)
      .where(and(eq(janitorRuleConfigs.ruleId, ruleId), eq(janitorRuleConfigs.tenantId, tenantId)))
      .limit(1);
    const row = rows[0];
    return row ? rowToConfig(row) : null;
  }

  async upsert(config: RuleConfig): Promise<void> {
    const { db } = getDatabase();
    // Drizzle SQLite onConflictDoUpdate per PK composto.
    await db
      .insert(janitorRuleConfigs)
      .values({
        ruleId: config.ruleId,
        tenantId: config.tenantId,
        enabled: config.enabled,
        schedule: config.schedule,
        dataSourceRef: config.dataSourceRef,
        maxRowsPerRun: config.maxRowsPerRun,
        severity: config.severity,
        paramsJson: JSON.stringify(config.params),
        notifyOnDetection: config.notifyOnDetection,
        updatedAt: config.updatedAt,
        updatedBy: config.updatedBy ?? null,
      })
      .onConflictDoUpdate({
        target: [janitorRuleConfigs.ruleId, janitorRuleConfigs.tenantId],
        set: {
          enabled: config.enabled,
          schedule: config.schedule,
          dataSourceRef: config.dataSourceRef,
          maxRowsPerRun: config.maxRowsPerRun,
          severity: config.severity,
          paramsJson: JSON.stringify(config.params),
          notifyOnDetection: config.notifyOnDetection,
          updatedAt: config.updatedAt,
          updatedBy: config.updatedBy ?? null,
        },
      });
  }

  async patch(
    ruleId: string,
    tenantId: string,
    patch: RuleConfigPatch,
    updatedBy?: string,
  ): Promise<RuleConfig> {
    const existing = await this.get(ruleId, tenantId);
    if (!existing) {
      throw new Error(`Rule config not found: ruleId=${ruleId} tenantId=${tenantId}`);
    }
    const merged: RuleConfig = {
      ruleId: existing.ruleId,
      tenantId: existing.tenantId,
      enabled: patch.enabled ?? existing.enabled,
      schedule: patch.schedule ?? existing.schedule,
      dataSourceRef: patch.dataSourceRef ?? existing.dataSourceRef,
      maxRowsPerRun: patch.maxRowsPerRun ?? existing.maxRowsPerRun,
      severity: patch.severity ?? existing.severity,
      params: patch.params ?? existing.params,
      notifyOnDetection: patch.notifyOnDetection ?? existing.notifyOnDetection,
      updatedAt: new Date().toISOString(),
      ...(updatedBy !== undefined
        ? { updatedBy }
        : existing.updatedBy !== undefined
          ? { updatedBy: existing.updatedBy }
          : {}),
    };
    await this.upsert(merged);
    return merged;
  }

  async delete(ruleId: string, tenantId: string): Promise<void> {
    const { db } = getDatabase();
    await db
      .delete(janitorRuleConfigs)
      .where(and(eq(janitorRuleConfigs.ruleId, ruleId), eq(janitorRuleConfigs.tenantId, tenantId)));
  }
}

function rowToConfig(row: JanitorRuleConfigRow): RuleConfig {
  let params: Readonly<Record<string, unknown>>;
  try {
    const parsed = JSON.parse(row.paramsJson) as unknown;
    params =
      typeof parsed === 'object' && parsed !== null
        ? Object.freeze(parsed as Record<string, unknown>)
        : Object.freeze({});
  } catch {
    params = Object.freeze({});
  }
  const out: RuleConfig = {
    ruleId: row.ruleId,
    tenantId: row.tenantId,
    enabled: row.enabled,
    schedule: row.schedule,
    dataSourceRef: row.dataSourceRef as DataSourceRef,
    maxRowsPerRun: row.maxRowsPerRun,
    severity: row.severity,
    params,
    notifyOnDetection: row.notifyOnDetection,
    updatedAt: row.updatedAt,
    ...(row.updatedBy ? { updatedBy: row.updatedBy } : {}),
  };
  return Object.freeze(out);
}
