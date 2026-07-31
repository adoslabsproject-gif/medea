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

interface Pair {
  k: string;
  v: string;
}

function parsePairs(value: string): Pair[] {
  if (!value.trim()) return [];
  try {
    const obj: unknown = JSON.parse(value);
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return [];
    return Object.entries(obj as Record<string, unknown>).map(([k, v]) => ({
      k,
      v: typeof v === 'string' ? v : JSON.stringify(v),
    }));
  } catch {
    return [];
  }
}

/** Numeri, booleani e oggetti tornano al loro tipo; il resto resta testo. */
function serialize(pairs: Pair[]): string {
  const out: Record<string, unknown> = {};
  for (const { k, v } of pairs) {
    if (!k.trim()) continue;
    const looksStructured =
      v.startsWith('{') ||
      v.startsWith('[') ||
      v === 'true' ||
      v === 'false' ||
      /^-?\d+(\.\d+)?$/.test(v);
    if (looksStructured) {
      try {
        out[k] = JSON.parse(v);
        continue;
      } catch {
        // Non era JSON valido: resta una stringa.
      }
    }
    out[k] = v;
  }
  return JSON.stringify(out, null, 2);
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

export function KeyValueBuilder({ value, onChange, keyPlaceholder, valuePlaceholder }: Props) {
  const [pairs, setPairs] = useState<Pair[]>(() => parsePairs(value));

  const commit = (next: Pair[]) => {
    setPairs(next);
    onChange(serialize(next));
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
