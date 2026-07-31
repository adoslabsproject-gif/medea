/**
 * I segreti dei workflow.
 *
 * Un workflow scrive `{{secrets.API_KEY}}` e quel riferimento deve trovare
 * qualcosa: qui si definisce cosa. Il valore finisce nel portachiavi del
 * sistema, non nel documento — è quello che permette di esportare un
 * workflow senza portarsi via le credenziali.
 *
 * Un valore inserito non si rilegge mai: la casella mostra che c'è, non cosa
 * è. Rileggere un segreto a schermo non serve a chi lo ha scritto e serve
 * molto a chi guarda alle sue spalle.
 */

import { useEffect, useState } from 'react';

import { deleteSecret, normalizeSecretName, secretNames, setSecret } from './runtime/secrets';
import styles from './SecretsDialog.module.css';

interface Props {
  onClose: () => void;
  /** Chiamata quando qualcosa cambia: i segreti vanno riconsegnati al runtime. */
  onChanged: () => void;
}

export function SecretsDialog({ onClose, onChanged }: Props) {
  const [names, setNames] = useState<string[]>(() => secretNames());
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const add = async () => {
    const name = normalizeSecretName(newName);
    if (!name) {
      setError('Serve un nome: lettere, cifre e trattino basso.');
      return;
    }
    if (!newValue) {
      setError('Serve un valore. Un segreto vuoto fallirebbe a runtime senza dire perché.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setSecret(name, newValue);
      setNames(secretNames());
      setNewName('');
      setNewValue('');
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    await deleteSecret(name);
    setNames(secretNames());
    onChanged();
  };

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label="Segreti">
      <div className={styles.panel}>
        <header className={styles.head}>
          <div>
            <h2 className={styles.title}>Segreti</h2>
            <span className={styles.subtitle}>
              Nel portachiavi del sistema, mai dentro il workflow
            </span>
          </div>
          <button type="button" className={styles.close} aria-label="Chiudi" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className={styles.body}>
          {names.length === 0 ? (
            <p className={styles.empty}>
              Nessun segreto. Definiscine uno e potrai usarlo nei nodi scrivendo{' '}
              <code>{'{{secrets.NOME}}'}</code> invece del valore in chiaro.
            </p>
          ) : (
            <ul className={styles.list}>
              {names.map((name) => (
                <li key={name} className={styles.row}>
                  <div className={styles.rowBody}>
                    <code className={styles.name}>{name}</code>
                    <code className={styles.usage}>{`{{secrets.${name}}}`}</code>
                  </div>
                  <button
                    type="button"
                    className={styles.remove}
                    aria-label={`Elimina ${name}`}
                    onClick={() => void remove(name)}
                  >
                    Elimina
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className={styles.form}>
            <h3 className={styles.formTitle}>Aggiungi</h3>
            <div className={styles.formRow}>
              <input
                className={styles.input}
                placeholder="NOME"
                aria-label="Nome del segreto"
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value);
                }}
              />
              <input
                type="password"
                className={styles.input}
                placeholder="valore"
                aria-label="Valore del segreto"
                value={newValue}
                onChange={(e) => {
                  setNewValue(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void add();
                }}
              />
              <button
                type="button"
                className={styles.add}
                disabled={busy}
                onClick={() => void add()}
              >
                Salva
              </button>
            </div>
            {newName && (
              <p className={styles.hint}>
                Si userà come <code>{`{{secrets.${normalizeSecretName(newName)}}}`}</code>
              </p>
            )}
            {error && <p className={styles.error}>{error}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
