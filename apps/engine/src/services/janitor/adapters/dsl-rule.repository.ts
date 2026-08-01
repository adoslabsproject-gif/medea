/**
 * Adapter — DslRuleRepository.
 *
 * CRUD sulle DSL rules definite via UI dal tenant (tabella
 * `janitor_dsl_rules` sul system DB). All'avvio del Janitor, tutte
 * vengono caricate e registrate nel `IRuleRegistry`.
 */

import { and, eq } from 'drizzle-orm';
import { getDatabase } from '@/storage/db.js';
import { janitorDslRules, type JanitorDslRuleRow } from '@/storage/schema.js';
import type { DslRule, DataSourceRef } from '@/services/janitor/domain/index.js';

export class DslRuleRepository {
  async listAll(): Promise<readonly DslRule[]> {
    const { db } = getDatabase();
    const rows = await db.select().from(janitorDslRules);
    return rows.map(rowToDsl);
  }

  async listForTenant(tenantId: string): Promise<readonly DslRule[]> {
    const { db } = getDatabase();
    const rows = await db.select().from(janitorDslRules)
      .where(eq(janitorDslRules.tenantId, tenantId));
    return rows.map(rowToDsl);
  }

  async get(id: string): Promise<DslRule | null> {
    const { db } = getDatabase();
    const rows = await db.select().from(janitorDslRules)
      .where(eq(janitorDslRules.id, id))
      .limit(1);
    const row = rows[0];
    return row ? rowToDsl(row) : null;
  }

  async upsert(rule: DslRule): Promise<void> {
    const { db } = getDatabase();
    await db.insert(janitorDslRules).values({
      id: rule.id,
      tenantId: rule.tenantId,
      title: rule.title,
      description: rule.description,
      dataSourceRef: rule.dataSourceRef,
      targetTable: rule.targetTable,
      targetPkColumn: rule.targetPkColumn,
      detectSql: rule.detectSql,
      repairSql: rule.repairSql ?? null,
      placeholdersJson: JSON.stringify(rule.placeholders),
      tagsJson: JSON.stringify(rule.tags),
      defaultSeverity: rule.defaultSeverity,
      defaultSchedule: rule.defaultSchedule,
      defaultMaxRowsPerRun: rule.defaultMaxRowsPerRun,
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
      createdBy: rule.createdBy ?? null,
    }).onConflictDoUpdate({
      target: janitorDslRules.id,
      set: {
        title: rule.title,
        description: rule.description,
        dataSourceRef: rule.dataSourceRef,
        targetTable: rule.targetTable,
        targetPkColumn: rule.targetPkColumn,
        detectSql: rule.detectSql,
        repairSql: rule.repairSql ?? null,
        placeholdersJson: JSON.stringify(rule.placeholders),
        tagsJson: JSON.stringify(rule.tags),
        defaultSeverity: rule.defaultSeverity,
        defaultSchedule: rule.defaultSchedule,
        defaultMaxRowsPerRun: rule.defaultMaxRowsPerRun,
        updatedAt: rule.updatedAt,
      },
    });
  }

  async delete(id: string, tenantId: string): Promise<void> {
    const { db } = getDatabase();
    await db.delete(janitorDslRules).where(and(
      eq(janitorDslRules.id, id),
      eq(janitorDslRules.tenantId, tenantId),
    ));
  }
}

function rowToDsl(row: JanitorDslRuleRow): DslRule {
  let placeholders: Readonly<Record<string, string | number | boolean>> = Object.freeze({});
  try {
    const parsed = JSON.parse(row.placeholdersJson) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      placeholders = Object.freeze(parsed as Record<string, string | number | boolean>);
    }
  } catch { /* malformed → empty */ }

  let tags: readonly string[] = Object.freeze([]);
  try {
    const parsed = JSON.parse(row.tagsJson) as unknown;
    if (Array.isArray(parsed)) tags = Object.freeze(parsed.filter((t): t is string => typeof t === 'string'));
  } catch { /* malformed → empty */ }

  const out: DslRule = {
    kind: 'dsl',
    id: row.id,
    tenantId: row.tenantId,
    title: row.title,
    description: row.description,
    dataSourceRef: row.dataSourceRef as DataSourceRef,
    targetTable: row.targetTable,
    targetPkColumn: row.targetPkColumn,
    detectSql: row.detectSql,
    ...(row.repairSql ? { repairSql: row.repairSql } : {}),
    placeholders,
    tags,
    defaultSeverity: row.defaultSeverity,
    defaultSchedule: row.defaultSchedule,
    defaultMaxRowsPerRun: row.defaultMaxRowsPerRun,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.createdBy ? { createdBy: row.createdBy } : {}),
  };
  return Object.freeze(out);
}
