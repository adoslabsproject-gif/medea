/**
 * Le esecuzioni di un workflow e i passi che le compongono.
 *
 * La forma è quella del runtime di FlowForge: stessi stati, stessi campi per
 * passo. Serve perché un giorno un'esecuzione avvenuta sul server e una
 * avvenuta qui devono potersi leggere nella stessa schermata.
 */

export type RunStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'partial'
  | 'error'
  | 'paused'
  | 'cancelled';

export type StepStatus = 'success' | 'error' | 'skipped' | 'running';

/** Cosa è successo su un singolo nodo. */
export interface RunStep {
  nodeId: string;
  defId?: string;
  status: StepStatus;
  durationMs?: number;
  /** Quello che il nodo ha prodotto, come lo ha prodotto. */
  output?: string;
  error?: string;
  input?: string;
}

/** La riga dell'elenco: senza i passi, che pesano. */
export interface RunSummary {
  id: string;
  workflowId: number;
  status: RunStatus;
  triggerType?: string;
  errorCount: number;
  totalDurationMs?: number;
  stepCount: number;
  startedAt: string;
  endedAt?: string;
}

/** L'esecuzione completa, con i passi. */
export interface RunRecord {
  id: string;
  workflowId: number;
  status: RunStatus;
  triggerType?: string;
  triggerPayloadJson?: string;
  stepsJson: string;
  errorCount: number;
  totalDurationMs?: number;
  triggeredBy?: string;
  startedAt: string;
  endedAt?: string;
}

/** I passi di un'esecuzione. Un JSON illeggibile dà un elenco vuoto: si
 *  perde il dettaglio, non la schermata. */
export function parseSteps(record: Pick<RunRecord, 'stepsJson'>): RunStep[] {
  try {
    const parsed: unknown = JSON.parse(record.stepsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const s = item as Record<string, unknown>;
      if (typeof s.nodeId !== 'string') return [];
      return [
        {
          nodeId: s.nodeId,
          ...(typeof s.defId === 'string' ? { defId: s.defId } : {}),
          status: isStepStatus(s.status) ? s.status : 'success',
          ...(typeof s.durationMs === 'number' ? { durationMs: s.durationMs } : {}),
          ...(typeof s.output === 'string' ? { output: s.output } : {}),
          ...(typeof s.error === 'string' ? { error: s.error } : {}),
          ...(typeof s.input === 'string' ? { input: s.input } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

function isStepStatus(value: unknown): value is StepStatus {
  return value === 'success' || value === 'error' || value === 'skipped' || value === 'running';
}

/** Come si chiama uno stato, in italiano. */
export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  pending: 'in attesa',
  running: 'in corso',
  success: 'riuscita',
  partial: 'parziale',
  error: 'fallita',
  paused: 'in pausa',
  cancelled: 'annullata',
};

export const STEP_STATUS_LABEL: Record<StepStatus, string> = {
  success: 'ok',
  error: 'errore',
  skipped: 'saltato',
  running: 'in corso',
};

/** Una durata leggibile: i millisecondi contano solo quando sono pochi. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${String(Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${String(minutes)} min ${String(seconds)} s`;
}

/** Quando è partita, in forma breve: l'ora se è oggi, la data altrimenti. */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : date.toLocaleString('it-IT', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
}
