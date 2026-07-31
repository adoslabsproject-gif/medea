/**
 * Elenco di valori brevi, uno per riga nel valore salvato.
 *
 * Serve per destinatari, tag, domini ammessi. Digitare e premere Invio
 * aggiunge; Backspace su campo vuoto toglie l'ultimo — le scorciatoie che
 * chiunque si aspetta da un campo a etichette.
 */

import { useState, type KeyboardEvent } from 'react';

import styles from './fields.module.css';

function parseItems(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  inputPlaceholder?: string;
}

export function ChipListBuilder({ value, onChange, inputPlaceholder }: Props) {
  const [draft, setDraft] = useState('');
  const items = parseItems(value);

  const commit = (next: string[]) => {
    onChange(next.join('\n'));
  };

  const add = () => {
    const v = draft.trim();
    if (!v || items.includes(v)) {
      setDraft('');
      return;
    }
    commit([...items, v]);
    setDraft('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
      return;
    }
    if (e.key === 'Backspace' && draft === '' && items.length > 0) {
      commit(items.slice(0, -1));
    }
  };

  return (
    <div className={styles.builder}>
      {items.length > 0 && (
        <div className={styles.chips}>
          {items.map((item) => (
            <span key={item} className={styles.chip}>
              {item}
              <button
                type="button"
                className={styles.chipRemove}
                aria-label={`Rimuovi ${item}`}
                onClick={() => {
                  commit(items.filter((x) => x !== item));
                }}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        className={styles.control}
        placeholder={inputPlaceholder ?? 'Scrivi e premi Invio'}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        onKeyDown={onKeyDown}
        onBlur={add}
      />
    </div>
  );
}
