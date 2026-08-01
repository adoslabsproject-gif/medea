/**
 * «Spiegamelo.»
 *
 * I messaggi che arrivano da un esecutore sono scritti per chi ha scritto
 * l'esecutore: «ECONNREFUSED 127.0.0.1:5432», «Unexpected token < in JSON at
 * position 0». Dicono la verità e non dicono cosa fare.
 *
 * Non si chiede da soli: parlare con un modello costa, e chi legge un errore
 * che ha già capito non vuole aspettare due secondi per una spiegazione che
 * non gli serve. Si preme.
 */

import { useState } from 'react';

import { explainError } from './explain';
import styles from './ExplainError.module.css';
import type { RunStep } from './types';

export function ExplainError({ step }: { step: RunStep }) {
  const [testo, setTesto] = useState<string | null>(null);
  const [inCorso, setInCorso] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);

  if (!step.error) return null;

  const chiedi = () => {
    setInCorso(true);
    setErrore(null);
    void explainError({
      nodeId: step.nodeId,
      ...(step.defId ? { defId: step.defId } : {}),
      error: step.error ?? '',
      ...(step.input ? { input: step.input } : {}),
    })
      .then(setTesto)
      .catch((e: unknown) => {
        setErrore(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        setInCorso(false);
      });
  };

  return (
    <div className={styles.root}>
      {testo === null ? (
        <button type="button" className={styles.ask} disabled={inCorso} onClick={chiedi}>
          {inCorso ? 'Ci penso…' : '✨ Spiegami questo errore'}
        </button>
      ) : (
        <p className={styles.answer}>{testo}</p>
      )}
      {errore && <p className={styles.error}>Non sono riuscito a chiedere: {errore}</p>}
    </div>
  );
}
