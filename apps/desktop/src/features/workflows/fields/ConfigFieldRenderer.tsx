/**
 * Il campo giusto per ogni tipo dichiarato dal nodo.
 *
 * È lo stesso smistamento dell'editor di FlowForge: il nodo dichiara che
 * `cronExpression` è un `cron-builder` e qui compare il costruttore di
 * pianificazioni, non una casella di testo dove scrivere `0 9 * * *` a mano.
 * Con 145 nodi non esiste alternativa — mantenere 145 moduli scritti a mano
 * sarebbe impossibile.
 *
 * Un campo che va in errore non deve portarsi dietro tutto il pannello:
 * ognuno è isolato, e se si rompe si degrada a casella di testo invece di
 * lasciare l'utente davanti a una schermata vuota.
 */

import { PICKER_PLACEHOLDER } from '../constants';
import type { NodeConfigField } from '../types';

import { ChipListBuilder } from './ChipListBuilder';
import { ConditionRulesBuilder } from './ConditionRulesBuilder';
import { CronBuilder } from './CronBuilder';
import { ExpressionPicker, type ExpressionSource } from './ExpressionPicker';
import styles from './fields.module.css';
import { FieldShell } from './FieldShell';
import { FilterRowBuilder } from './FilterRowBuilder';
import { FormFieldsBuilder } from './FormFieldsBuilder';
import { KeyValueBuilder } from './KeyValueBuilder';
import { evaluateShowIf } from './show-if';
import { SortRowBuilder } from './SortRowBuilder';
import { SwitchCasesBuilder } from './SwitchCasesBuilder';
import { TimezonePicker } from './TimezonePicker';

export interface ConfigFieldProps {
  field: NodeConfigField;
  value: unknown;
  onChange: (next: unknown) => void;
  /** Tutti i valori del nodo: servono ai campi che dipendono da un altro. */
  allValues: Record<string, unknown>;
  /** Cosa si può referenziare: i nodi a monte, i segreti, la data. */
  sources?: readonly ExpressionSource[];
}

/** I tipi che si scrivono su più righe con carattere a larghezza fissa. */
const CODE_TYPES = new Set(['code', 'json', 'javascript', 'python', 'sql', 'html']);
const LONG_TEXT_TYPES = new Set(['textarea', 'expression', 'markdown', 'prompt', 'rich-text']);

/** I campi il cui valore l'utente sceglie da un elenco che qui non c'è ancora. */
const PICKER_TYPES = new Set([
  'db-picker',
  'db-table-picker',
  'db-collection-picker',
  'workflow-picker',
  'credential-picker',
  'file-picker',
  'directory-picker',
  'account-picker',
  'email-account-picker',
]);

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value);
}

export function ConfigFieldRenderer({
  field,
  value,
  onChange,
  allValues,
  sources = [],
}: ConfigFieldProps) {
  if (!evaluateShowIf(field.showIf, allValues)) return null;

  const type = field.type || 'text';
  const text = asText(value);

  // Il booleano ha la casella accanto all'etichetta, non sotto: è l'unico
  // campo in cui il controllo E l'etichetta sono la stessa cosa.
  if (type === 'boolean') {
    return (
      <div className={styles.field}>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={value === true || value === 'true'}
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

  if (type === 'cron-builder') {
    return (
      <FieldShell field={field}>
        <CronBuilder value={text} onChange={onChange} />
      </FieldShell>
    );
  }

  if (type === 'timezone-picker') {
    return (
      <FieldShell field={field}>
        <TimezonePicker value={text} onChange={onChange} />
      </FieldShell>
    );
  }

  if (type === 'key-value') {
    return (
      <FieldShell field={field}>
        <KeyValueBuilder
          value={text}
          onChange={onChange}
          {...(field.description ? { keyPlaceholder: 'chiave' } : {})}
        />
      </FieldShell>
    );
  }

  if (type === 'chip-list') {
    return (
      <FieldShell field={field}>
        <ChipListBuilder value={text} onChange={onChange} />
      </FieldShell>
    );
  }

  if (type === 'switch-cases') {
    return (
      <FieldShell field={field}>
        <SwitchCasesBuilder value={text} onChange={onChange} />
      </FieldShell>
    );
  }

  if (type === 'filter-rows') {
    return (
      <FieldShell field={field}>
        <FilterRowBuilder value={text} onChange={onChange} />
      </FieldShell>
    );
  }

  if (type === 'sort-rows') {
    return (
      <FieldShell field={field}>
        <SortRowBuilder value={text} onChange={onChange} />
      </FieldShell>
    );
  }

  if (type === 'form-fields') {
    return (
      <FieldShell field={field}>
        <FormFieldsBuilder value={text} onChange={onChange} />
      </FieldShell>
    );
  }

  if (type === 'condition-rules') {
    return (
      <FieldShell field={field}>
        <ConditionRulesBuilder value={text} onChange={onChange} />
      </FieldShell>
    );
  }

  if (field.options && field.options.length > 0) {
    return (
      <FieldShell field={field}>
        <select
          className={styles.control}
          value={text}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        >
          {!field.required && <option value="">— non impostato —</option>}
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </FieldShell>
    );
  }

  if (type === 'secret') {
    return (
      <FieldShell field={field}>
        <input
          type="password"
          className={styles.control}
          value={text}
          placeholder="{{secrets.NOME}}"
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
        <p className={styles.hint}>
          Meglio un riferimento <code>{'{{secrets.NOME}}'}</code> che il valore in chiaro: il
          workflow viene salvato ed esportato così com’è.
        </p>
      </FieldShell>
    );
  }

  if (PICKER_TYPES.has(type)) {
    return (
      <FieldShell field={field}>
        <div className={styles.row}>
          <input
            className={styles.control}
            value={text}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
          <button
            type="button"
            className={styles.inlineBtn}
            onClick={() => {
              onChange(PICKER_PLACEHOLDER);
            }}
          >
            Scelgo dopo
          </button>
        </div>
        <p className={styles.hint}>
          Va scelto da un elenco di risorse. Finché l’elenco non c’è, lascia{' '}
          <code>{PICKER_PLACEHOLDER}</code>: il controllo di qualità sa che non è un valore
          inventato e non lo segnala come errore.
        </p>
      </FieldShell>
    );
  }

  if (CODE_TYPES.has(type)) {
    return (
      <FieldShell field={field}>
        <textarea
          className={`${styles.control} ${styles.area} ${styles.mono}`}
          rows={10}
          spellCheck={false}
          value={text}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
      </FieldShell>
    );
  }

  if (LONG_TEXT_TYPES.has(type)) {
    return (
      <FieldShell field={field}>
        <ExpressionPicker
          value={text}
          onChange={onChange}
          rows={type === 'expression' ? 3 : 6}
          {...(field.defaultValue ? { placeholder: field.defaultValue } : {})}
          sources={sources}
        />
      </FieldShell>
    );
  }

  return (
    <FieldShell field={field}>
      <input
        type={type === 'number' ? 'number' : 'text'}
        className={styles.control}
        value={text}
        placeholder={field.defaultValue ?? ''}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </FieldShell>
  );
}
