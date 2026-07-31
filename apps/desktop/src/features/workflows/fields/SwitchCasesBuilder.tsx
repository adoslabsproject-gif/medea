/**
 * I casi di uno `logic_switch`.
 *
 * Formato salvato — identico a quello che legge il motore:
 *   `valore=nomeRamo` una coppia per riga.
 *
 * Lo switch confronta stringhe esatte: non valuta espressioni. Il quality
 * gate lo verifica, ma è meglio che l'utente non ci provi nemmeno, quindi il
 * campo chiede un valore, non una condizione.
 */

import { useState } from 'react';

import styles from './fields.module.css';
import { parseSwitchCases, serializeSwitchCases, type SwitchCase } from './serialization';

interface Props {
  value: string;
  onChange: (next: string) => void;
}

export function SwitchCasesBuilder({ value, onChange }: Props) {
  const [cases, setCases] = useState<SwitchCase[]>(() => parseSwitchCases(value));

  const commit = (next: SwitchCase[]) => {
    setCases(next);
    onChange(serializeSwitchCases(next));
  };

  return (
    <div className={styles.builder}>
      {cases.map((c, i) => (
        <div key={i} className={styles.row}>
          <input
            className={styles.control}
            placeholder="se il valore è…"
            value={c.value}
            onChange={(e) => {
              commit(cases.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)));
            }}
          />
          <span className={styles.rowArrow} aria-hidden="true">
            →
          </span>
          <input
            className={styles.control}
            placeholder="vai al ramo"
            value={c.branch}
            onChange={(e) => {
              commit(cases.map((x, j) => (j === i ? { ...x, branch: e.target.value } : x)));
            }}
          />
          <button
            type="button"
            className={styles.rowRemove}
            aria-label="Rimuovi questo caso"
            onClick={() => {
              commit(cases.filter((_, j) => j !== i));
            }}
          >
            ✕
          </button>
        </div>
      ))}

      <button
        type="button"
        className={styles.addRow}
        onClick={() => {
          commit([...cases, { value: '', branch: '' }]);
        }}
      >
        + Aggiungi caso
      </button>
    </div>
  );
}
