/**
 * L'elenco dei workflow salvati.
 *
 * Mostra lo stato prima del nome: quello che si vuole sapere aprendo questa
 * sezione è «cosa sta girando adesso», non «come si chiamano».
 */

import { Zap } from 'lucide-react';

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
                    {/* Un pallino colorato dice solo acceso o spento, e lo
                        dice piano. Il fulmine è la stessa icona della sezione:
                        pieno quando il workflow gira da sé, contornato quando
                        aspetta di essere avviato a mano. */}
                    <span
                      className={styles.stato}
                      data-on={wf.enabled ? 'true' : 'false'}
                      title={wf.enabled ? 'Attivo: parte da solo' : 'Non attivo: si avvia a mano'}
                      aria-label={wf.enabled ? 'Attivo' : 'Non attivo'}
                    >
                      {wf.enabled ? (
                        <Zap size={13} strokeWidth={2.5} fill="currentColor" />
                      ) : (
                        <Zap size={13} strokeWidth={2} />
                      )}
                    </span>
                    <span className={styles.name}>{wf.name}</span>
                  </span>
                  <span className={styles.meta}>
                    {/* Lo stato scritto, non solo disegnato: un'icona la si
                        interpreta, una parola la si legge. */}
                    <span className={styles.statoTesto} data-on={wf.enabled ? 'true' : 'false'}>
                      {wf.enabled ? 'Attivo' : 'Non attivo'}
                    </span>
                    {' · '}
                    {wf.nodeCount} nodi
                    {/* «sul server» diceva una cosa falsa: in Medea si esegue
                        sempre qui. Il campo esiste solo perché un workflow
                        importato da FlowForge può dichiararlo, e riesportandolo
                        deve ritrovarselo — ma qui gira in locale, e vale la
                        pena dirlo a chi lo importa invece di lasciarglielo
                        credere. */}
                    {wf.executionTarget === 'server' && (
                      <span
                        className={styles.imported}
                        title="Arriva da FlowForge, dove girava sul server. Qui gira su questo computer."
                      >
                        {' '}
                        · importato
                      </span>
                    )}
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
