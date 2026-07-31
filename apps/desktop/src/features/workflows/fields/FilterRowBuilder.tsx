/**
 * I filtri di una query sul database.
 *
 * Formato salvato — quello che legge l'adattatore:
 *   `[{ column, op, value }]`
 *
 * Gli operatori sono quelli del motore, non un sottoinsieme comodo: se qui
 * ne mancasse uno, quella query non si potrebbe scrivere. `isNull` e
 * `notNull` non hanno valore, e il campo sparisce invece di restare lì a
 * chiedere qualcosa che verrebbe ignorato.
 */

import { useState } from 'react';

import styles from './fields.module.css';
import {
  parseFilters,
  serializeFilters,
  UNARY_FILTER_OPS,
  type QueryFilter,
} from './serialization';

const OPS: { value: string; label: string }[] = [
  { value: 'eq', label: 'è uguale a' },
  { value: 'neq', label: 'è diverso da' },
  { value: 'gt', label: 'maggiore di' },
  { value: 'gte', label: 'maggiore o uguale' },
  { value: 'lt', label: 'minore di' },
  { value: 'lte', label: 'minore o uguale' },
  { value: 'like', label: 'contiene' },
  { value: 'in', label: 'è fra' },
  { value: 'isNull', label: 'è vuoto' },
  { value: 'notNull', label: 'non è vuoto' },
];

interface Props {
  value: string;
  onChange: (next: string) => void;
}

export function FilterRowBuilder({ value, onChange }: Props) {
  const [rows, setRows] = useState<QueryFilter[]>(() => parseFilters(value));

  const commit = (next: QueryFilter[]) => {
    setRows(next);
    onChange(serializeFilters(next));
  };

  const patch = (index: number, change: Partial<QueryFilter>) => {
    commit(rows.map((r, i) => (i === index ? { ...r, ...change } : r)));
  };

  return (
    <div className={styles.builder}>
      {rows.map((row, i) => (
        <div key={i} className={styles.row}>
          <input
            className={styles.control}
            placeholder="colonna"
            aria-label="Colonna"
            value={row.column}
            onChange={(e) => {
              patch(i, { column: e.target.value });
            }}
          />
          <select
            className={styles.control}
            aria-label="Operatore"
            value={row.op}
            onChange={(e) => {
              patch(i, { op: e.target.value });
            }}
          >
            {OPS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {!UNARY_FILTER_OPS.has(row.op) && (
            <input
              className={styles.control}
              placeholder={row.op === 'in' ? 'a, b, c' : 'valore'}
              aria-label="Valore"
              value={row.value ?? ''}
              onChange={(e) => {
                patch(i, { value: e.target.value });
              }}
            />
          )}
          <button
            type="button"
            className={styles.rowRemove}
            aria-label="Rimuovi questo filtro"
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
          commit([...rows, { column: '', op: 'eq', value: '' }]);
        }}
      >
        + Aggiungi filtro
      </button>
    </div>
  );
}
