/**
 * Il campo giusto per ogni tipo dichiarato dal nodo.
 *
 * È lo stesso smistamento dell'editor di FlowForge: il nodo dichiara che
 * `cronExpression` è un `cron-builder` e qui compare il costruttore di
 * pianificazioni, non una casella dove scrivere `0 9 * * *` a mano. Con 145
 * nodi non esiste alternativa — mantenere 145 moduli scritti a mano sarebbe
 * impossibile.
 *
 * Questo file fa solo lo smistamento: i controlli stanno nei file accanto.
 */

import type { NodeConfigField } from '../types';

import { AccountPicker } from './AccountPicker';
import { AttachmentsBuilder } from './AttachmentsBuilder';
import { BooleanField, CodeField, SelectField, TextField } from './BasicFields';
import { ChipListBuilder } from './ChipListBuilder';
import { ConditionRulesBuilder } from './ConditionRulesBuilder';
import { CronBuilder } from './CronBuilder';
import { ExpressionPicker, type ExpressionSource } from './ExpressionPicker';
import { asText, CODE_TYPES, LONG_TEXT_TYPES, PICKER_TYPES } from './field-kinds';
import { FieldShell } from './FieldShell';
import { FilterRowBuilder } from './FilterRowBuilder';
import { FormFieldsBuilder } from './FormFieldsBuilder';
import { InvoiceLineBuilder } from './InvoiceLineBuilder';
import { KeyValueBuilder } from './KeyValueBuilder';
import { PickerField, SecretField } from './PickerField';
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

type StringControl = (props: {
  value: string;
  onChange: (v: string) => void;
}) => React.ReactElement;

/** I costruttori che prendono e restituiscono una stringa, per tipo. */
const BUILDERS: Record<string, StringControl> = {
  'cron-builder': CronBuilder,
  'timezone-picker': TimezonePicker,
  'key-value': KeyValueBuilder,
  'chip-list': ChipListBuilder,
  'switch-cases': SwitchCasesBuilder,
  'condition-rules': ConditionRulesBuilder,
  'filter-rows': FilterRowBuilder,
  'sort-rows': SortRowBuilder,
  'form-fields': FormFieldsBuilder,
  attachments: AttachmentsBuilder,
  'invoice-lines': InvoiceLineBuilder,
};

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

  if (type === 'boolean') {
    return (
      <BooleanField
        field={field}
        checked={value === true || value === 'true'}
        onChange={onChange}
      />
    );
  }

  const Builder = BUILDERS[type];
  if (Builder) {
    return (
      <FieldShell field={field}>
        <Builder value={text} onChange={onChange} />
      </FieldShell>
    );
  }

  // Un elenco di valori ammessi vince sul tipo: se il nodo li dichiara, si
  // sceglie fra quelli invece di scriverli.
  if (field.options && field.options.length > 0) {
    return <SelectField field={field} value={text} onChange={onChange} />;
  }

  if (type === 'secret') {
    return <SecretField field={field} value={text} onChange={onChange} />;
  }

  // Gli account di posta li conosce Medea: si scelgono, non si scrivono.
  if (type === 'email-account-picker' || type === 'account-picker') {
    return <AccountPicker field={field} value={text} onChange={onChange} />;
  }

  if (PICKER_TYPES.has(type)) {
    return <PickerField field={field} value={text} onChange={onChange} />;
  }

  if (CODE_TYPES.has(type)) {
    return <CodeField field={field} value={text} onChange={onChange} />;
  }

  if (LONG_TEXT_TYPES.has(type)) {
    return (
      <FieldShell field={field}>
        <ExpressionPicker
          value={text}
          onChange={onChange}
          rows={type === 'expression' ? 3 : 6}
          {...((field.placeholder ?? field.defaultValue)
            ? { placeholder: field.placeholder ?? field.defaultValue ?? '' }
            : {})}
          sources={sources}
        />
      </FieldShell>
    );
  }

  return <TextField field={field} value={text} onChange={onChange} />;
}
