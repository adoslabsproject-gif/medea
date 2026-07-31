/**
 * L'account di posta, scelto fra quelli configurati in Medea.
 *
 * Gli account ci sono già, con le credenziali nel portachiavi: chiedere di
 * riscrivere host, porta, utente e password sarebbe chiedere all'utente di
 * ripetere quello che il programma sa.
 *
 * Restare vuoto è una scelta legittima, non un campo dimenticato: i nodi
 * dichiarano `showIf: { systemAccountId: '' }` sui campi manuali, quindi
 * lasciandolo vuoto compaiono host, porta e credenziali e si usa un indirizzo
 * qualunque — anche uno che in Medea non è configurato.
 */

import { useMailAccounts } from '../resources';
import type { NodeConfigField } from '../types';

import styles from './fields.module.css';
import { FieldShell } from './FieldShell';

interface Props {
  field: NodeConfigField;
  value: string;
  onChange: (next: string) => void;
}

export function AccountPicker({ field, value, onChange }: Props) {
  const { accounts, failed } = useMailAccounts();

  // Se gli account non si leggono, meglio una casella di testo di un elenco
  // vuoto: il campo resta compilabile.
  if (failed) {
    return (
      <FieldShell field={field}>
        <input
          className={styles.control}
          value={value}
          placeholder="identificativo dell’account"
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
        <p className={styles.hint}>Non sono riuscito a leggere gli account configurati.</p>
      </FieldShell>
    );
  }

  // Un id salvato che non corrisponde più a nessun account (workflow
  // importato, account rimosso) resta visibile invece di sparire in silenzio.
  const known = accounts.some((a) => a.id === value);

  return (
    <FieldShell field={field}>
      <select
        className={styles.control}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      >
        <option value="">Un altro indirizzo (lo configuro qui sotto)</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.displayName} · {a.emailAddress}
          </option>
        ))}
        {value && !known && <option value={value}>{value} (non configurato qui)</option>}
      </select>
      {value === '' && (
        <p className={styles.hint}>
          Senza un account di Medea compaiono qui sotto host, porta e credenziali: serve per usare
          un indirizzo diverso da quelli configurati.
        </p>
      )}
      {accounts.length === 0 && (
        <p className={styles.hint}>
          Nessun account configurato in Medea: aggiungine uno dalla sezione Posta, oppure compila i
          campi qui sotto.
        </p>
      )}
      {value && !known && (
        <p className={styles.hint}>
          Questo identificativo non corrisponde a nessun account di questo computer — probabilmente
          il workflow viene da un’altra installazione.
        </p>
      )}
    </FieldShell>
  );
}
