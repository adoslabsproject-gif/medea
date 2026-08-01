/**
 * Use case — ManageDslRulesUseCase.
 *
 * CRUD per le DSL rule definite via UI dal tenant. Validazione SQL:
 *   • detectSql DEVE essere SELECT/WITH (no DML/DDL)
 *   • repairSql (opzionale) DEVE essere UPDATE (no DELETE/INSERT/TRUNCATE)
 *
 * Dopo save, la rule viene registrata nel `IRuleRegistry` così è
 * disponibile per ExecuteRule senza riavvio del processo.
 */

import { nanoid } from 'nanoid';
import { classifyStatement } from '@flowforge/db-studio-engine';
import type {
  DslRule, DataSourceRef, CorruptionSeverity,
} from '@/services/janitor/domain/index.js';
import { Err, Ok, type Result } from '@/services/janitor/domain/index.js';
import type { IRuleRegistry, IAuditEmitter, IDataSourceResolver } from '@/services/janitor/ports/index.js';
import { engineSupportsRawSql } from '@/services/janitor/domain/data-source-ref.js';
import { validateCronExpression } from './cron-evaluator.js';
import type { DslRuleRepository } from '@/services/janitor/adapters/dsl-rule.repository.js';

export interface CreateDslRuleInput {
  readonly tenantId: string;
  readonly title: string;
  readonly description?: string;
  readonly dataSourceRef: DataSourceRef;
  readonly targetTable: string;
  readonly targetPkColumn: string;
  readonly detectSql: string;
  readonly repairSql?: string;
  readonly placeholders?: Readonly<Record<string, string | number | boolean>>;
  readonly tags?: readonly string[];
  readonly defaultSeverity?: CorruptionSeverity;
  readonly defaultSchedule?: string;
  readonly defaultMaxRowsPerRun?: number;
  readonly createdBy?: string;
}

export interface UpdateDslRuleInput {
  readonly id: string;
  readonly tenantId: string;
  readonly title?: string;
  readonly description?: string;
  readonly detectSql?: string;
  readonly repairSql?: string | null;
  readonly placeholders?: Readonly<Record<string, string | number | boolean>>;
  readonly tags?: readonly string[];
  readonly defaultSeverity?: CorruptionSeverity;
  readonly defaultSchedule?: string;
  readonly defaultMaxRowsPerRun?: number;
  readonly updatedBy?: string;
}

const IDENTIFIER_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

export class ManageDslRulesUseCase {
  constructor(
    private readonly repo: DslRuleRepository,
    private readonly registry: IRuleRegistry,
    private readonly resolver: IDataSourceResolver,
    private readonly audit: IAuditEmitter,
  ) {}

  async listForTenant(tenantId: string): Promise<readonly DslRule[]> {
    return this.repo.listForTenant(tenantId);
  }

  async create(input: CreateDslRuleInput): Promise<Result<DslRule, string>> {
    const validation = await this.validateInput(input);
    if (!validation.ok) return validation;

    const now = new Date().toISOString();
    const rule: DslRule = Object.freeze({
      kind: 'dsl' as const,
      id: `dsl_${nanoid(10)}`,
      tenantId: input.tenantId,
      title: input.title.trim(),
      description: input.description?.trim() ?? '',
      dataSourceRef: input.dataSourceRef,
      targetTable: input.targetTable,
      targetPkColumn: input.targetPkColumn,
      detectSql: input.detectSql.trim(),
      ...(input.repairSql ? { repairSql: input.repairSql.trim() } : {}),
      placeholders: Object.freeze({ ...(input.placeholders ?? {}) }),
      tags: Object.freeze([...(input.tags ?? [])]),
      defaultSeverity: input.defaultSeverity ?? 'warning',
      defaultSchedule: input.defaultSchedule ?? '*/30 * * * *',
      defaultMaxRowsPerRun: input.defaultMaxRowsPerRun ?? 200,
      createdAt: now,
      updatedAt: now,
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    });

    await this.repo.upsert(rule);
    this.registry.registerDslRule(rule);
    await this.audit.emit({
      tenantId: input.tenantId,
      action: 'janitor.dsl_rule.created',
      resourceType: 'janitor_dsl_rule',
      resourceId: rule.id,
      ...(input.createdBy !== undefined ? { actorId: input.createdBy } : {}),
      metadata: { title: rule.title, targetTable: rule.targetTable },
    });
    return Ok(rule);
  }

