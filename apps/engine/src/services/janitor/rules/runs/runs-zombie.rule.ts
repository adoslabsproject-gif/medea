/**
 * Rule — runs.zombie
 *
 * Cattura i run "zombie": status='running' o 'pending' da troppo tempo
 * senza che siano stati aggiornati. Sintomo tipico di:
 *   • Crash del runtime durante engine.run()
 *   • Container OOM-killed mentre il workflow elaborava
 *   • Network split tra worker e DB
 *
 * Senza questa rule, gli zombie restano in stato 'running' per sempre,
 * la dashboard mostra "in corso" fasullo, e i workflow con
 * `concurrencyLimit > 0` si bloccano (il contatore inflight non scende).
 *
 * Detect criteria:
 *   • status IN ('running', 'pending')
 *   • started_at <= now - thresholdMs
 *   • (steps_json è ancora '[]' OPPURE ended_at è NULL)
 *
 * Repair: NESSUN repair safe — uno zombie è zombie per crash, non
 * possiamo "completare" il run inventando step. → quarantine diretta,
 * marca come 'error' nel restore (futuro improvement).
 *
 * Default schedule: ogni 5 min ('star/5 * * * *')
 * Default threshold: 30 minuti
 */

import type { CodeRule, JanitorContext, DetectedRow } from '@/services/janitor/domain/index.js';
import { buildDetectedRow, systemRef } from '@/services/janitor/domain/index.js';
import type { RawQueryResult } from '@medea/engine-db-studio-engine';

interface ZombieRow {
  id: string;
  workflow_id: string;
  tenant_id: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  steps_json: string;
}

export const runsZombieRule: CodeRule = {
  kind: 'code',
  id: 'system.runs.zombie',
  title: 'Run zombie (status running senza heartbeat)',
  description:
    'Cattura i run in stato "running" o "pending" da più di N minuti, sintomo di crash runtime o OOM. Senza pulizia, restano in dashboard come "in corso" perpetuamente.',
  documentation: `
## Cosa fa
Cerca nella tabella \`runs\` i record con \`status IN ('running','pending')\`
e \`started_at\` più vecchio del parametro \`zombieThresholdMs\` (default
30 minuti). Sposta in quarantena le righe trovate.

## Perché esiste
Il runtime FlowForge può crashare a metà di un'esecuzione (OOM, kill -9,
errore non gestito). In quel caso il record \`runs\` resta in
\`status='running'\` per sempre — niente lo libera. I sintomi visibili:
- Dashboard mostra "in corso" su un workflow fermo da ore
- Workflow con \`concurrencyLimit\` configurato si bloccano (il counter
  inflight non scende mai)
- Le metriche di success rate sono inquinate

## Parametri
- **\`zombieThresholdMs\`** (default 1.800.000 = 30 min): un run è zombie
  se \`started_at + zombieThresholdMs < now\`. Aumentalo se hai
  workflow legittimi che durano più di 30 min, altrimenti diminuiscilo
  per pulire più aggressivamente.

## Effetti
Le righe vengono spostate in \`quarantined_rows\` con \`severity='critical'\`.
Da UI puoi:
- **Restore**: re-inserisce in \`runs\` (sconsigliato — è zombie).
- **Purge**: hard-delete con audit log del JSON completo.
`.trim(),
  defaultDataSource: systemRef(),
  targetTable: 'runs',
  targetPkColumn: 'id',
  tags: ['runs', 'recovery', 'critical'],
  paramsSchema: [
    {
      name: 'zombieThresholdMs',
      label: 'Soglia zombie (ms)',
      description:
        'Un run è considerato zombie se la sua started_at è più vecchia di questo valore (in millisecondi) E non ha endedAt. Default 30 minuti.',
      type: 'duration_ms',
      required: true,
      default: 1_800_000, // 30 min
      minMs: 60_000,      // 1 min minimo (per non catturare run normali)
      maxMs: 86_400_000,  // 24h massimo
    },
  ],
  defaultSeverity: 'critical',
  defaultSchedule: '*/5 * * * *',
  defaultMaxRowsPerRun: 500,

  async detect(ctx: JanitorContext): Promise<readonly DetectedRow[]> {
    const threshold = ctx.params.zombieThresholdMs as number;
    const cutoffIso = new Date(ctx.now.getTime() - threshold).toISOString();
    if (typeof ctx.adapter.executeRaw !== 'function') {
      ctx.logger.warn('Adapter non supporta executeRaw — runs.zombie non applicabile');
      return [];
    }
    const sql = `
      SELECT id, workflow_id, tenant_id, status, started_at, ended_at, steps_json
      FROM runs
      WHERE status IN ('running', 'pending')
        AND started_at <= '${escapeForSqlLiteral(cutoffIso)}'
      ORDER BY started_at ASC
      LIMIT ${Math.floor(ctx.maxRows).toString()}
    `;
    const res: RawQueryResult = await ctx.adapter.executeRaw(sql);
    const rows = res.rows as unknown as ZombieRow[];
    return rows.map((r) => buildDetectedRow({
      id: r.id,
      reason: `Status=${r.status} da ${humanizeAge(ctx.now, r.started_at)} (soglia ${humanMs(threshold)})`,
      severity: 'critical',
      raw: {
        id: r.id,
        workflow_id: r.workflow_id,
        tenant_id: r.tenant_id,
        status: r.status,
        started_at: r.started_at,
        ended_at: r.ended_at,
        steps_json: r.steps_json,
      },
      ...(r.tenant_id ? { tenantId: r.tenant_id } : {}),
    }));
  },
};

// ────────────────────────────────────────────────────────────────────
// Helpers interni — niente import esterni per evitare side-effect
// ────────────────────────────────────────────────────────────────────

function escapeForSqlLiteral(s: string): string {
  // Defense in-depth: il valore arriva da new Date() controllato da noi,
  // ma evitiamo SQL injection anche in caso di refactor sbagliato.
  return s.replace(/'/g, "''");
}

function humanizeAge(now: Date, startedAtIso: string): string {
  const startedAt = new Date(startedAtIso).getTime();
  const ageMs = now.getTime() - startedAt;
  return humanMs(ageMs);
}

function humanMs(ms: number): string {
  if (ms < 1000) return `${ms.toString()}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(0)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}g`;
}
