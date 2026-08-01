/**
 * I campi che si scelgono da un elenco di risorse reali, e i segreti.
 *
 * L'elenco è quello vero: i database che il motore conosce, le loro tabelle,
 * gli account di posta configurati in Medea, i segreti definiti. Scrivere a
 * memoria il nome di una tabella è il modo più facile di sbagliarlo, e
 * l'errore si scopre a esecuzione fallita.
 *
 * Quando l'elenco non si carica — il motore spento, un database irraggiungibile
 * — il campo torna scrivibile a mano invece di bloccare la configurazione.
 * Resta anche il «scelgo dopo», che è un impegno esplicito a riempirlo prima di
 * attivare: il controllo di qualità lo riconosce invece di segnalarlo come
 * valore inventato.
 */

import { PICKER_PLACEHOLDER } from '../constants';
import { useElenco } from '../pickers';
import type { NodeConfigField } from '../types';

import styles from './fields.module.css';
import { FieldShell } from './FieldShell';

interface Props {
  field: NodeConfigField;
  value: string;
  onChange: (next: string) => void;
  /** I valori degli altri campi: la tabella dipende dal database scelto. */
  allValues?: Record<string, unknown>;
}

export function PickerField({ field, value, onChange, allValues }: Props) {
  const deferred = value === PICKER_PLACEHOLDER;
  // Solo se è una stringa: un campo da cui questo dipende che contenga un
  // oggetto non è un identificativo, e `String()` ne farebbe «[object Object]».
  const dipeso = field.dependsOn ? allValues?.[field.dependsOn] : undefined;
  const dipendeDa = typeof dipeso === 'string' ? dipeso : undefined;
  const { scelte, caricando, fallito } = useElenco(field.type, dipendeDa);

  // Si sceglie da un elenco solo se un elenco c'è. Con zero voci — motore
  // spento, database senza tabelle, o un campo che dipende da uno non ancora
  // compilato — la casella scrivibile è l'unica cosa utile.
  const daElenco = !deferred && !caricando && !fallito && scelte.length > 0;

  return (
    <FieldShell field={field}>
      <div className={styles.row}>
        {daElenco ? (
          <select
            className={styles.control}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          >
            <option value="">— scegli —</option>
            {scelte.map((scelta) => (
              <option key={scelta.value} value={scelta.value}>
                {scelta.label}
                {scelta.hint ? ` · ${scelta.hint}` : ''}
              </option>
            ))}
          </select>
        ) : (
          <input
            className={styles.control}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
        )}
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
      {caricando && <p className={styles.hint}>Carico l’elenco…</p>}

      {!caricando && !daElenco && !deferred && (
        <p className={styles.hint}>
          {fallito
            ? 'Non sono riuscito a leggere l’elenco: scrivilo a mano.'
            : field.dependsOn && !dipendeDa
              ? `Scegli prima ${field.dependsOn}, poi qui compare l’elenco.`
              : 'Nessuna voce disponibile: scrivilo a mano.'}{' '}
          Oppure lascia <code>{PICKER_PLACEHOLDER}</code>: il controllo di qualità sa che non è un
          valore inventato e non lo segnala come errore.
        </p>
      )}
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
