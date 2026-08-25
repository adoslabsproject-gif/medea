/**
 * Il wizard che costruisce: stato e regia.
 *
 * L'agente lavora a passi e ci mette un minuto abbondante. Qui quei passi
 * diventano una cronologia leggibile mentre accade, e il risultato passa dal
 * controllo di qualità prima di essere offerto — mostrare un workflow e
 * scoprire *dopo* che non si poteva attivare sarebbe peggio che non mostrarlo.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { autoLayout, needsLayout } from '../canvas/layout';
import { allNodes } from '../catalog';
import { gateWorkflow } from '../quality';
import { databasesPerQualita } from '../runtime/tables';
import type { AgentStep } from '../scaffold';
import type { Workflow } from '../types';

import { avviaScadenza, messaggioScaduto } from './scadenza';
import { costruisciWorkflow, type EsitoStradeOk } from './strade';
import { archiviConLePianificate, pianoArricchito } from './tabelle';
import { builtNodes, toTraceEntry } from './tool-labels';
import type { WizardState } from './types';

/** Ogni quanto si aggiorna il tempo trascorso. Un secondo basta: è un'attesa
 *  lunga, e un contatore che corre sarebbe solo agitazione. */
const TICK_MS = 1000;

const EMPTY: WizardState = {
  stage: 'goal',
  goal: '',
  elapsedMs: 0,
  trace: [],
  built: [],
  warnings: [],
  issues: [],
  tables: [],
};

export interface Wizard extends WizardState {
  setGoal: (goal: string) => void;
  start: () => void;
  /** Ferma la costruzione: sul serio, non solo smettendo di guardare. */
  stop: () => void;
  /** I token consumati finora, se il provider li dichiara. */
  tokens?: { input: number; output: number } | undefined;
  /** Torna al punto di partenza tenendo l'obiettivo: si riprova a ritoccarlo. */
  retry: () => void;
  reset: () => void;
}

