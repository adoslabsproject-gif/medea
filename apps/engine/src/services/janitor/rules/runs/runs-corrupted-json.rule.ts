/**
 * Rule — runs.corrupted_json
 *
 * Cattura i run il cui campo `steps_json` non è JSON parsabile. Sintomi:
 *   • Disk full durante write → JSON troncato
 *   • Crash durante UPDATE incrementale → JSON parziale (e.g. manca `]`)
 *   • Bug pregresso che ha scritto stringa raw invece di JSON
 *
 * Senza pulizia, ogni GET /runs/:id su quel run lancia eccezione →
 * Dashboard mostra errore generico, log inquinati.
 *
 * Detect: SELECT id, steps_json FROM runs; per ogni riga, try JSON.parse.
 * Se fallisce → DetectedRow con severity=critical.
 *
 * Repair: niente — il JSON troncato è non-recuperabile. Quarantine
 * conserva il raw originale per forensics.
 *
 * Limit: usa `maxRows` per evitare full-scan su tabelle enormi.
 * La query usa una window: ultimi N run modificati. Periodicità
 * ogni 30 min — più rara perché il problema è raro ma critico.
 */

import type { CodeRule, JanitorContext, DetectedRow } from '@/services/janitor/domain/index.js';
import { buildDetectedRow, systemRef } from '@/services/janitor/domain/index.js';

interface RunRow {
  id: string;
  workflow_id: string;
  tenant_id: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  steps_json: string;
}

export const runsCorruptedJsonRule: CodeRule = {
  kind: 'code',
  id: 'system.runs.corrupted_json',
  title: 'Run con steps_json corrotto / non parsabile',
  description:
    'Cerca run il cui campo steps_json non è JSON valido (disk full mid-write, crash durante UPDATE incrementale, char encoding rotto). Ogni GET /runs/:id su questi lancia eccezione.',
  documentation: `
## Cosa fa
Per ogni run nella finestra di scansione (default ultimi 500 modificati),
prova \`JSON.parse(steps_json)\`. Se fallisce, la riga è corrotta —
quarantena con il raw originale conservato per analisi forensic.

## Perché esiste
Il campo \`steps_json\` viene UPDATE-ato durante l'esecuzione (vedi
RunService incremental flush). Una condizione di disk-full o un crash
preciso può lasciare il JSON troncato (es. \`[{"nodeId":...\` senza \`]\`
finale). Ogni successivo \`JSON.parse()\` in GET /runs/:id throws,
quindi:
- Dashboard non riesce a renderizzare il run
- Il run non può essere selezionato
- Federico-grade: l'utente NON deve vedere errori opachi per dati corrotti

## Parametri
- **\`scanWindowSize\`**: quanti run scannare per esecuzione (default 500,
  ordinati per started_at DESC — scan a "rolling window"). Aumentalo se
  hai retention lunga e vuoi coprire più storico per ciclo.

## Limiti
- Su DB con milioni di run, una scansione completa è costosa. La rule
  scansiona solo gli ultimi N. Un cron mensile più aggressivo può
  coprire l'archivio se necessario.
- Mongo/Redis/Vector: non applicabile (la rule è hard-coded su
  data source SQL con tabella \`runs\`).
`.trim(),
  defaultDataSource: systemRef(),
  targetTable: 'runs',
  targetPkColumn: 'id',
  tags: ['runs', 'data-integrity', 'critical'],
  paramsSchema: [
    {
      name: 'scanWindowSize',
      label: 'Finestra di scansione',
      description: 'Numero di run da scannare ad ogni esecuzione (ordinati per started_at DESC).',
      type: 'number',
      required: true,
      default: 500,
      min: 50,
      max: 5000,
      step: 50,
    },
  ],
  defaultSeverity: 'critical',
  defaultSchedule: '*/30 * * * *',
  defaultMaxRowsPerRun: 200,

  async detect(ctx: JanitorContext): Promise<readonly DetectedRow[]> {
    const scanWindow = ctx.params.scanWindowSize as number;
    if (typeof ctx.adapter.executeRaw !== 'function') {
      ctx.logger.warn('Adapter non supporta executeRaw — runs.corrupted_json non applicabile');
      return [];
    }
    const sql = `
      SELECT id, workflow_id, tenant_id, status, started_at, ended_at, steps_json
      FROM runs
      ORDER BY started_at DESC
      LIMIT ${Math.floor(scanWindow).toString()}
    `;
    const res = await ctx.adapter.executeRaw(sql);
    const rows = res.rows as unknown as RunRow[];
    const corrupted: DetectedRow[] = [];
    for (const r of rows) {
      if (corrupted.length >= ctx.maxRows) break;
      const issue = checkStepsJson(r.steps_json);
      if (!issue) continue;
      corrupted.push(buildDetectedRow({
        id: r.id,
        reason: `steps_json corrotto: ${issue}`,
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
    }
    return corrupted;
  },
};

/**
 * Verifica se `steps_json` è JSON parsabile + è un array (la struttura
 * attesa). Ritorna una stringa di descrizione del problema se rotto,
 * null se OK. Usiamo questa forma "describe" così la `reason` della
 * DetectedRow è più informativa che "JSON parse error".
 */
function checkStepsJson(raw: string): string | null {
  if (raw == null) return 'campo NULL';
  if (typeof raw !== 'string') return `tipo inatteso: ${typeof raw}`;
  if (raw.trim() === '') return 'stringa vuota';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'parse error';
    // Caso comune: JSON troncato → di solito SyntaxError contiene
    // "Unexpected end of JSON input" o "Unexpected token in JSON".
    if (/end of json/i.test(msg)) return 'JSON troncato (probabile crash mid-write)';
    return `JSON non valido (${msg.slice(0, 80)})`;
  }
  if (!Array.isArray(parsed)) {
    return `formato inatteso: array previsto, trovato ${typeof parsed}`;
  }
  return null;
}
