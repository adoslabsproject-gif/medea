/**
 * I campi che si scelgono da un elenco di risorse reali, e i segreti.
 *
 * L'elenco vero — i database del tenant, gli account email configurati —
 * arriverà quando ci sarà il runtime. Fino ad allora il campo resta
 * scrivibile e offre il segnaposto: è un impegno esplicito a chiedere il
 * valore all'utente prima di attivare, e il controllo di qualità lo
 * riconosce invece di segnalarlo come valore inventato.
 */

import { PICKER_PLACEHOLDER } from '../constants';
import type { NodeConfigField } from '../types';

import styles from './fields.module.css';
import { FieldShell } from './FieldShell';

interface Props {
  field: NodeConfigField;
  value: string;
  onChange: (next: string) => void;
}

export function PickerField({ field, value, onChange }: Props) {
  const deferred = value === PICKER_PLACEHOLDER;

  return (
    <FieldShell field={field}>
      <div className={styles.row}>
        <input
          className={styles.control}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
        <button
          type="button"
          className={styles.inlineBtn}
          data-on={deferred ? 'true' : 'false'}
          onClick={() => {
            onChange(deferred ? '' : PICKER_PLACEHOLDER);
          }}
        >
          {deferred ? 'Scrivilo ora' : 'Scelgo dopo'}
        </button>
      </div>
      <p className={styles.hint}>
        Va scelto da un elenco di risorse. Finché l’elenco non c’è, lascia{' '}
        <code>{PICKER_PLACEHOLDER}</code>: il controllo di qualità sa che non è un valore inventato
        e non lo segnala come errore.
      </p>
    </FieldShell>
  );
}

export function SecretField({ field, value, onChange }: Props) {
  return (
    <FieldShell field={field}>
      <input
        type="password"
        className={styles.control}
        value={value}
        placeholder="{{secrets.NOME}}"
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
      <p className={styles.hint}>
        Meglio un riferimento <code>{'{{secrets.NOME}}'}</code> che il valore in chiaro: il workflow
        viene salvato ed esportato così com’è.
      </p>
    </FieldShell>
  );
}
