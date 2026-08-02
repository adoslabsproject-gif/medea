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

// Gli eventi che il motore dichiara di emettere. Forma forte: questo set DEVE
// coincidere con l'intera union — un evento nella union e non qui è un evento
// che nessuno ha mai cablato.
const CONSUMED = new Set<string>([
  'run.started', 'run.step', 'run.step.log', 'run.completed', 'run.errored',
  'run.deleted', 'run.paused', 'run.resumed', 'run.cancelled',
  'workflow.created', 'workflow.updated', 'workflow.deleted',
]);

// Di quegli eventi, quelli che l'interfaccia di Medea ascolta davvero oggi.
//
// Gli altri il motore li emette lo stesso: li consumava l'editor web da cui il
// motore deriva, e in Medea non hanno ancora un ascoltatore. Non è un guasto —
// è il conto esatto di quanto della superficie del motore l'app usa per ora.
// Se un listener sparisce, il test qui sotto se ne accorge.
const CONSUMED_BY_DESKTOP = new Set<string>([
  'run.started', 'run.completed', 'run.errored', 'run.paused', 'run.cancelled',
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

  it('🔒 gli eventi che il desktop dichiara di ascoltare hanno DAVVERO un listener', () => {
    // I consumer SSE reali: quelli di Medea, sotto `features/workflows/runtime`.
    // Prima del 2026-08-02 questa lettura puntava alle viste dell'editor web di
    // provenienza, che in questo repository non esistono.
    const consumers =
      read('../../../desktop/src/features/workflows/runtime/sse.ts') +
      read('../../../desktop/src/features/workflows/runtime/watcher.ts') +
      read('../../../desktop/src/features/workflows/runtime/run-mapping.ts');
    const missing = [...CONSUMED_BY_DESKTOP].filter((ev) => !consumers.includes(`'${ev}'`));
    expect(missing, `dichiarati ascoltati ma nessun listener trovato: ${missing.join(', ')}`).toEqual([]);
  });

  it('gli eventi ascoltati dal desktop appartengono tutti alla union', () => {
    const unknown = [...CONSUMED_BY_DESKTOP].filter((ev) => !names.includes(ev));
    expect(unknown, `ascoltati ma non più emessi: ${unknown.join(', ')}`).toEqual([]);
  });

  it('🔒 nessun evento orfano storico (janitor.*/loop.*/iteration.*) è rientrato nella union', () => {
    const banned = names.filter((n) => /^(janitor|loop|iteration)\./.test(n));
    expect(
      banned,
      `eventi orfani rientrati senza consumer: ${banned.join(', ')} — se servono, cablane prima il consumer`,
    ).toEqual([]);
  });
});
