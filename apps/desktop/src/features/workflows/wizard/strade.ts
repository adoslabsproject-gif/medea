/**
 * Le tre strade per arrivare a un workflow, in ordine di forza.
 *
 * Sono tentativi in cascata, e l'ordine non è una preferenza: è quanto ciascuna
 * strada sa fare.
 *
 *  1. **Il motore.** La pipeline vera, quella di FlowForge, che gira già
 *     accanto a noi: auto-configurazione deterministica dei campi, grammatica
 *     costruita sul tipo di ciascun nodo, riparazione guidata dal validatore
 *     del catalogo. Quando c'è, è questa.
 *  2. **Scrivere in una volta sola, qui.** Meno mezzi, ma regge con qualunque
 *     modello: chiede di *scrivere* un JSON conforme, non di *pilotare* una
 *     costruzione.
 *  3. **Costruire a passi, con gli strumenti.** L'unica che sa anche
 *     modificare, e la più esigente: vuole un modello che sappia chiamare
 *     strumenti nel formato atteso.
 *
 * Vivono qui e non dentro il hook perché la scelta di quale strada prendere è
 * una decisione di prodotto, non di stato React — e perché un hook che tiene
 * anche questo supera le trecento righe, che è dove smette di stare in testa.
 *
 * @module features/workflows/wizard/strade
 */

import type { QualityIssue } from '../quality';
import {
  createAgentChat,
  createScaffoldLlm,
  generaColMotore,
  runScaffold,
  runWorkflowAgent,
  type AgentStep,
} from '../scaffold';
import type { ScaffoldOutput } from '../scaffold';
import type { NodeDef, Workflow } from '../types';

export interface EsitoStradeOk {
  ok: true;
  workflow: Workflow;
  avvisi: readonly string[];
  /**
   * Le tabelle che il motore dichiara di voler creare, coi loro tipi.
   *
   * Assente dalle altre due strade, che non le dichiarano: in quel caso il
   * piano si deduce dal workflow, che è comunque la fonte affidabile su QUALI
   * tabelle servono. Questo elenco serve solo ad affinarne i tipi, e finora
   * veniva calcolato da `motore.ts` e buttato via qui.
   */
  tabelle?: ScaffoldOutput['tablesToCreate'];
}

export interface EsitoStradeNo {
  ok: false;
  motivo: string;
  problemi: readonly QualityIssue[];
}

export type EsitoStrade = EsitoStradeOk | EsitoStradeNo;

export interface ContestoStrade {
  goal: string;
  catalogo: NodeDef[];
  signal: AbortSignal;
  /** Un passo compiuto da una delle strade, già pronto per la cronologia. */
  onStep: (passo: AgentStep) => void;
  /** Una fase che non passa dagli strumenti ma va comunque mostrata. */
  annota: (tool: string, args: Record<string, unknown>, result: unknown) => void;
  onToken: (usati: { input: number; output: number }) => void;
  /** Vero se nel frattempo qualcuno ha fermato tutto: si smette e basta. */
  interrotto: () => boolean;
}

/**
 * Prova le strade finché una consegna. `null` se è stato fermato a metà: non
 * è né riuscito né fallito, e trattarlo come un fallimento mostrerebbe un
 * errore a chi ha premuto «Interrompi».
 */
export async function costruisciWorkflow(ctx: ContestoStrade): Promise<EsitoStrade | null> {
  // ── Prima strada: il motore. ──
  //
  // Se non c'è — non ancora partito, o provider che la sua richiesta non sa
  // esprimere — si scende. Se invece c'è e rifiuta, ci si ferma: rifare lo
  // stesso lavoro con meno mezzi darebbe qualcosa di peggiore, e consegnarlo
  // come se fosse la stessa cosa sarebbe una bugia.
  const dalMotore = await generaColMotore({
    goal: ctx.goal,
    signal: ctx.signal,
    onStep: ctx.onStep,
    onToken: ctx.onToken,
  });
  if (ctx.interrotto()) return null;

  if (dalMotore.ok) {
    return {
      ok: true,
      workflow: dalMotore.workflow,
      avvisi: dalMotore.note,
      tabelle: dalMotore.tabelleDaCreare,
    };
  }
  const motivoMotore = dalMotore.motivo;
  if (!dalMotore.ripiegabile) {
    return { ok: false, motivo: motivoMotore, problemi: [] };
  }
  ctx.annota('motore', { goal: ctx.goal }, { ripiego: motivoMotore });

  // ── Seconda strada: scrivere il workflow in una volta sola, qui. ──
  ctx.annota('singleshot_generate', { goal: ctx.goal }, { stato: 'in corso' });
  const llm = await createScaffoldLlm(ctx.onToken);
  const singolo = await runScaffold({
    goal: ctx.goal,
    catalog: ctx.catalogo,
    llm,
    signal: ctx.signal,
  });
  if (ctx.interrotto()) return null;

  if (singolo.ok) {
    ctx.annota(
      'singleshot_generate',
      { goal: ctx.goal },
      { nodi: singolo.workflow.nodes.length, tentativi: singolo.attempts },
    );
    return { ok: true, workflow: singolo.workflow, avvisi: singolo.warnings };
  }
  ctx.annota('singleshot_generate', { goal: ctx.goal }, { fallito: singolo.reason });

  // ── Terza strada: costruire a passi, con gli strumenti. ──
  const chat = await createAgentChat(ctx.onToken);
  const agente = await runWorkflowAgent({
    goal: ctx.goal,
    catalog: ctx.catalogo,
    chat,
    signal: ctx.signal,
    onStep: ctx.onStep,
  });
  if (ctx.interrotto()) return null;

  if (agente.ok) {
    return { ok: true, workflow: agente.workflow, avvisi: agente.remainingIssues };
  }

  // Si mostrano TUTTI e tre i motivi, nell'ordine in cui sono stati tentati.
  //
  // Mostrando solo l'ultimo, chi guardava leggeva «il modello non sa chiamare
  // gli strumenti, cambia modello» — un consiglio che manda a cambiare la cosa
  // giusta solo per caso, perché il guasto stava quasi sempre prima, e le
  // strade precedenti scrivevano il proprio motivo in un passo della
  // cronologia che nessuno apre. Tre fallimenti sono tre informazioni:
  // nasconderne due per brevità è quanto è costato scoprire perché il wizard
  // non partiva.
  return {
    ok: false,
    motivo: [
      `Motore: ${motivoMotore}`,
      `Scrittura in una volta sola: ${singolo.reason}`,
      `Costruzione a passi: ${agente.reason}`,
    ].join('\n\n'),
    // I problemi della strada arrivata PIÙ LONTANO, non dell'ultima tentata.
    //
    // Il 2026-08-06 la scrittura in una volta sola si era fermata a UN
    // problema, e a schermo comparivano invece i tre dell'agente: un trigger
    // solo, scollegato e senza configurazione, che con l'obiettivo non
    // c'entrava niente. Sembrava che il sistema producesse sciocchezze, mentre
    // era a un passo dal risultato — e chi leggeva non aveva modo di saperlo.
    //
    // L'agente, quando il modello non chiama gli strumenti, non costruisce
    // nulla: i suoi «problemi» descrivono un relitto, non un tentativo.
    problemi:
      singolo.qualityIssues.length > 0 ? singolo.qualityIssues : agente.qualityIssues,
  };
}
