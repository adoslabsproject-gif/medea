/**
 * Provare questo nodo, da solo.
 *
 * È la differenza fra capire un errore in dieci secondi e capirlo in dieci
 * minuti: si cambia un campo, si preme, si vede cosa esce. L'alternativa è
 * eseguire tutto il workflow e, se il nodo sta in fondo, aspettare ogni volta
 * tutto quello che viene prima.
 *
 * Si prova la **bozza**: quello che si sta guardando, non quello che si era
 * salvato.
 */

import { useState } from 'react';

import { testNode } from '../runtime';
import type { NodeTestResult } from '../runtime';
import type { CanvasNode, WorkflowEdge } from '../types';

import styles from './NodeTestPanel.module.css';

interface Props {
  node: CanvasNode;
  nodes: readonly CanvasNode[];
  edges: readonly WorkflowEdge[];
  /** Falso quando il motore non è in piedi: la prova non è possibile. */
  ready: boolean;
}

/** Un valore come lo si legge, non come lo si trasmette. */
function show(value: unknown): string {
  if (value === undefined) return '—';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    // Un valore circolare non si serializza: si dice cosa è, invece di
    // stampare «[object Object]» che non aiuta nessuno.
    return `(valore non leggibile: ${typeof value})`;
  }
}

export function NodeTestPanel({ node, nodes, edges, ready }: Props) {
  const [input, setInput] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<NodeTestResult | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);

  const run = () => {
    let parsed: unknown = {};
    if (input.trim()) {
      try {
        parsed = JSON.parse(input);
      } catch {
        setInputError('L’ingresso deve essere JSON. Lascia `{}` se il nodo non ne ha bisogno.');
        return;
      }
    }
    setInputError(null);
    setBusy(true);
    void testNode({ nodeId: node.id, nodes, edges, input: parsed })
      .then(setResult)
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div className={styles.root}>
      <label className={styles.label} htmlFor="node-test-input">
        Cosa gli arriva
      </label>
      <textarea
        id="node-test-input"
        className={styles.input}
        rows={3}
        spellCheck={false}
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
        }}
      />
      <p className={styles.hint}>
        Il finto ingresso del nodo. Le espressioni che nominano gli altri nodi si risolvono lo
        stesso: viaggiano tutti, ma ne esegue uno solo.
      </p>
      {inputError && <p className={styles.error}>{inputError}</p>}

      <button
        type="button"
        className={styles.run}
        disabled={busy || !ready}
        title={ready ? 'Esegue solo questo nodo' : 'Il motore non è ancora pronto'}
        onClick={run}
      >
        {busy ? 'Provo…' : 'Prova questo nodo'}
      </button>

      {result && (
        <section className={result.ok ? styles.result : `${styles.result} ${styles.failed}`}>
          <header className={styles.resultHead}>
            <span>{result.ok ? 'Riuscito' : 'Fallito'}</span>
            {result.durationMs !== undefined && (
              <span className={styles.time}>{result.durationMs} ms</span>
            )}
          </header>

          {result.error && <pre className={styles.pre}>{result.error}</pre>}
          {result.output !== undefined && <pre className={styles.pre}>{show(result.output)}</pre>}
          {!result.error && result.output === undefined && (
            <p className={styles.empty}>Non ha prodotto niente.</p>
          )}
        </section>
      )}
    </div>
  );
}
