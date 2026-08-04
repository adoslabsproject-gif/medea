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
import {
  createAgentChat,
  createScaffoldLlm,
  runScaffold,
  runWorkflowAgent,
  type AgentStep,
} from '../scaffold';
import type { Workflow } from '../types';

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
      const steps: AgentStep[] = [];

      const controller = new AbortController();
      controllore.current = controller;
      setTokens(undefined);

      // Il conto dei token si somma man mano: quello che interessa è quanto
      // è costato tutto, non l'ultima chiamata.
      const contaToken = (usati: { input: number; output: number }) => {
        if (!alive.current) return;
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
        if (!alive.current) return;
        setState((s) => ({ ...s, trace: [...s.trace, toTraceEntry(passo)] }));
      };

      try {
        // ── Prima strada: scrivere il workflow in una volta sola. ──
        //
        // È quella che regge con qualunque modello, perché chiede di
        // *scrivere* invece di *pilotare*: un JSON conforme allo schema, in
        // una risposta. Chiamare strumenti a ogni passo è una richiesta molto
        // più difficile, e i modelli che non sanno soddisfarla finivano per
        // rispondere a parole finché il ciclo si arrendeva.
        //
        // Se questa strada porta a casa un workflow valido, l'agente non
        // serve. Se non ce la fa, si prosegue con lui — e allora i suoi passi
        // partono da zero, non da un mezzo lavoro.
        annota('singleshot_generate', { goal }, { stato: 'in corso' });
        const llm = await createScaffoldLlm(contaToken);
        const singolo = await runScaffold({
          goal,
          catalog: [...allNodes()],
          llm,
          signal: controller.signal,
        });

        if (!alive.current) return;

        if (singolo.ok) {
          annota(
            'singleshot_generate',
            { goal },
            { nodi: singolo.workflow.nodes.length, tentativi: singolo.attempts },
          );
          const disegnato: Workflow = {
            ...singolo.workflow,
            nodes: needsLayout(singolo.workflow.nodes)
              ? autoLayout(singolo.workflow.nodes, singolo.workflow.edges)
              : singolo.workflow.nodes,
          };
          const gate = gateWorkflow(disegnato, undefined, defsDelCatalogo);
          setState((s) => ({
            ...s,
            stage: 'review',
            result: disegnato,
            issues: [...gate.issues],
            warnings: [...singolo.warnings],
            built: builtNodes(steps),
          }));
          return;
        }

        annota('singleshot_generate', { goal }, { fallito: singolo.reason });

        // ── Seconda strada: costruire a passi, con gli strumenti. ──
        const chat = await createAgentChat(contaToken);
        const result = await runWorkflowAgent({
          goal,
          catalog: [...allNodes()],
          chat,
          signal: controller.signal,
          onStep: (step) => {
            steps.push(step);
            if (!alive.current) return;
            setState((s) => ({
              ...s,
              trace: [...s.trace, toTraceEntry(step)],
              built: builtNodes(steps),
            }));
          },
        });

        if (!alive.current) return;

        if (!result.ok) {
          setState((s) => ({
            ...s,
            stage: 'failed',
            reason: result.reason,
            issues: [...result.qualityIssues],
          }));
          return;
        }

        // Un workflow nato da zero non ha coordinate sensate: il disegno lo
        // facciamo noi, altrimenti arriva come una pila di nodi sovrapposti.
        const workflow: Workflow = {
          ...result.workflow,
          nodes: needsLayout(result.workflow.nodes)
            ? autoLayout(result.workflow.nodes, result.workflow.edges)
            : result.workflow.nodes,
        };

        const gate = gateWorkflow(workflow, undefined, defsDelCatalogo);
        setState((s) => ({
          ...s,
          stage: 'review',
          result: workflow,
          issues: [...gate.issues],
          warnings: [...result.remainingIssues],
        }));
      } catch (e) {
        if (!alive.current) return;
        setState((s) => ({
          ...s,
          stage: 'failed',
          reason: e instanceof Error ? e.message : String(e),
        }));
      }
    })();
  }, []);

  const retry = useCallback(() => {
    setState((s) => ({ ...EMPTY, goal: s.goal }));
  }, []);

  const reset = useCallback(() => {
    setState(EMPTY);
  }, []);

  /** Ferma la costruzione. Il ciclo se ne accorge fra un passo e l'altro, e
   *  la chiamata in volo viene fatta cadere dal lato Rust. */
  const stop = useCallback(() => {
    controllore.current?.abort();
    controllore.current = null;
  }, []);

  return { ...state, setGoal, start, stop, retry, reset, tokens };
}
