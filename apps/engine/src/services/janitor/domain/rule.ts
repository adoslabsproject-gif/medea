/**
 * Domain — Rule contract.
 *
 * Una regola di pulizia ha 3 momenti:
 *
 *   1. `detect(ctx)` — query read-only sulla tabella target, ritorna le
 *      righe corrotte secondo i criteri della regola.
 *   2. `repair(ctx, rows)` — OPZIONALE — tenta un fix non distruttivo
 *      (es. ricalcola error_count) PRIMA della quarantena. Le righe
 *      "riparate" vengono rimosse dal set quarantine.
 *   3. Quarantine — il framework, NON la regola, sposta le righe restanti
 *      in `quarantined_rows`. La regola non scrive mai DELETE/INSERT
 *      direttamente sulla live table.
 *
 * Federico-grade: separazione netta detect/repair/cleanup. Una regola
 * non può "fare di tutto" — fa SOLO la sua detect (+ repair opzionale).
 * Il cleanup è uniforme cross-rule, gestito dal core.
 */

import type { Logger } from 'pino';
import type { IDatabaseAdapter } from '@medea/engine-db-studio-engine';
import type { DataSourceRef } from './data-source-ref.js';
import type { CorruptionSeverity } from './severity.js';
import type { RuleParamSchema } from './rule-params-schema.js';
import type { DetectedRow } from './detected-row.js';

// ────────────────────────────────────────────────────────────────────
// Context iniettato a ogni chiamata della rule
// ────────────────────────────────────────────────────────────────────

export interface JanitorContext {
  /** Adapter connesso al data source target. */
  readonly adapter: IDatabaseAdapter;
  /** Tabella di destinazione (nome SQL/collection). */
  readonly targetTable: string;
  /** Colonna PK del target. */
  readonly targetPkColumn: string;
  /**
   * Istante "now" deciso UNA volta all'inizio del run. Tutte le query
   * temporali della rule devono usarlo per determinism (per i test).
   */
  readonly now: Date;
  /** Se true: solo detect, niente repair/quarantine. */
  readonly dryRun: boolean;
  /** Chi ha innescato. 'scheduler' | `admin:<userId>` | `boot-recovery`. */
  readonly triggeredBy: string;
  /** Logger con `{ ruleId, runId }` già bindati. */
  readonly logger: Logger;
  /** Parametri user-configurati validati contro `paramsSchema`. */
  readonly params: Readonly<Record<string, unknown>>;
  /**
   * Limite massimo di righe da elaborare in questa invocazione.
   * Il framework lo imposta a `Math.min(rule.defaultMaxRowsPerRun,
   * config.maxRowsPerRun)`. detect() DEVE rispettarlo (es. LIMIT N).
   */
  readonly maxRows: number;
  /**
   * Tenant scope: presente quando la rule gira per uno specifico tenant
   * (es. tabella tenant). Per regole 'system' è undefined.
   */
  readonly tenantId?: string;
}

// ────────────────────────────────────────────────────────────────────
// CodeRule (definita in TypeScript, deploy con il binary)
// ────────────────────────────────────────────────────────────────────

export interface CodeRule {
  readonly kind: 'code';
  /** Identifier stabile + unique. MAI cambiare retroattivamente. */
  readonly id: string;
  /** Titolo breve per UI list. */
  readonly title: string;
  /** Descrizione 1-2 frasi. Italiano. */
  readonly description: string;
  /** Documentazione lunga (markdown). Rendered in UI help panel. */
  readonly documentation?: string;
  /** Data source di default (overridabile da config). */
  readonly defaultDataSource: DataSourceRef;
  /** Tabella target. */
  readonly targetTable: string;
  /** Colonna PK del target. */
  readonly targetPkColumn: string;
  /** Tag per filter UI. */
  readonly tags: readonly string[];
  /** Schema parametri configurabili. */
  readonly paramsSchema: readonly RuleParamSchema[];
  /** Severity di default (UI può overridare). */
  readonly defaultSeverity: CorruptionSeverity;
  /** Schedule cron-style di default. */
  readonly defaultSchedule: string;
  /** Max rows/run di default. */
  readonly defaultMaxRowsPerRun: number;

  /** Detect — read-only. */
  detect(ctx: JanitorContext): Promise<readonly DetectedRow[]>;

  /**
   * Repair opzionale. SOLO UPDATE non-distruttivi. Mai DELETE.
   * Ritorna gli id delle righe che NON necessitano più di quarantine.
   */
  repair?(ctx: JanitorContext, rows: readonly DetectedRow[]): Promise<{
    readonly repairedIds: readonly string[];
  }>;
}

// ────────────────────────────────────────────────────────────────────
// DslRule (definita via UI dal tenant)
// ────────────────────────────────────────────────────────────────────

export interface DslRule {
  readonly kind: 'dsl';
  readonly id: string;
  readonly tenantId: string;
  readonly title: string;
  readonly description: string;
  readonly dataSourceRef: DataSourceRef;
  readonly targetTable: string;
  readonly targetPkColumn: string;
  /** DEVE essere SELECT/WITH only — validato in save. */
  readonly detectSql: string;
  /** Opzionale — solo UPDATE — validato in save. */
  readonly repairSql?: string;
  /** Placeholders sostituiti server-side prima di executeRaw. */
  readonly placeholders: Readonly<Record<string, string | number | boolean>>;
  readonly tags: readonly string[];
  readonly defaultSeverity: CorruptionSeverity;
  readonly defaultSchedule: string;
  readonly defaultMaxRowsPerRun: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy?: string;
}

export type Rule = CodeRule | DslRule;

export function isCodeRule(r: Rule): r is CodeRule { return r.kind === 'code'; }
export function isDslRule(r: Rule): r is DslRule { return r.kind === 'dsl'; }

/** ID univoco enforcement: `<scope>.<table>.<problem>` per code, `dsl_<nanoid>` per dsl. */
export const CODE_RULE_ID_RE = /^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
export const DSL_RULE_ID_RE = /^dsl_[a-zA-Z0-9_-]{6,32}$/;

export function isValidRuleId(id: string): boolean {
  return CODE_RULE_ID_RE.test(id) || DSL_RULE_ID_RE.test(id);
}
