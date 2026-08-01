/**
 * Le versioni: com'era prima.
 *
 * Un workflow che funzionava e adesso non funziona più è la situazione in cui
 * si perde più tempo. Qui si vede la fila di come è stato, e si torna indietro
 * — o si guarda soltanto, che spesso basta a capire cosa è cambiato.
 *
 * Ripristinare non distrugge il presente: il runtime prende un'istantanea di
 * com'è adesso prima di sovrascriverlo.
 */

import { useEffect, useState } from 'react';

import { getVersion, listVersions, rollbackVersion, snapshotVersion } from './runtime';
import type { WorkflowVersion } from './runtime';
import type { Workflow } from './types';
import styles from './VersionsDialog.module.css';

interface Props {
  /** L'identificativo con cui il runtime conosce questo workflow. */
  runtimeId: string;
  workflow: Workflow;
  onClose: () => void;
  /** Porta un documento nell'editor come bozza, senza salvarlo. */
  onLoad: (workflow: Workflow) => void;
}

/** La data come la direbbe una persona. */
function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('it-IT');
}

export function VersionsDialog({ runtimeId, workflow, onClose, onLoad }: Props) {
  const [versions, setVersions] = useState<WorkflowVersion[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState('');

  const refresh = () => {
    void listVersions(runtimeId)
      .then(setVersions)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setVersions([]);
      });
  };

  useEffect(refresh, [runtimeId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  /** Il documento di una versione, riportato nella forma dell'editor. */
  const asWorkflow = (document: {
    name?: string;
    description?: string;
    nodes?: unknown[];
    edges?: unknown[];
  }): Workflow => ({
    ...workflow,
    name: document.name ?? workflow.name,
    ...(document.description ? { description: document.description } : {}),
    nodes: (document.nodes ?? []) as Workflow['nodes'],
    edges: (document.edges ?? []) as Workflow['edges'],
  });

  const act = (id: string, run: () => Promise<void>) => {
    setBusy(id);
    setError(null);
    void run()
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label="Versioni">
      <div className={styles.panel}>
        <header className={styles.head}>
          <div>
            <h2 className={styles.title}>Versioni</h2>
            <span className={styles.subtitle}>Com’è stato questo workflow</span>
          </div>
          <button type="button" className={styles.close} aria-label="Chiudi" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className={styles.form}>
          <input
            className={styles.input}
            placeholder="Perché metti un punto fermo qui"
            aria-label="Motivo della versione"
            value={comment}
            onChange={(e) => {
              setComment(e.target.value);
            }}
          />
          <button
            type="button"
            className={styles.snapshot}
            disabled={busy !== null}
            onClick={() => {
              act('nuova', async () => {
                await snapshotVersion(runtimeId, comment || 'punto fermo');
                setComment('');
                refresh();
              });
            }}
          >
            Salva com’è adesso
          </button>
        </div>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.body}>
          {versions === null ? (
            <p className={styles.empty}>Carico…</p>
          ) : versions.length === 0 ? (
            <p className={styles.empty}>
              Nessuna versione. Ne nasce una a ogni aggiornamento del workflow nel motore, e quando
              ne salvi una tu.
            </p>
          ) : (
            <ul className={styles.list}>
              {versions.map((version) => (
                <li key={version.id} className={styles.row}>
                  <div className={styles.info}>
                    <span className={styles.number}>#{version.versionNumber}</span>
                    <span className={styles.when}>{when(version.createdAt)}</span>
                    <span className={styles.comment}>
                      {version.comment === 'auto' ? 'salvataggio automatico' : version.comment}
                    </span>
                  </div>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={busy !== null}
                      title="La apre nell’editor senza toccare quella corrente"
                      onClick={() => {
                        act(version.id, async () => {
                          onLoad(asWorkflow(await getVersion(runtimeId, version.id)));
                          onClose();
                        });
                      }}
                    >
                      Guarda
                    </button>
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={busy !== null}
                      title="Torna a questa versione. Prima di farlo il motore salva com’è adesso"
                      onClick={() => {
                        act(version.id, async () => {
                          onLoad(asWorkflow(await rollbackVersion(runtimeId, version.id)));
                          onClose();
                        });
                      }}
                    >
                      Ripristina
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
