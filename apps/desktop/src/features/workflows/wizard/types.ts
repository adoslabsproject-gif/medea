/**
 * Le forme del wizard di creazione.
 *
 * Il wizard esiste per una ragione precisa: costruire un workflow richiede
 * decine di passi e un minuto abbondante, e un minuto davanti a un cerchio che
 * gira è indistinguibile da un programma bloccato. Mostrare *cosa* sta facendo
 * — quale nodo cerca, cosa configura, cosa il controllo di qualità gli fa
 * rifare — trasforma l'attesa in qualcosa che si può giudicare.
 */

import type { QualityIssue } from '../quality';
import type { PlannedTable } from '../runtime';
import type { AgentStep } from '../scaffold';
import type { Workflow } from '../types';

/** Dove si trova il wizard: si va avanti, non si torna indietro. */
export type WizardStage = 'goal' | 'building' | 'review' | 'failed';

/** Una riga della cronologia: un passo dell'agente, in parole. */
export interface TraceEntry {
  step: number;
  tool: string;
  /** Cosa ha fatto, detto a chi non conosce i nomi degli strumenti. */
  label: string;
  /** Il dettaglio che conta: quale nodo, quale campo. */
  detail?: string;
  ok: boolean;
  error?: string;
  /** Cosa è stato chiesto allo strumento, per chi vuole guardare dentro. */
  args?: Record<string, unknown>;
  /** Cosa ha risposto. Insieme agli argomenti è il log del passo. */
  result?: unknown;
}

export interface WizardState {
  stage: WizardStage;
  goal: string;
  /** Da quanto sta lavorando: l'unico numero che l'utente guarda davvero. */
  elapsedMs: number;
  trace: TraceEntry[];
  /** I nodi già messi sul disegno, man mano che compaiono. */
  built: { id: string; defId: string }[];
  result?: Workflow;
  /** Quello che il workflow funziona lo stesso ma merita un'occhiata. */
  warnings: string[];
  issues: QualityIssue[];
  /**
   * Le tabelle che il workflow dà per esistenti e vanno create.
   *
   * Il tipo è quello vero di `table-plan`, non una copia allentata: quando
   * erano due forme diverse questo campo restava sempre vuoto e nessuno se ne
   * accorgeva, perché niente lo confrontava con qualcosa.
   */
  tables: PlannedTable[];
  reason?: string;
}

/** Il passo dell'agente da cui nasce una riga della cronologia. */
export type WizardStepSource = AgentStep;
