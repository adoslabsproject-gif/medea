/**
 * Janitor Cleanup executor — esegue una rule (o ciclo intero) come step
 * di un workflow. Delega al `JanitorRuntime` singleton.
 *
 * Branching output:
 *   • success    — esecuzione riuscita (sempre, anche con quarantine > 0)
 *   • detection  — rowsQuarantined > 0 (path "azione richiesta")
 *   • clean      — rowsQuarantined == 0 (path "tutto pulito")
 *   • error      — rule fallita (lock contention / DB down)
 *
 * Federico-grade error handling:
 *   • Rule not found → branch 'error' (non throw — il workflow continua sull'error path)
 *   • paramsOverride JSON malformed → branch 'error' con reason chiara
 *   • Janitor singleton non inizializzato → throw (system bug, non workflow bug)
 */

import type { NodeExecutor, NodeExecutionResult } from '@flowforge/nodes-stdlib';
import { getJanitor } from '@/services/janitor/janitor.singleton.js';
import { logger } from '@/lib/logger.js';

interface CleanupConfig {
  mode?: 'single' | 'cycle';
  ruleId?: string;
  dryRun?: boolean | string;
  failOnDetection?: boolean | string;
  maxRowsPerRun?: number | string;
  paramsOverride?: string | Record<string, unknown>;
  tagFilter?: string;
}

export const janitorCleanupExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const config = rawConfig as CleanupConfig;
  const janitor = getJanitor();

  const mode = config.mode ?? 'single';
  const dryRun = parseBool(config.dryRun);
  const failOnDetection = parseBool(config.failOnDetection);

  if (mode === 'cycle') {
    const tagFilter = (config.tagFilter ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const cycleArgs: Parameters<typeof janitor.executeCycle.execute>[0] = {
      tenantId: context.tenantId,
      triggeredBy: `workflow:${context.nodeId}`,
      dryRun,
      ...(tagFilter.length > 0 ? { tagFilter } : {}),
    };
    const cycleReport = await janitor.executeCycle.execute(cycleArgs);
    const totalQuarantined = cycleReport.rules.reduce((s, r) => s + r.rowsQuarantined, 0);
    const totalDetected = cycleReport.rules.reduce((s, r) => s + r.rowsDetected, 0);
    const anyError = cycleReport.rules.some((r) => !r.success);
    const branch = anyError ? 'error'
      : totalQuarantined > 0 ? 'detection'
      : 'clean';
    return {
      output: {
        mode: 'cycle',
        cycleId: cycleReport.cycleId,
        rulesExecuted: cycleReport.rulesExecuted,
        rulesSkippedLock: cycleReport.rulesSkippedLock,
        rulesSkippedDisabled: cycleReport.rulesSkippedDisabled,
        rowsDetected: totalDetected,
        rowsQuarantined: totalQuarantined,
        dryRun,
        durationMs: cycleReport.durationMs,
        reports: cycleReport.rules,
      },
      branch: failOnDetection && totalQuarantined > 0 ? 'error' : branch,
      durationMs: Date.now() - start,
    };
  }

  // mode === 'single'
  const ruleId = (config.ruleId ?? '').trim();
  if (!ruleId) {
    return errorOutput('ruleId obbligatorio per modalità "single"', start);
  }
  const rule = janitor.registry.get(ruleId);
  if (!rule) {
    return errorOutput(`Rule "${ruleId}" non trovata. Apri il pannello "Salute dati" per la lista delle regole disponibili.`, start);
  }

  // Parse paramsOverride se presente — può essere JSON string o object
  let overrideParams: Record<string, unknown> | undefined;
  if (config.paramsOverride !== undefined && config.paramsOverride !== null && config.paramsOverride !== '') {
    if (typeof config.paramsOverride === 'string') {
      try {
        const parsed = JSON.parse(config.paramsOverride) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return errorOutput('paramsOverride deve essere un JSON object', start);
        }
        overrideParams = parsed as Record<string, unknown>;
      } catch (err) {
        return errorOutput(`paramsOverride JSON non valido: ${err instanceof Error ? err.message : 'parse error'}`, start);
      }
    } else if (typeof config.paramsOverride === 'object') {
      overrideParams = config.paramsOverride;
    }
  }

  const maxRows = parseIntOrUndefined(config.maxRowsPerRun);

  const overrides = (overrideParams || maxRows !== undefined)
    ? {
      ...(overrideParams ? { params: overrideParams } : {}),
      ...(maxRows !== undefined ? { maxRowsPerRun: maxRows } : {}),
    }
    : undefined;

  try {
    const execArgs: Parameters<typeof janitor.executeRule.execute>[0] = {
      rule,
      tenantId: context.tenantId,
      triggeredBy: `workflow:${context.nodeId}`,
      dryRun,
      ...(overrides ? { overrides } : {}),
    };
    const result = await janitor.executeRule.execute(execArgs);
    const r = result.report;
    if (!r.success) {
      return {
        output: {
          mode: 'single',
          ruleId,
          success: false,
          error: r.error ?? 'rule failed',
          report: r,
        },
        branch: 'error',
        durationMs: Date.now() - start,
      };
    }
    const branch = (failOnDetection && r.rowsQuarantined > 0) ? 'error'
      : r.rowsQuarantined > 0 ? 'detection'
      : 'clean';
    return {
      output: {
        mode: 'single',
        ruleId,
        success: true,
        rowsDetected: r.rowsDetected,
        rowsRepaired: r.rowsRepaired,
        rowsQuarantined: r.rowsQuarantined,
        rowsSkipped: r.rowsSkipped,
        bySeverity: r.bySeverity,
        dryRun: r.dryRun,
        durationMs: r.durationMs,
        report: r,
        ...(dryRun ? { detected: result.detected } : {}),
      },
      branch: branch,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    logger.error({ err, ruleId, nodeId: context.nodeId }, 'janitorCleanupExecutor failed');
    return errorOutput(err instanceof Error ? err.message : 'errore esecuzione', start);
  }
};

function errorOutput(message: string, start: number): NodeExecutionResult {
  return {
    output: { success: false, error: message },
    branch: 'error',
    durationMs: Date.now() - start,
  };
}

function parseBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  return false;
}

function parseIntOrUndefined(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
