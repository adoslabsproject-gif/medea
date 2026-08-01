/**
 * Le esecuzioni di un workflow, con i log nodo per nodo.
 *
 * È la schermata che si apre quando qualcosa non ha funzionato, ed è per
 * quella domanda che esiste: **dove si è rotto**. Per questo l'elenco a
 * sinistra e il dettaglio a destra, con i nodi in ordine di esecuzione e
 * l'errore aperto per primo — cercare a mano quale dei quindici nodi ha
 * fallito è il lavoro che deve fare la schermata, non l'utente.
 */

import { useEffect, useState } from 'react';

import { replayRun } from '../runtime';

import { runsApi } from './api';
import { ReplayDialog } from './ReplayDialog';
import styles from './RunsModal.module.css';
import { RunStepList } from './RunStepList';
import {
  formatDuration,
  formatWhen,
  parseSteps,
  RUN_STATUS_LABEL,
  type RunRecord,
  type RunSummary,
} from './types';

interface Props {
  workflowId: number;
  workflowName: string;
  /** L'identificativo con cui il runtime conosce questo workflow: senza,
   *  non si può ripartire da un nodo — il runtime non saprebbe cosa. */
  runtimeId?: string;
  onClose: () => void;
}

export function RunsModal({ workflowId, workflowName, runtimeId, onClose }: Props) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<RunRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [replaying, setReplaying] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Il nodo da cui si sta per ripartire, mentre si decide se cambiare i dati. */
  const [replayFrom, setReplayFrom] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void runsApi
      .list(workflowId)
      .then((list) => {
        if (!alive) return;
        setRuns(list);
        setLoading(false);
        // La più recente è quella che si vuole vedere: aprirla da soli
        // risparmia un click a ogni apertura.
        const first = list[0];
        if (first) void openRun(first.id);
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [workflowId]);

  async function openRun(id: string) {
    setSelected(await runsApi.get(id));
  }

  /**
   * Riparte da un nodo riusando le uscite già registrate.
   *
   * Rifare i primi quattro nodi per capire perché fallisce il quinto è tempo
   * buttato — e se uno di quelli manda una email, è anche una email in più a
   * ogni tentativo.
   */
  function replay(fromNode: string, overrides: Record<string, unknown> = {}) {
    const run = selected;
    if (!run || !runtimeId) return;
    setReplaying(fromNode);
    setNotice(null);
    void replayRun({
      runtimeWorkflowId: runtimeId,
      runId: run.id,
      fromNode,
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    })
      .then(async (result) => {
        setNotice(
          `Ripartita da ${fromNode}: ${result.status}, ${String(result.reused)} ${result.reused === 1 ? 'passo riusato' : 'passi riusati'}.`,
        );
        setRuns(await runsApi.list(workflowId));
      })
      .catch((e: unknown) => {
        setNotice(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        setReplaying(null);
      });
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={`Esecuzioni di ${workflowName}`}
    >
      <div className={styles.panel}>
        <header className={styles.head}>
          <div>
            <h2 className={styles.title}>Esecuzioni</h2>
            <span className={styles.subtitle}>{workflowName}</span>
          </div>
          <div className={styles.headActions}>
            {runs.length > 0 && (
              <button
                type="button"
                className={styles.clear}
                onClick={() => {
                  void runsApi.clear(workflowId).then(() => {
                    setRuns([]);
                    setSelected(null);
                  });
                }}
              >
                Svuota lo storico
              </button>
            )}
            <button type="button" className={styles.close} aria-label="Chiudi" onClick={onClose}>
              ✕
            </button>
          </div>
        </header>

        <div className={styles.body}>
          <aside className={styles.list} aria-label="Elenco delle esecuzioni">
            {loading ? (
              <p className={styles.empty}>Carico…</p>
            ) : runs.length === 0 ? (
              <p className={styles.empty}>
                Questo workflow non è ancora stato eseguito. Lo storico si riempie da solo, anche
                per le esecuzioni che partono da un cron o da una casella in ascolto.
              </p>
            ) : (
              <ul className={styles.runs}>
                {runs.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className={styles.run}
                      data-on={selected?.id === r.id ? 'true' : 'false'}
                      data-status={r.status}
                      onClick={() => void openRun(r.id)}
                    >
                      <span className={styles.runTop}>
                        <span className={styles.dot} data-status={r.status} />
                        <span className={styles.runWhen}>{formatWhen(r.startedAt)}</span>
                      </span>
                      <span className={styles.runMeta}>
                        {RUN_STATUS_LABEL[r.status]} · {r.stepCount}{' '}
                        {r.stepCount === 1 ? 'nodo' : 'nodi'} · {formatDuration(r.totalDurationMs)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <section className={styles.detail} aria-label="Dettaglio dell'esecuzione">
            {notice && (
              <p className={styles.notice} role="status">
                {notice}
              </p>
            )}
            {selected ? (
              <RunStepList
                run={selected}
                steps={parseSteps(selected)}
                {...(runtimeId
                  ? {
                      onReplay: (fromNode: string) => {
                        setReplayFrom(fromNode);
                      },
                    }
                  : {})}
                replaying={replaying}
              />
            ) : (
              <p className={styles.empty}>Scegli un'esecuzione per vederne i passi.</p>
            )}
          </section>
        </div>
      </div>

      {replayFrom && selected && (
        <ReplayDialog
          fromNode={replayFrom}
          // Solo i passi PRIMA di quello da cui si riparte: quelli dopo
          // verranno rieseguiti, e cambiarne l'uscita non vorrebbe dire niente.
          upstream={parseSteps(selected).slice(
            0,
            parseSteps(selected).findIndex((s) => s.nodeId === replayFrom),
          )}
          onClose={() => {
            setReplayFrom(null);
          }}
          onReplay={(overrides) => {
            replay(replayFrom, overrides);
          }}
        />
      )}
    </div>
  );
}
