/**
 * Cosa si può fare con più nodi insieme.
 *
 * La selezione multipla senza azioni in blocco è una funzione a metà: si
 * riesce a prendere sei nodi e poi bisogna cancellarli uno per uno.
 *
 * Compare solo da due nodi in su. Con uno solo c'è già il pannello di
 * configurazione, che quelle azioni le ha in fondo — una barra in più
 * direbbe le stesse cose in un posto diverso.
 */

import styles from './SelectionBar.module.css';

interface Props {
  count: number;
  onDuplicate: () => void;
  onDelete: () => void;
  onClear: () => void;
}

export function SelectionBar({ count, onDuplicate, onDelete, onClear }: Props) {
  if (count < 2) return null;

  return (
    <div className={styles.root} role="toolbar" aria-label="Azioni sulla selezione">
      <span className={styles.count}>{count} nodi selezionati</span>

      <button type="button" className={styles.action} onClick={onDuplicate}>
        Duplica
      </button>
      <button type="button" className={`${styles.action} ${styles.danger}`} onClick={onDelete}>
        Elimina
      </button>
      <button type="button" className={styles.ghost} onClick={onClear}>
        Deseleziona
      </button>
    </div>
  );
}
