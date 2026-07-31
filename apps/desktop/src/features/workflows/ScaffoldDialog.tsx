/**
 * «Descrivi cosa deve fare» — la generazione del workflow a parole.
 *
 * Mostra i passi mentre l'agente lavora, invece di una rotellina: chi guarda
 * capisce che sta cercando un nodo, che lo sta configurando, che sta
 * validando. Quando qualcosa non va, il motivo è quello vero del quality
 * gate, non un «errore» generico.
 */

import { useRef, useState } from 'react';

import { autoLayout } from './canvas/layout';
import { allNodes } from './catalog';
import { createAgentChat, runWorkflowAgent, type AgentStep } from './scaffold';
import styles from './ScaffoldDialog.module.css';
import type { Workflow } from './types';

interface Props {
  /** Il workflow su cui sta lavorando: se ha nodi, l'agente lo modifica. */
  current: Workflow;
  onGenerated: (wf: Workflow) => void;
  onClose: () => void;
}

const ESEMPI = [
  'Ogni mattina alle 8 scarica gli ordini dal gestionale e mandami il riepilogo per email',
  'Quando arriva una PEC, salvala nel database e avvisami su Telegram',
  'Ogni lunedì controlla i link rotti del sito e scrivi un report',
];

export function ScaffoldDialog({ current, onGenerated, onClose }: Props) {
  const [goal, setGoal] = useState('');
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abandoned = useRef(false);

  const isModify = current.nodes.length > 0;

  async function generate() {
    const trimmed = goal.trim();
    if (trimmed.length < 8) {
      setError('Descrivi cosa deve fare il workflow, anche solo in una riga.');
      return;
    }
    setBusy(true);
    setError(null);
    setSteps([]);
    abandoned.current = false;

    try {
      const chat = await createAgentChat();
      const result = await runWorkflowAgent({
        goal: trimmed,
        catalog: [...allNodes()],
        chat,
        ...(isModify ? { seed: current } : {}),
        onStep: (step) => {
          if (!abandoned.current) setSteps((prev) => [...prev, step]);
        },
      });

      if (abandoned.current) return;

      if (!result.ok) {
        setError(result.reason);
        return;
      }
      // Il modello pensa alla logica, non alle coordinate: il disegno lo
      // facciamo noi, altrimenti si vedrebbe un mucchio di rettangoli.
      onGenerated({
        ...result.workflow,
        ...(current.id ? { id: current.id } : {}),
        nodes: autoLayout(result.workflow.nodes, result.workflow.edges),
      });
    } catch (e) {
      if (!abandoned.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label="Genera workflow">
      <div className={styles.panel}>
        <header className={styles.head}>
          <h2 className={styles.title}>
            {isModify ? 'Modifica il workflow a parole' : 'Descrivi cosa deve fare'}
          </h2>
          <button
            type="button"
            className={styles.close}
            aria-label="Chiudi"
            onClick={() => {
              abandoned.current = true;
              onClose();
            }}
          >
            ✕
          </button>
        </header>

        <textarea
          className={styles.goal}
          rows={4}
          autoFocus
          disabled={busy}
          placeholder={
            isModify
              ? 'Es. aggiungi un controllo: se la risposta non arriva entro un’ora, avvisami'
              : 'Es. ogni mattina alle 8 scarica gli ordini e mandami il riepilogo'
          }
          value={goal}
          onChange={(e) => {
            setGoal(e.target.value);
          }}
        />

        {!busy && steps.length === 0 && !isModify && (
          <div className={styles.examples}>
            {ESEMPI.map((e) => (
              <button
                key={e}
                type="button"
                className={styles.example}
                onClick={() => {
                  setGoal(e);
                }}
              >
                {e}
              </button>
            ))}
          </div>
        )}

        {steps.length > 0 && (
          <ol className={styles.steps}>
            {steps.slice(-12).map((s) => (
              <li key={s.step} className={styles.step}>
                <code>{s.tool}</code>
                <span className={styles.stepArgs}>{describeArgs(s)}</span>
              </li>
            ))}
          </ol>
        )}

        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}

        <footer className={styles.foot}>
          <span className={styles.counter}>
            {busy
              ? `${String(steps.length)} passi…`
              : `${String(allNodes().length)} nodi disponibili`}
          </span>
          <button
            type="button"
            className={styles.generate}
            disabled={busy}
            onClick={() => void generate()}
          >
            {busy ? 'Sto costruendo…' : isModify ? 'Applica' : 'Genera'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Il riassunto di un passo, in una riga: cosa ha toccato, non tutto il JSON. */
function describeArgs(step: AgentStep): string {
  const a = step.args;
  const first = (keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = a[k];
      if (typeof v === 'string' && v) return v;
    }
    return undefined;
  };
  const from = typeof a.from === 'string' ? a.from : '';
  const to = typeof a.to === 'string' ? a.to : '';
  if (from && to) return `${from} → ${to}`;
  return first(['defId', 'nodeId', 'query', 'id']) ?? '';
}
