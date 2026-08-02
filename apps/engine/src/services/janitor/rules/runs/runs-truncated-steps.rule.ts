/**
 * Rule — runs.truncated_steps
 *
 * Run con `ended_at` valorizzato MA l'ultimo step nel JSON ha
 * `status='running'`. Sintomo classico di restart del runtime durante
 * la persistenza finale: lo status del run è stato chiuso (per
 * coerenza), ma gli step interni sono rimasti a metà.
 *
 * Questo problema BLOCCA il restart "pulito" del workflow perché:
 *   • Il replay parte dallo step rimasto 'running' e lo riesegue.
 *   • Se lo step aveva side effect (send_email, db_insert), succede 2x.
 *
 * Repair (opzionale): chiudere l'ultimo step a `status='error'` con
 * `error='restart-recovery: step terminato per restart del runtime'`.
 * Questa repair viene applicata SOLO se l'utente ha `enableAutoRepair=true`
 * nei params. Altrimenti quarantine.
 */

import type { CodeRule, JanitorContext, DetectedRow } from '@/services/janitor/domain/index.js';
import { buildDetectedRow, systemRef } from '@/services/janitor/domain/index.js';

interface StepLike {
  nodeId?: string;
  status?: string;
  endedAt?: number;
}

interface RunRow {
  id: string;
  workflow_id: string;
  tenant_id: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  steps_json: string;
  error_count: number;
}

export const runsTruncatedStepsRule: CodeRule = {
  kind: 'code',
  id: 'system.runs.truncated_steps',
  title: 'Run con step troncati (incoerenza endedAt vs step status)',
  description:
    'Cattura run con ended_at valorizzato MA con uno o più step ancora in status="running". Sintomo di restart durante la persistenza — bloccherà il replay del workflow.',
  documentation: `
## Cosa fa
Per i run con \`ended_at IS NOT NULL\` (il runtime ha chiuso il record),
parsa \`steps_json\` e verifica che nessuno step abbia \`status='running'\`.
Se trovato → incoerenza.

## Perché esiste
Durante \`RunService.run()\` la chiusura del record è:
1. INSERT row con status='running'
2. Eventi step → UPDATE incrementale di steps_json
3. UPDATE finale: status='success'|'partial'|'error' + ended_at + steps_json finale

Se il processo crasha TRA il punto 3 (UPDATE status/ended_at) e il
flush degli step interni, ci ritroviamo con un run "chiuso" che ha step
fermi a 'running'. Al successivo replay, il workflow tenta di
ri-eseguire lo step "running" — duplicate side effect.

## Repair
Se \`enableAutoRepair=true\`, la rule RIPARA aggiornando direttamente
steps_json: ogni step 'running' diventa 'error' con messaggio
"restart-recovery". \`error_count\` viene incrementato di conseguenza.
La quarantine viene saltata per i record riparati.

Se \`enableAutoRepair=false\`, quarantine come al solito → l'utente
decide manualmente.

## Parametri
- **\`enableAutoRepair\`** (default false): se true, ripara invece di
  quarantinare. Comodo per ambienti dev/staging dove preferisci che il
  sistema si auto-curi.
`.trim(),
  defaultDataSource: systemRef(),
  targetTable: 'runs',
  targetPkColumn: 'id',
  tags: ['runs', 'data-integrity', 'recovery'],
  paramsSchema: [
    {
      name: 'enableAutoRepair',
      label: 'Auto-repair (UPDATE step a "error")',
      description:
        'Se attivo, marca gli step "running" come "error" invece di mettere il run intero in quarantena. Federico-grade: lascialo OFF in produzione finché non hai validato il pattern.',
      type: 'boolean',
      required: true,
      default: false,
    },
  ],
  defaultSeverity: 'warning',
  defaultSchedule: '*/15 * * * *',
  defaultMaxRowsPerRun: 300,

  async detect(ctx: JanitorContext): Promise<readonly DetectedRow[]> {
    if (typeof ctx.adapter.executeRaw !== 'function') {
      ctx.logger.warn('Adapter non supporta executeRaw — runs.truncated_steps non applicabile');
      return [];
    }
    const sql = `
      SELECT id, workflow_id, tenant_id, status, started_at, ended_at, steps_json, error_count
      FROM runs
      WHERE ended_at IS NOT NULL
      ORDER BY ended_at DESC
      LIMIT ${Math.floor(ctx.maxRows * 5).toString()}
    `;
    const res = await ctx.adapter.executeRaw(sql);
    const rows = res.rows as unknown as RunRow[];
    const out: DetectedRow[] = [];
    for (const r of rows) {
      if (out.length >= ctx.maxRows) break;
      const runningSteps = countRunningSteps(r.steps_json);
      if (runningSteps === 0) continue;
      out.push(
        buildDetectedRow({
          id: r.id,
          reason: `Run chiuso (ended_at=${r.ended_at ?? '?'}) ma ${runningSteps.toString()} step ancora in status='running'`,
          severity: 'warning',
          raw: {
            id: r.id,
            workflow_id: r.workflow_id,
            tenant_id: r.tenant_id,
            status: r.status,
            started_at: r.started_at,
            ended_at: r.ended_at,
            steps_json: r.steps_json,
            error_count: r.error_count,
          },
          ...(r.tenant_id ? { tenantId: r.tenant_id } : {}),
        }),
      );
    }
    return out;
  },

  async repair(
    ctx: JanitorContext,
    rows: readonly DetectedRow[],
  ): Promise<{ repairedIds: readonly string[] }> {
    const enabled = ctx.params.enableAutoRepair === true;
    if (!enabled) return { repairedIds: [] };
    if (typeof ctx.adapter.executeRaw !== 'function') return { repairedIds: [] };
    if (ctx.dryRun) return { repairedIds: [] };

    const repaired: string[] = [];
    for (const r of rows) {
      const rawJson = r.raw.steps_json;
      if (typeof rawJson !== 'string') continue;
      let parsed: StepLike[];
      try {
        const candidate = JSON.parse(rawJson) as unknown;
        if (!Array.isArray(candidate)) continue;
        parsed = candidate as StepLike[];
      } catch {
        continue; // se JSON è rotto, runs-corrupted-json se ne occupa
      }
      let mutated = 0;
      const patched = parsed.map((s) => {
        if (s.status !== 'running') return s;
        mutated += 1;
        return {
          ...s,
          status: 'error',
          error: 'restart-recovery: step terminato per restart del runtime',
          endedAt: s.endedAt ?? Date.now(),
        };
      });
      if (mutated === 0) continue;
      const newErrorCount =
        (typeof r.raw.error_count === 'number' ? r.raw.error_count : 0) + mutated;
      const newStepsJson = JSON.stringify(patched).replace(/'/g, "''");
      const escId = String(r.id).replace(/'/g, "''");
      await ctx.adapter.executeRaw(`
        UPDATE runs
        SET steps_json = '${newStepsJson}',
            error_count = ${newErrorCount.toString()},
            status = 'partial'
        WHERE id = '${escId}'
      `);
      repaired.push(r.id);
    }
    return { repairedIds: repaired };
  },
};

function countRunningSteps(rawJson: string): number {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return 0;
    let count = 0;
    for (const s of parsed) {
      if (typeof s === 'object' && s !== null && (s as StepLike).status === 'running') {
        count += 1;
      }
    }
    return count;
  } catch {
    return 0;
  }
}
