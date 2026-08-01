/**
 * Tutto quello che si può fare, cercandolo per nome.
 *
 * Le azioni di un editor finiscono in tre posti: la barra, un menu, una
 * scorciatoia da ricordare. La quarta strada è chiedere: si preme Cmd+K, si
 * scrive «pubb», e si pubblica.
 *
 * Non sostituisce i pulsanti — sostituisce il *cercarli*. Chi usa l'app tutti
 * i giorni impara dove sono; chi la usa ogni tanto no, e finora doveva aprire
 * il menu e leggerlo tutto.
 */

import { useEffect, useMemo, useState } from 'react';

import styles from './CommandPalette.module.css';

export interface Comando {
  id: string;
  label: string;
  /** In che gruppo compare, e come si cerca oltre al nome. */
  hint?: string;
  disabled?: boolean;
  run: () => void;
}

interface Props {
  comandi: Comando[];
  onClose: () => void;
}

export function CommandPalette({ comandi, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [scelto, setScelto] = useState(0);

  const trovati = useMemo(() => {
    const q = query.trim().toLowerCase();
    const utili = comandi.filter((c) => !c.disabled);
    if (!q) return utili;
    return utili.filter((c) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(q));
  }, [comandi, query]);

  // La scelta torna in cima a ogni ricerca: restare sulla quinta voce di un
  // elenco che è cambiato vorrebbe dire eseguire qualcosa che non si è letto.
  useEffect(() => {
    setScelto(0);
  }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setScelto((i) => Math.min(i + 1, trovati.length - 1));
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setScelto((i) => Math.max(i - 1, 0));
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const comando = trovati[scelto];
        if (comando) {
          comando.run();
          onClose();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [trovati, scelto, onClose]);

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label="Comandi">
      <div className={styles.panel}>
        <input
          className={styles.input}
          autoFocus
          placeholder="Cosa vuoi fare?"
          aria-label="Cerca un comando"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />

        {trovati.length === 0 ? (
          <p className={styles.empty}>Nessun comando con questo nome.</p>
        ) : (
          <ul className={styles.list} role="listbox">
            {trovati.map((comando, i) => (
              <li key={comando.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === scelto}
                  className={styles.item}
                  data-on={i === scelto ? 'true' : 'false'}
                  onMouseEnter={() => {
                    setScelto(i);
                  }}
                  onClick={() => {
                    comando.run();
                    onClose();
                  }}
                >
                  <span className={styles.label}>{comando.label}</span>
                  {comando.hint && <span className={styles.hint}>{comando.hint}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
