/**
 * Il primo passo: dire cosa deve fare.
 *
 * Una casella vuota è la peggior domanda possibile — chi non sa cosa il
 * sistema sa fare non sa nemmeno cosa chiedergli. Gli esempi stanno lì per
 * questo, e riempiono la casella invece di partire da soli: quello che si
 * chiede va sempre riletto prima di lanciarlo.
 */

import { useState } from 'react';

import { WIZARD_CATEGORIES } from './examples';
import styles from './GoalStage.module.css';

interface Props {
  goal: string;
  onGoal: (goal: string) => void;
  onStart: () => void;
}

export function GoalStage({ goal, onGoal, onStart }: Props) {
  // Si apre sulla prima categoria invece che su una scelta da fare: chi non
  // sa cosa chiedere ha già qualcosa davanti, e cambiare scheda è un clic.
  const [categoria, setCategoria] = useState(WIZARD_CATEGORIES[0]?.id ?? '');
  const attiva = WIZARD_CATEGORIES.find((c) => c.id === categoria) ?? WIZARD_CATEGORIES[0];

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

        {/* Le categorie prima degli esempi: dicono in un colpo d'occhio fin
            dove arriva quello che si può chiedere — che non è solo la posta. */}
        <div className={styles.categorie} role="tablist" aria-label="Tipi di automazione">
          {WIZARD_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={c.id === attiva?.id}
              className={c.id === attiva?.id ? styles.categoriaAttiva : styles.categoria}
              title={c.hint}
              onClick={() => {
                setCategoria(c.id);
              }}
            >
              <span aria-hidden="true">{c.icon}</span> {c.label}
            </button>
          ))}
        </div>

        {attiva && <p className={styles.categoriaHint}>{attiva.hint}</p>}

        <div className={styles.chips}>
          {(attiva?.examples ?? []).map((example) => (
            <button
              key={example.title}
              type="button"
              className={styles.chip}
              title={example.goal}
              onClick={() => {
                onGoal(example.goal);
              }}
            >
              <span className={styles.chipTitolo}>{example.title}</span>
              {/* Il testo intero, non solo il titolo: si sceglie leggendo
                  cosa si sta per chiedere, non indovinandolo dal nome. */}
              <span className={styles.chipTesto}>{example.goal}</span>
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
