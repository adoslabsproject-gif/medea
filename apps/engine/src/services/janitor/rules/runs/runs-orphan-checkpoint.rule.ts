/**
 * Rule — runs.orphan_checkpoint
 *
 * Checkpoint con `run_id` che non esiste più nella tabella `runs`.
 * Sintomi:
 *   • run cancellato manualmente via UI (DELETE FROM runs) ma il
 *     CheckpointService non ha pulito il checkpoint associato
 *   • bug pregresso del checkpoint service
 *
 * Senza pulizia, il CheckpointRecoveryService al boot tenta di "resume"
 * questi checkpoint orfani → exception → log inquinati + occupazione
 * spazio inutile (i checkpoint contengono outputsById serializzato).
 *
 * Target: tabella `workflow_checkpoints` — NON `runs`. PK è `id` (INTEGER).
 *
 * Detect: `LEFT JOIN runs ON run_id` → catturiamo le righe checkpoint
 * con runs.id NULL.
 *
 * Repair: niente safe — il checkpoint orfano è inutile, vai a quar.
 */

import type { CodeRule, JanitorContext, DetectedRow } from '@/services/janitor/domain/index.js';
import { buildDetectedRow, systemRef } from '@/services/janitor/domain/index.js';

interface OrphanCheckpointRow {
  id: number;
  run_id: string;
  workflow_id: string;
  tenant_id: string | null;
  at_node_id: string;
  step_count: number;
  created_at: string;
}

export const runsOrphanCheckpointRule: CodeRule = {
  kind: 'code',
  id: 'system.runs.orphan_checkpoint',
  title: 'Checkpoint orfani (run_id inesistente)',
  description:
    'Cattura righe in workflow_checkpoints che puntano a un run cancellato. Il CheckpointRecoveryService prova a recuperarli a ogni boot e fallisce.',
  documentation: `
## Cosa fa
\`LEFT JOIN runs ON workflow_checkpoints.run_id = runs.id WHERE runs.id IS NULL\`
— cattura tutti i checkpoint orfani.

## Perché esiste
Il \`CheckpointService.save()\` viene chiamato ogni N nodi per garantire
crash recovery del workflow. Quando l'utente cancella un run dalla UI
(\`DELETE FROM runs WHERE id=...\`), il checkpoint corrispondente
DOVREBBE essere cancellato (FK CASCADE) ma SQLite non enforce le FK di
default su CREATE TABLE legacy. Risultato: checkpoint orfani che il
recovery sweeper al boot prova a ripristinare → eccezione.

## Parametri
Nessuno — la regola è binaria: orfano o no.

## Severity
Default \`warning\` — non blocca il sistema ma inquina i log e la
disk usage.
`.trim(),
  defaultDataSource: systemRef(),
  targetTable: 'workflow_checkpoints',
  targetPkColumn: 'id',
  tags: ['runs', 'checkpoints', 'integrity'],
  paramsSchema: [],
  defaultSeverity: 'warning',
  defaultSchedule: '0 */2 * * *', // ogni 2 ore (rara perché low-frequency problem)
  defaultMaxRowsPerRun: 500,

  async detect(ctx: JanitorContext): Promise<readonly DetectedRow[]> {
    if (typeof ctx.adapter.executeRaw !== 'function') {
      ctx.logger.warn('Adapter non supporta executeRaw — runs.orphan_checkpoint non applicabile');
      return [];
    }
    const sql = `
      SELECT c.id, c.run_id, c.workflow_id, c.tenant_id, c.at_node_id, c.step_count, c.created_at
      FROM workflow_checkpoints c
      LEFT JOIN runs r ON c.run_id = r.id
      WHERE r.id IS NULL
      ORDER BY c.created_at ASC
      LIMIT ${Math.floor(ctx.maxRows).toString()}
    `;
    const res = await ctx.adapter.executeRaw(sql);
    const rows = res.rows as unknown as OrphanCheckpointRow[];
    return rows.map((r) => buildDetectedRow({
      id: String(r.id),
      reason: `Checkpoint per run_id="${r.run_id}" che non esiste più (cancellato dall'utente o FK non enforced)`,
      severity: 'warning',
      raw: {
        id: r.id,
        run_id: r.run_id,
        workflow_id: r.workflow_id,
        tenant_id: r.tenant_id,
        at_node_id: r.at_node_id,
        step_count: r.step_count,
        created_at: r.created_at,
      },
      ...(r.tenant_id ? { tenantId: r.tenant_id } : {}),
    }));
  },
};
