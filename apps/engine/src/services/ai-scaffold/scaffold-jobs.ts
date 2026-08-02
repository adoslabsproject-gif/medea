/**
 * Scaffold job store — disaccoppia la GENERAZIONE (server-side, Liara gira sul
 * server) dalla CONNESSIONE SSE del client.
 *
 * Problema (2026-06-11): una generazione complessa richiede ~90-100s per chiamata
 * LLM + retry (quality-gate / coverage) → 2-4 minuti totali. La connessione SSE
 * del client (o un proxy) cade a ~2min → il `done` non viene consegnato e il
 * RISULTATO — già prodotto sul server — viene PERSO. "Liara gira sul server,
 * perché ci ferma il timeout del client?" → giusto: non deve.
 *
 * Soluzione: ogni generazione ha un `jobId`. Il risultato viene PERSISTITO qui
 * appena pronto, INDIPENDENTEMENTE dallo stato della connessione SSE. Se lo stream
 * cade, il client recupera il risultato via GET /ai-scaffold/result/:jobId.
 *
 * In-memory (per-container, single-tenant) con TTL — la generazione vive minuti,
 * non serve persistenza durevole. Cleanup lazy sul get/set.
 */

export interface ScaffoldJob {
  status: 'running' | 'done' | 'error';
  result?: unknown;
  error?: string;
  httpStatus?: number;
  updatedAt: number;
}

const TTL_MS = 15 * 60_000; // 15 min: copre generazioni lunghe + finestra di retrieval
const MAX_JOBS = 200; // cap anti-leak (in pratica 1-2 generazioni concorrenti)
const jobs = new Map<string, ScaffoldJob>();

function cleanup(): void {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (now - j.updatedAt > TTL_MS) jobs.delete(id);
  }
  // Hard cap: se per qualche motivo si accumulano, droppa i più vecchi.
  if (jobs.size > MAX_JOBS) {
    const sorted = [...jobs.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (let i = 0; i < jobs.size - MAX_JOBS; i++) jobs.delete(sorted[i]![0]);
  }
}

export function createJob(id: string): void {
  cleanup();
  jobs.set(id, { status: 'running', updatedAt: Date.now() });
}

export function completeJob(id: string, result: unknown): void {
  jobs.set(id, { status: 'done', result, updatedAt: Date.now() });
}

export function failJob(id: string, error: string, httpStatus = 500): void {
  jobs.set(id, { status: 'error', error, httpStatus, updatedAt: Date.now() });
}

export function getJob(id: string): ScaffoldJob | undefined {
  cleanup();
  return jobs.get(id);
}

/** Solo per i test — svuota lo store. */
export function __resetScaffoldJobs(): void {
  jobs.clear();
}
