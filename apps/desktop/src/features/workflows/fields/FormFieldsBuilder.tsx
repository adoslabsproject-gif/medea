/**
 * I campi di un modulo (il trigger «form»).
 *
 * Formato salvato: `[{ key, label, type, required, options?, placeholder? }]`.
 *
 * `key` è il nome con cui il valore arriva al workflow — è quello che poi si
 * scrive nelle espressioni — e viene proposto automaticamente dall'etichetta,
 * perché nessuno ha voglia di inventare due nomi per la stessa cosa.
 */

import { useState } from 'react';

import styles from './fields.module.css';
import { toFieldKey } from './serialization';

interface BuilderField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options?: string;
  placeholder?: string;
}

const TYPES = [
  { value: 'text', label: 'testo' },
  { value: 'textarea', label: 'testo lungo' },
  { value: 'email', label: 'email' },
  { value: 'number', label: 'numero' },
  { value: 'date', label: 'data' },
  { value: 'select', label: 'scelta' },
  { value: 'checkbox', label: 'sì / no' },
  { value: 'file', label: 'file' },
];

function parse(raw: string): BuilderField[] {
  if (!raw.trim()) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const f = item as Record<string, unknown>;
      return [
        {
          key: typeof f.key === 'string' ? f.key : '',
          label: typeof f.label === 'string' ? f.label : '',
          type: typeof f.type === 'string' ? f.type : 'text',
          required: f.required === true,
          options: Array.isArray(f.options) ? f.options.join(', ') : '',
          placeholder: typeof f.placeholder === 'string' ? f.placeholder : '',
        },
      ];
    });
  } catch {
    return [];
  }
}

function serialize(fields: BuilderField[]): string {
  return JSON.stringify(
    fields
      .filter((f) => f.key.trim() !== '')
      .map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        required: f.required,
        ...(f.type === 'select' && f.options
          ? {
              options: f.options
                .split(',')
                .map((o) => o.trim())
                .filter(Boolean),
            }
          : {}),
        ...(f.placeholder ? { placeholder: f.placeholder } : {}),
      })),
  );
}

interface Props {
  value: string;
  onChange: (next: string) => void;
}

export function FormFieldsBuilder({ value, onChange }: Props) {
  const [fields, setFields] = useState<BuilderField[]>(() => parse(value));

  const commit = (next: BuilderField[]) => {
    setFields(next);
    onChange(serialize(next));
  };

  const patch = (index: number, change: Partial<BuilderField>) => {
    commit(fields.map((f, i) => (i === index ? { ...f, ...change } : f)));
  };

  return (
    <div className={styles.builder}>
      {fields.map((field, i) => (
        <div key={i} className={styles.ruleRow}>
          <div className={styles.row}>
            <input
              className={styles.control}
              placeholder="Etichetta mostrata"
              aria-label="Etichetta del campo"
              value={field.label}
              onChange={(e) => {
                const label = e.target.value;
                // La chiave segue l'etichetta finché l'utente non la tocca.
                const follows = field.key === '' || field.key === toFieldKey(field.label);
                patch(i, follows ? { label, key: toFieldKey(label) } : { label });
              }}
            />
            <button
              type="button"
              className={styles.rowRemove}
              aria-label="Rimuovi questo campo"
              onClick={() => {
                commit(fields.filter((_, j) => j !== i));
              }}
            >
              ✕
            </button>
          </div>

          <div className={styles.row}>
            <input
              className={`${styles.control} ${styles.mono}`}
              placeholder="nome_tecnico"
              aria-label="Nome con cui arriva al workflow"
              value={field.key}
              onChange={(e) => {
                patch(i, { key: e.target.value });
              }}
            />
            <select
              className={styles.controlNarrow}
              aria-label="Tipo di campo"
              value={field.type}
              onChange={(e) => {
                patch(i, { type: e.target.value });
              }}
            >
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          {field.type === 'select' && (
            <input
              className={styles.control}
              placeholder="prima scelta, seconda scelta, terza"
              aria-label="Scelte disponibili"
              value={field.options ?? ''}
              onChange={(e) => {
                patch(i, { options: e.target.value });
              }}
            />
          )}

          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={field.required}
              onChange={(e) => {
                patch(i, { required: e.target.checked });
              }}
            />
            Obbligatorio
          </label>
        </div>
      ))}

      <button
        type="button"
        className={styles.addRow}
        onClick={() => {
          commit([...fields, { key: '', label: '', type: 'text', required: false }]);
        }}
      >
        + Aggiungi campo
      </button>
    </div>
  );
}
