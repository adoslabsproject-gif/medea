/**
 * Il campo con i suggerimenti per le espressioni.
 *
 * Scrivere `{{$node.scarica_ordini.json.totale}}` a memoria significa
 * ricordarsi l'id esatto di un nodo che sta dall'altra parte del canvas.
 * Digitando `{{` compare l'elenco di quello che si può usare: i nodi a monte,
 * i segreti, la data di oggi. È la differenza fra un campo che si compila e
 * uno che si indovina.
 */

import { useMemo, useRef, useState, type KeyboardEvent } from 'react';

import styles from './fields.module.css';

export interface ExpressionSource {
  /** Il testo da inserire, senza le graffe. */
  expression: string;
  label: string;
  hint?: string;
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  rows?: number;
  /** Cosa si può referenziare da questo campo. */
  sources: readonly ExpressionSource[];
}

/** Le espressioni sempre disponibili, indipendenti dal workflow. */
export const BUILTIN_SOURCES: readonly ExpressionSource[] = [
  { expression: '$now', label: 'Adesso', hint: 'data e ora del momento in cui gira' },
  { expression: '$today', label: 'Oggi', hint: 'la data di oggi' },
  { expression: 'secrets.NOME', label: 'Un segreto', hint: 'sostituisci NOME con il tuo' },
];

export function ExpressionPicker({ value, onChange, placeholder, rows = 3, sources }: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const all = useMemo(() => [...sources, ...BUILTIN_SOURCES], [sources]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (s) => s.label.toLowerCase().includes(q) || s.expression.toLowerCase().includes(q),
    );
  }, [all, filter]);

  /** Inserisce l'espressione dove sta il cursore, non in fondo al testo. */
  const insert = (expression: string) => {
    const el = ref.current;
    const snippet = `{{${expression}}}`;
    if (!el) {
      onChange(value + snippet);
    } else {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      // Se l'utente ha appena scritto `{{`, quelle graffe le rimpiazziamo:
      // altrimenti resterebbero doppie.
      const openedHere = value.slice(Math.max(0, start - 2), start) === '{{';
      const from = openedHere ? start - 2 : start;
      onChange(value.slice(0, from) + snippet + value.slice(end));
    }
    setOpen(false);
    setFilter('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className={styles.expressionWrap}>
      <textarea
        ref={ref}
        className={`${styles.control} ${styles.area}`}
        rows={rows}
        value={value}
        placeholder={placeholder ?? ''}
        onChange={(e) => {
          const next = e.target.value;
          onChange(next);
          // L'elenco compare da solo appena si aprono le graffe.
          const caret = e.target.selectionStart;
          if (next.slice(Math.max(0, caret - 2), caret) === '{{') setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />

      <button
        type="button"
        className={styles.expressionToggle}
        title="Inserisci un riferimento"
        aria-label="Inserisci un riferimento"
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        {'{{ }}'}
      </button>

      {open && (
        <div className={styles.suggestions} role="listbox">
          <input
            className={styles.control}
            autoFocus
            placeholder="Filtra…"
            aria-label="Filtra i riferimenti"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
            }}
          />
          {shown.length === 0 ? (
            <p className={styles.hint}>Nessun riferimento disponibile.</p>
          ) : (
            <ul className={styles.suggestionList}>
              {shown.map((s) => (
                <li key={s.expression}>
                  <button
                    type="button"
                    className={styles.suggestionItem}
                    onClick={() => {
                      insert(s.expression);
                    }}
                  >
                    <span className={styles.suggestionLabel}>{s.label}</span>
                    <code className={styles.suggestionExpr}>{`{{${s.expression}}}`}</code>
                    {s.hint && <span className={styles.hint}>{s.hint}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
