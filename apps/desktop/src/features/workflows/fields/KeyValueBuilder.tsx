/**
 * Editor per un oggetto piatto chiave → valore.
 *
 * Lo usano le intestazioni HTTP, le clausole `whereJson`, i valori da
 * scrivere in `rowJson`. Il valore resta una stringa JSON, esattamente come
 * sul server: cambiare il formato vorrebbe dire che un workflow salvato qui
 * non si apre là.
 *
 * I valori possono contenere espressioni `{{…}}`: qui sono stringhe opache,
 * le risolve il motore a runtime.
 */

import { useState } from 'react';

import styles from './fields.module.css';
import { parseKeyValue, serializeKeyValue, type KeyValuePair } from './serialization';

interface Props {
  value: string;
  onChange: (next: string) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

export function KeyValueBuilder({ value, onChange, keyPlaceholder, valuePlaceholder }: Props) {
  const [pairs, setPairs] = useState<KeyValuePair[]>(() => parseKeyValue(value));

  const commit = (next: KeyValuePair[]) => {
    setPairs(next);
    onChange(serializeKeyValue(next));
  };

  return (
    <div className={styles.builder}>
      {pairs.map((pair, i) => (
        // un id: la chiave può essere vuota o duplicata mentre si scrive.
        <div key={i} className={styles.row}>
          <input
            className={styles.control}
            placeholder={keyPlaceholder ?? 'chiave'}
            value={pair.k}
            onChange={(e) => {
              commit(pairs.map((p, j) => (j === i ? { ...p, k: e.target.value } : p)));
            }}
          />
          <input
            className={styles.control}
            placeholder={valuePlaceholder ?? 'valore'}
            value={pair.v}
            onChange={(e) => {
              commit(pairs.map((p, j) => (j === i ? { ...p, v: e.target.value } : p)));
            }}
          />
          <button
            type="button"
            className={styles.rowRemove}
            aria-label="Rimuovi questa riga"
            onClick={() => {
              commit(pairs.filter((_, j) => j !== i));
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
          commit([...pairs, { k: '', v: '' }]);
        }}
      >
        + Aggiungi
      </button>
    </div>
  );
}
