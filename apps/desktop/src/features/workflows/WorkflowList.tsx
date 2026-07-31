/**
 * L'elenco dei workflow salvati.
 *
 * Mostra lo stato prima del nome: quello che si vuole sapere aprendo questa
 * sezione è «cosa sta girando adesso», non «come si chiamano».
 */

import type { WorkflowSummary } from './api';
import styles from './WorkflowList.module.css';

interface Props {
  items: WorkflowSummary[];
  activeId: number | null;
  onOpen: (id: number) => void;
  onNew: () => void;
  /** Apre il wizard: si descrive a parole e lo costruisce l'assistente. */
  onCreateWithAi: () => void;
  onDuplicate: (id: number) => void;
  onDelete: (id: number) => void;
  /** Apre lo storico delle esecuzioni di questo workflow. */
  onShowRuns: (id: number) => void;
}

export function WorkflowList({
  items,
  activeId,
  onOpen,
  onNew,
  onCreateWithAi,
  onDuplicate,
  onDelete,
  onShowRuns,
}: Props) {
  return (
    <aside className={styles.root} aria-label="Workflow salvati">
      <div className={styles.head}>
        <h2 className={styles.title}>Workflow</h2>
        <div className={styles.headActions}>
          <button
            type="button"
            className={styles.assist}
            title="Descrivi cosa deve fare e lo costruisce l'assistente"
            onClick={onCreateWithAi}
          >
            ✨ Assistente
          </button>
          <button type="button" className={styles.new} onClick={onNew}>
            + Nuovo
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <p className={styles.empty}>
          Nessun workflow. Creane uno, oppure descrivi a parole cosa deve fare.
        </p>
      ) : (
        <ul className={styles.list}>
          {items.map((wf) => (
            <li key={wf.id}>
              <div className={`${styles.row} ${wf.id === activeId ? styles.active : ''}`}>
                <button
                  type="button"
                  className={styles.open}
                  onClick={() => {
                    onOpen(wf.id);
                  }}
                >
                  <span className={styles.rowTop}>
                    <span
                      className={styles.dot}
                      data-on={wf.enabled ? 'true' : 'false'}
                      title={wf.enabled ? 'Attivo' : 'Non attivo'}
                    />
                    <span className={styles.name}>{wf.name}</span>
                  </span>
                  <span className={styles.meta}>
                    {wf.nodeCount} nodi ·{' '}
                    {wf.executionTarget === 'server' ? 'sul server' : 'locale'}
                  </span>
                </button>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    title="Esecuzioni e log"
                    aria-label={`Esecuzioni di ${wf.name}`}
                    onClick={() => {
                      onShowRuns(wf.id);
                    }}
                  >
                    ⏱
                  </button>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    title="Duplica"
                    aria-label={`Duplica ${wf.name}`}
                    onClick={() => {
                      onDuplicate(wf.id);
                    }}
                  >
                    ⧉
                  </button>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    title="Elimina"
                    aria-label={`Elimina ${wf.name}`}
                    onClick={() => {
                      onDelete(wf.id);
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
