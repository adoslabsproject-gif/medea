/**
 * CONTRATTO anti-orfano — forma FORTE (2026-06-15): OGNI EventName del bus ha un
 * consumer REALE. Niente allowlist "noti ma non consumati": gli eventi orfani
 * delle famiglie janitor / loop / iteration sono stati o cablati
 * (janitor.detection → notifica in-app, canale diverso) o rimossi (loop e
 * iteration — osservabilità ridondante con run.step). Da ora la union contiene
 * SOLO eventi con listener.
 *
 * Perché: classe di bug ricorrente "evento emesso ma ascoltato da nessuno" (es.
 * run.cancelled/workflow.* prima dei fix) → run bloccati, codice morto. Questo
 * test inchioda lo stato: se qualcuno AGGIUNGE un evento alla union senza
 * cablare un consumer → ROSSO. E verifica che i CONSUMED siano DAVVERO
 * referenziati nei file consumer (no commento-fake).
 *
 * Source-inspection (come create-contract.test.ts): legge la union dal sorgente
 * + i file consumer reali (dashboard hook + run drawer dell'editor).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(HERE, rel), 'utf8');

/** Estrae i membri della union EventName dal sorgente. */
function eventNames(): string[] {
  const src = read('./event-bus.ts');
  const m = /export type EventName\s*=([\s\S]*?);/.exec(src);
  expect(m, 'union EventName non trovata').toBeTruthy();
  return [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

// Eventi con un CONSUMER reale (verificato sotto contro i file consumer).
// Forma forte: questo set DEVE coincidere con l'intera union — nessun orfano.
const CONSUMED = new Set<string>([
  'run.started', 'run.step', 'run.step.log', 'run.completed', 'run.errored',
  'run.deleted', 'run.paused', 'run.resumed', 'run.cancelled',
  'workflow.created', 'workflow.updated', 'workflow.deleted',
]);

describe('event-bus — ZERO eventi orfani (forma forte)', () => {
  const names = eventNames();

  it('sanity: la union ha gli eventi run.* noti', () => {
    expect(names).toEqual(expect.arrayContaining(['run.started', 'run.cancelled', 'run.step']));
    expect(names.length).toBeGreaterThanOrEqual(12);
  });

  it('OGNI EventName è CONSUMED — nessun evento senza consumer (no allowlist)', () => {
    const orphan = names.filter((n) => !CONSUMED.has(n));
    expect(orphan, `eventi senza consumer (cabla o rimuovi dalla union): ${orphan.join(', ')}`).toEqual([]);
  });

  it('nessun CONSUMED dichiarato che NON esiste più nella union (lista aggiornata)', () => {
    const stale = [...CONSUMED].filter((n) => !names.includes(n));
    expect(stale, `CONSUMED stantii (rimossi dalla union): ${stale.join(', ')}`).toEqual([]);
  });

  it('🔒 ogni evento CONSUMED è DAVVERO referenziato in un file consumer (no commento-fake)', () => {
    // I due consumer SSE reali del client.
    const consumers =
      read('../../../flowforge-editor/src/views/dashboard/useDashboardStream.ts') +
      read('../../../flowforge-editor/src/views/welcome/WorkflowRunDrawer.tsx');
    const missing = [...CONSUMED].filter((ev) => !consumers.includes(`'${ev}'`));
    expect(missing, `marcati CONSUMED ma nessun listener trovato: ${missing.join(', ')}`).toEqual([]);
  });

  it('🔒 nessun evento orfano storico (janitor.*/loop.*/iteration.*) è rientrato nella union', () => {
    const banned = names.filter((n) => /^(janitor|loop|iteration)\./.test(n));
    expect(
      banned,
      `eventi orfani rientrati senza consumer: ${banned.join(', ')} — se servono, cablane prima il consumer`,
    ).toEqual([]);
  });
});
