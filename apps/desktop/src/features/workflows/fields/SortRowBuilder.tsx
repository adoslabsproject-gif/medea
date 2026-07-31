/**
 * L'ordinamento di una query.
 *
 * Formato salvato: `[{ column, direction }]`. **L'ordine delle righe è la
 * precedenza**: la prima è il criterio principale, le altre decidono a parità.
 * Per questo si possono spostare su e giù — riscriverle a mano per cambiare
 * priorità sarebbe assurdo.
 */

import { useState } from 'react';

import styles from './fields.module.css';
import { moveRow, parseSort, serializeSort, type SortCriterion } from './serialization';

interface Props {
  value: string;
  onChange: (next: string) => void;
}

export function SortRowBuilder({ value, onChange }: Props) {
  const [rows, setRows] = useState<SortCriterion[]>(() => parseSort(value));

  const commit = (next: SortCriterion[]) => {
    setRows(next);
    onChange(serializeSort(next));
  };

  return (
    <div className={styles.builder}>
      {rows.map((row, i) => (
        <div key={i} className={styles.row}>
          <span className={styles.rank} aria-hidden="true">
            {i + 1}
          </span>
          <input
            className={styles.control}
            placeholder="colonna"
            aria-label={`Colonna del criterio ${String(i + 1)}`}
            value={row.column}
            onChange={(e) => {
              commit(rows.map((r, j) => (j === i ? { ...r, column: e.target.value } : r)));
            }}
          />
          <select
            className={styles.controlNarrow}
            aria-label="Verso"
            value={row.direction}
            onChange={(e) => {
              const direction = e.target.value === 'desc' ? 'desc' : 'asc';
              commit(rows.map((r, j) => (j === i ? { ...r, direction } : r)));
            }}
          >
            <option value="asc">crescente</option>
            <option value="desc">decrescente</option>
          </select>
          <button
            type="button"
            className={styles.rowRemove}
            aria-label="Sposta più in alto"
            disabled={i === 0}
            onClick={() => {
              commit(moveRow(rows, i, -1));
            }}
          >
            ↑
          </button>
          <button
            type="button"
            className={styles.rowRemove}
            aria-label="Sposta più in basso"
            disabled={i === rows.length - 1}
            onClick={() => {
              commit(moveRow(rows, i, 1));
            }}
          >
            ↓
          </button>
          <button
            type="button"
            className={styles.rowRemove}
            aria-label="Rimuovi questo criterio"
            onClick={() => {
              commit(rows.filter((_, j) => j !== i));
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
          commit([...rows, { column: '', direction: 'asc' }]);
        }}
      >
        + Aggiungi criterio
      </button>
    </div>
  );
}