  async update(input: UpdateDslRuleInput): Promise<Result<DslRule, string>> {
    const existing = await this.repo.get(input.id);
    if (!existing) return Err('Rule non trovata');
    if (existing.tenantId !== input.tenantId) return Err('Tenant mismatch');

    // Costruisco senza il campo opzionale `repairSql` per default, poi
    // lo aggiungo SOLO se patch lo richiede. Federico-grade: niente
    // `repairSql: undefined` esplicito (rotto sotto exactOptionalPropertyTypes).
    const baseDsl: DslRule = {
      kind: 'dsl' as const,
      id: existing.id,
      tenantId: existing.tenantId,
      title: input.title !== undefined ? input.title.trim() : existing.title,
      description: input.description !== undefined ? input.description.trim() : existing.description,
      dataSourceRef: existing.dataSourceRef,
      targetTable: existing.targetTable,
      targetPkColumn: existing.targetPkColumn,
      detectSql: input.detectSql !== undefined ? input.detectSql.trim() : existing.detectSql,
      placeholders: input.placeholders !== undefined
        ? Object.freeze({ ...input.placeholders })
        : existing.placeholders,
      tags: input.tags !== undefined ? Object.freeze([...input.tags]) : existing.tags,
      defaultSeverity: input.defaultSeverity ?? existing.defaultSeverity,
      defaultSchedule: input.defaultSchedule ?? existing.defaultSchedule,
      defaultMaxRowsPerRun: input.defaultMaxRowsPerRun ?? existing.defaultMaxRowsPerRun,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
      ...(existing.createdBy !== undefined ? { createdBy: existing.createdBy } : {}),
    };
    // repairSql: 3 casi
    //   • input non specificato → mantieni existing
    //   • input null → rimuovi
    //   • input string → aggiorna
    let merged: DslRule;
    if (input.repairSql === undefined) {
      merged = existing.repairSql !== undefined
        ? Object.freeze({ ...baseDsl, repairSql: existing.repairSql })
        : Object.freeze(baseDsl);
    } else if (input.repairSql === null) {
      merged = Object.freeze(baseDsl);
    } else {
      merged = Object.freeze({ ...baseDsl, repairSql: input.repairSql.trim() });
    }

    // Re-validate the full result
    const v = await this.validateInput({
      tenantId: merged.tenantId,
      title: merged.title,
      dataSourceRef: merged.dataSourceRef,
      targetTable: merged.targetTable,
      targetPkColumn: merged.targetPkColumn,
      detectSql: merged.detectSql,
      ...(merged.repairSql ? { repairSql: merged.repairSql } : {}),
      defaultSchedule: merged.defaultSchedule,
      defaultMaxRowsPerRun: merged.defaultMaxRowsPerRun,
    });
    if (!v.ok) return v;

    await this.repo.upsert(merged);
    this.registry.unregisterDslRule(existing.id);
    this.registry.registerDslRule(merged);
    await this.audit.emit({
      tenantId: input.tenantId,
      action: 'janitor.dsl_rule.updated',
      resourceType: 'janitor_dsl_rule',
      resourceId: merged.id,
      ...(input.updatedBy !== undefined ? { actorId: input.updatedBy } : {}),
    });
    return Ok(merged);
  }

  async delete(id: string, tenantId: string, actorId?: string): Promise<Result<void, string>> {
    const existing = await this.repo.get(id);
    if (!existing) return Err('Rule non trovata');
    if (existing.tenantId !== tenantId) return Err('Tenant mismatch');
    await this.repo.delete(id, tenantId);
    this.registry.unregisterDslRule(id);
    await this.audit.emit({
      tenantId,
      action: 'janitor.dsl_rule.deleted',
      resourceType: 'janitor_dsl_rule',
      resourceId: id,
      ...(actorId !== undefined ? { actorId } : {}),
    });
    return Ok(undefined);
  }

  /**
   * Validazione full di una DSL rule. Restituisce Err con message
   * human-readable italiano, oppure Ok(rule).
   */
  private async validateInput(input: {
    tenantId: string;
    title: string;
    dataSourceRef: DataSourceRef;
    targetTable: string;
    targetPkColumn: string;
    detectSql: string;
    repairSql?: string;
    defaultSchedule?: string;
    defaultMaxRowsPerRun?: number;
  }): Promise<Result<DslRule, string>> {
    if (!input.title.trim()) return Err('Titolo obbligatorio');
    if (!IDENTIFIER_RE.test(input.targetTable)) return Err(`Nome tabella non valido: "${input.targetTable}"`);
    if (!IDENTIFIER_RE.test(input.targetPkColumn)) return Err(`Nome colonna PK non valido: "${input.targetPkColumn}"`);

    if (input.defaultSchedule !== undefined) {
      const schedErr = validateCronExpression(input.defaultSchedule);
      if (schedErr) return Err(`Schedule non valido: ${schedErr}`);
    }
    if (input.defaultMaxRowsPerRun !== undefined) {
      if (!Number.isInteger(input.defaultMaxRowsPerRun) || input.defaultMaxRowsPerRun < 1 || input.defaultMaxRowsPerRun > 100_000) {
        return Err('defaultMaxRowsPerRun deve essere intero tra 1 e 100.000');
      }
    }

    // Verifica che il data source esista + supporti SQL
    let adapter;
    try {
      adapter = await this.resolver.resolve(input.dataSourceRef);
    } catch (err) {
      return Err(`Data source non risolvibile: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!engineSupportsRawSql(adapter.engine)) {
      return Err(`Engine "${adapter.engine}" non supporta SQL — usa un data source SQL`);
    }

    // detectSql DEVE essere SELECT/WITH
    const detectKind = classifyStatement(input.detectSql);
    if (detectKind !== 'select') {
      return Err(`detectSql deve essere SELECT/WITH, trovato "${detectKind}". Niente DML/DDL nelle detection.`);
    }

    // repairSql, se presente, DEVE essere UPDATE
    if (input.repairSql) {
      const repairKind = classifyStatement(input.repairSql);
      if (repairKind !== 'update') {
        return Err(`repairSql deve essere UPDATE, trovato "${repairKind}". Niente DELETE/INSERT/DDL.`);
      }
    }

    // Best-effort: il PK deve essere selezionato nella detect SQL.
    if (!input.detectSql.toLowerCase().includes(input.targetPkColumn.toLowerCase())) {
      return Err(`detectSql deve selezionare la colonna PK "${input.targetPkColumn}"`);
    }

    return Ok(null as unknown as DslRule); // validation-only; il caller costruisce la rule.
  }
}