export function useWizard(): Wizard {
  const [state, setState] = useState<WizardState>(EMPTY);
  /** Vero finché il wizard è a schermo: chiuderlo non deve far scrivere
   *  stato su un componente che non c'è più. */
  const alive = useRef(true);
  /** Con cosa si ferma la costruzione in corso. */
  const controllore = useRef<AbortController | null>(null);
  /** Vero da quando si è premuto «Interrompi»: quello che arriva dopo è di un
   *  lavoro che non interessa più. */
  const fermato = useRef(false);
  const [tokens, setTokens] = useState<{ input: number; output: number } | undefined>(undefined);
  useEffect(() => {
    // Il valore va **rimesso a vero all'ingresso**, non solo azzerato
    // all'uscita. In sviluppo React monta, smonta e rimonta ogni componente
    // per stanare proprio questo genere di errori: con il solo cleanup, il
    // primo smontaggio lasciava `alive` a falso per sempre, e da lì ogni
    // aggiornamento di stato veniva scartato in silenzio.
    //
    // Il risultato era un wizard che restava su «sta pensando» all'infinito,
    // senza passi, senza errori e senza reagire a «Interrompi» — mentre
    // sotto il lavoro procedeva o si fermava regolarmente. Nessuno lo vedeva.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Il tempo scorre solo mentre costruisce.
  useEffect(() => {
    if (state.stage !== 'building') return;
    const started = Date.now() - state.elapsedMs;
    const timer = setInterval(() => {
      setState((s) => (s.stage === 'building' ? { ...s, elapsedMs: Date.now() - started } : s));
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
    // `elapsedMs` di proposito fuori: rientrerebbe a ogni battito.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.stage]);

  /** L'ultimo stato, leggibile dentro le funzioni asincrone senza rilegarle. */
  const stateRef = useRef(state);
  stateRef.current = state;

  const setGoal = useCallback((goal: string) => {
    setState((s) => ({ ...s, goal }));
  }, []);

  const start = useCallback(() => {
    setState((s) => {
      if (!s.goal.trim()) return s;
      // Il motivo del fallimento precedente sparisce: si riparte pulito, e
      // «assente» non è la stessa cosa di «vuoto».
      const { reason: _ignored, ...rest } = s;
      return { ...rest, stage: 'building', elapsedMs: 0, trace: [], built: [] };
    });

    void (async () => {
      const goal = stateRef.current.goal.trim();
      if (!goal) return;

      // Le definizioni servono al controllo dei campi obbligatori: senza, un
      // trigger a cui manca la casella passerebbe per buono.
      const defsDelCatalogo = new Map(allNodes().map((d) => [d.defId, d]));
      // Gli schemi dei database, senza i quali le regole che controllano
      // tabelle e colonne non hanno niente da confrontare e tacciono sempre.
      const databases = await databasesPerQualita();
      const steps: AgentStep[] = [];

      const controller = new AbortController();
      controllore.current = controller;
      fermato.current = false;
      setTokens(undefined);

      // Ricordato perché l'eccezione che arriva dopo un annullamento dice «The
      // operation was aborted», che è vero e non spiega niente a chi ha solo
      // aspettato troppo: serve sapere se ad annullare è stato il tempo.
      const scaduto = { current: false };
      const chiudiScadenza = avviaScadenza(controller, () => {
        scaduto.current = true;
        if (!alive.current || fermato.current) return;
        setState((s) =>
          s.stage === 'building'
            ? { ...s, stage: 'failed', reason: messaggioScaduto(), built: builtNodes(steps) }
            : s,
        );
      });

      // Il conto dei token si somma man mano: quello che interessa è quanto
      // è costato tutto, non l'ultima chiamata.
      const contaToken = (usati: { input: number; output: number }) => {
        if (!alive.current || fermato.current) return;
        setTokens((prima) => ({
          input: (prima?.input ?? 0) + usati.input,
          output: (prima?.output ?? 0) + usati.output,
        }));
      };

      /** Un passo finto per la cronologia: le fasi che non passano dagli
       *  strumenti devono comunque vedersi. */
      const annota = (tool: string, args: Record<string, unknown>, result: unknown) => {
        const passo: AgentStep = { step: steps.length + 1, tool, args, result };
        steps.push(passo);
        if (!alive.current || fermato.current) return;
        setState((s) => ({ ...s, trace: [...s.trace, toTraceEntry(passo)] }));
      };

      /** Consegna un workflow riuscito, da qualunque strada arrivi. */
      const consegna = (
        workflow: Workflow,
        avvisi: readonly string[],
        tabelleDelMotore?: EsitoStradeOk['tabelle'],
      ) => {
        const disegnato: Workflow = {
          ...workflow,
          nodes: needsLayout(workflow.nodes)
            ? autoLayout(workflow.nodes, workflow.edges)
            : workflow.nodes,
        };
        // Il piano PRIMA del gate: le tabelle che stiamo per creare devono
        // contare come esistenti, o si blocca l'attivazione per una tabella
        // che il wizard stesso sta per fare nascere.
        const piano = pianoArricchito(disegnato, tabelleDelMotore, databases);
        const gate = gateWorkflow(
          disegnato,
          archiviConLePianificate(databases, piano),
          defsDelCatalogo,
        );
        setState((s) => ({
          ...s,
          stage: 'review',
          result: disegnato,
          issues: [...gate.issues],
          warnings: [...avvisi],
          // Le tabelle che il workflow dà per esistenti: si dicono PRIMA di
          // premere, e si creano dopo. Il campo esisteva già nello stato ed
          // era sempre vuoto — nessuno lo riempiva, e chi importava non
          // sapeva che stava adottando un workflow senza il suo archivio.
          tables: piano,
          built: builtNodes(steps),
        }));
      };

      try {
        const esito = await costruisciWorkflow({
          goal,
          catalogo: [...allNodes()],
          signal: controller.signal,
          annota,
          onToken: contaToken,
          interrotto: () => !alive.current || fermato.current,
          onStep: (passo) => {
            steps.push(passo);
            if (!alive.current || fermato.current) return;
            setState((s) => ({
              ...s,
              trace: [...s.trace, toTraceEntry(passo)],
              built: builtNodes(steps),
            }));
          },
        });

        // Fermato a metà: non è né riuscito né fallito, e mostrare un errore a
        // chi ha premuto «Interrompi» sarebbe rimproverarlo per averlo fatto.
        if (esito === null || !alive.current || fermato.current) return;

        if (!esito.ok) {
          setState((s) => ({
            ...s,
            stage: 'failed',
            reason: esito.motivo,
            issues: [...esito.problemi],
          }));
          return;
        }

        consegna(esito.workflow, esito.avvisi, esito.tabelle);
      } catch (e) {
        if (!alive.current || fermato.current) return;
        // Il tempo scaduto non è un errore del modello, e dirlo con le parole
        // dell'eccezione («The operation was aborted») non spiegherebbe
        // niente a chi ha soltanto aspettato troppo.
        setState((s) => ({
          ...s,
          stage: 'failed',
          reason: scaduto.current ? messaggioScaduto() : e instanceof Error ? e.message : String(e),
          built: builtNodes(steps),
        }));
      } finally {
        chiudiScadenza();
      }
    })();
  }, []);

  const retry = useCallback(() => {
    setState((s) => ({ ...EMPTY, goal: s.goal }));
  }, []);

  const reset = useCallback(() => {
    setState(EMPTY);
  }, []);

  /**
   * Ferma la costruzione, e lo fa vedere subito.
   *
   * Annullare non basta: il ciclo se ne accorge **fra un passo e l'altro**, e
   * se in quel momento è fermo dentro una chiamata che non torna — il
   * portachiavi che aspetta una password, un provider che non risponde —
   * quell'accorgersi non arriva mai. Da fuori il pulsante sembra rotto.
   *
   * Quindi lo schermo si aggiorna qui, senza chiedere permesso al ciclo. Se
   * poi la chiamata in volo finisce per conto suo, trova `alive` a posto ma
   * uno stato che non è più «in costruzione»: i suoi risultati vengono
   * ignorati, ed è giusto — sono di un lavoro che l'utente ha fermato.
   */
  const stop = useCallback(() => {
    controllore.current?.abort();
    controllore.current = null;
    fermato.current = true;
    setState((s) =>
      s.stage === 'building'
        ? { ...s, stage: 'failed', reason: 'Interrotto: quello che era già stato costruito resta.' }
        : s,
    );
  }, []);

  return { ...state, setGoal, start, stop, retry, reset, tokens };
}
