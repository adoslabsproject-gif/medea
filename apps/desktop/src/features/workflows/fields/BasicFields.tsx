/**
 * I campi semplici: sì/no, scelta da elenco, testo, numero, codice.
 *
 * Sono la maggioranza dei campi di qualunque nodo, e non hanno bisogno di
 * niente di speciale. Stanno insieme perché insieme sono corti: separarli in
 * cinque file renderebbe più difficile vedere che sono la stessa cosa con
 * cinque presentazioni.
 */

import type { NodeConfigField } from '../types';

import styles from './fields.module.css';
import { FieldShell } from './FieldShell';

interface Props {
  field: NodeConfigField;
  value: string;
  onChange: (next: unknown) => void;
}

/** La casella sta accanto all'etichetta: è l'unico campo in cui il controllo
 *  e l'etichetta sono la stessa cosa. */
export function BooleanField({
  field,
  checked,
  onChange,
}: {
  field: NodeConfigField;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className={styles.field}>
      <label className={styles.checkRow}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => {
            onChange(e.target.checked);
          }}
        />
        {field.label ?? field.key}
      </label>
      {field.description && <p className={styles.hint}>{field.description}</p>}
    </div>
  );
}

export function SelectField({ field, value, onChange }: Props) {
  return (
    <FieldShell field={field}>
      <select
        className={styles.control}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      >
        {!field.required && <option value="">— non impostato —</option>}
        {(field.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function CodeField({ field, value, onChange }: Props) {
  return (
    <FieldShell field={field}>
      <textarea
        className={`${styles.control} ${styles.area} ${styles.mono}`}
        rows={10}
        spellCheck={false}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </FieldShell>
  );
}

export function TextField({ field, value, onChange }: Props) {
  return (
    <FieldShell field={field}>
      <input
        type={field.type === 'number' ? 'number' : 'text'}
        className={styles.control}
        value={value}
        placeholder={field.placeholder ?? field.defaultValue ?? ''}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </FieldShell>
  );
}
