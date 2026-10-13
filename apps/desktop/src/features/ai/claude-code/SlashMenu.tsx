/**
 * I comandi con la barra, proposti mentre si scrive — come in Claude Code.
 */

import { comandiNoti } from './settings';
import { completa, suggerimenti } from './slash';
import styles from './SlashMenu.module.css';

interface Props {
  /** Quello che c'è scritto nel campo. */
  input: string;
  /** Chiamata con il testo da mettere nel campo quando si sceglie un comando. */
  onScelta: (testo: string) => void;
}

export function SlashMenu({ input, onScelta }: Props) {
  const proposte = suggerimenti(input, comandiNoti());
  if (proposte.length === 0) return null;

  return (
    <ul className={styles.menu} aria-label="Comandi di Claude Code">
      {proposte.map((comando) => (
        <li key={comando}>
          <button
            type="button"
            className={styles.voce}
            // `onMouseDown` e non `onClick`: il clic toglierebbe il fuoco al
            // campo prima di arrivare qui.
            onMouseDown={(e) => {
              e.preventDefault();
              onScelta(completa(comando));
            }}
          >
            /{comando}
          </button>
        </li>
      ))}
    </ul>
  );
}
