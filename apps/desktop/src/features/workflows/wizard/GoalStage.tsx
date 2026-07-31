/**
 * Il primo passo: dire cosa deve fare.
 *
 * Una casella vuota è la peggior domanda possibile — chi non sa cosa il
 * sistema sa fare non sa nemmeno cosa chiedergli. Gli esempi stanno lì per
 * questo, e riempiono la casella invece di partire da soli: quello che si
 * chiede va sempre riletto prima di lanciarlo.
 */

import { WIZARD_EXAMPLES } from './examples';
import styles from './GoalStage.module.css';

interface Props {
  goal: string;
  onGoal: (goal: string) => void;
  onStart: () => void;
}

export function GoalStage({ goal, onGoal, onStart }: Props) {
  return (
    <div className={styles.root}>
      <label className={styles.label} htmlFor="wizard-goal">
        Cosa deve fare questa automazione?
      </label>
      <textarea
        id="wizard-goal"
        className={styles.input}
        rows={4}
        autoFocus
        placeholder="Per esempio: ogni mattina alle 8 mandami il riepilogo delle email non lette."
        value={goal}
        onChange={(e) => {
          onGoal(e.target.value);
        }}
        onKeyDown={(e) => {
          // Invio manda, a capo con Shift: è la convenzione di ogni casella
          // di messaggio, e qui si scrive una frase, non un documento.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (goal.trim()) onStart();
          }
        }}
      />

      <p className={styles.hint}>
        Scrivilo come lo diresti a una persona. I nodi li sceglie lui, e ti mostra quali mentre lo
        fa.
      </p>

      <div className={styles.examples}>
        <span className={styles.examplesTitle}>Oppure parti da qui</span>
        <div className={styles.chips}>
          {WIZARD_EXAMPLES.map((example) => (
            <button
              key={example.title}
              type="button"
              className={styles.chip}
              title={example.goal}
              onClick={() => {
                onGoal(example.goal);
              }}
            >
              {example.title}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.start} disabled={!goal.trim()} onClick={onStart}>
          Costruisci
        </button>
      </div>
    </div>
  );
}
