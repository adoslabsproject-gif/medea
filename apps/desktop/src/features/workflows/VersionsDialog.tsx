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

import {
  diffVersions,
  getVersion,
  listVersions,
  rollbackVersion,
  snapshotVersion,
} from './runtime';
import type { VersionDiff, WorkflowVersion } from './runtime';
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
  /** Le due versioni da confrontare, nell'ordine in cui si sono scelte. */
  const [confronto, setConfronto] = useState<string[]>([]);
  const [differenze, setDifferenze] = useState<VersionDiff | null>(null);

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

  /**
   * Sceglie o toglie una versione dal confronto.
   *
   * Due alla volta: confrontarne tre non vuol dire niente, e la terza
   * scelta sostituisce la più vecchia invece di essere ignorata — chi la
   * preme sta cambiando idea, non sbagliando.
   */
  const perConfronto = (id: string) => {
    setDifferenze(null);
    setConfronto((attuali) => {
      if (attuali.includes(id)) return attuali.filter((x) => x !== id);
      return attuali.length < 2 ? [...attuali, id] : [attuali[1] ?? '', id];
    });
  };

  const confronta = () => {
    const [a, b] = confronto;
    if (!a || !b) return;
    act('confronto', async () => {
      setDifferenze(await diffVersions(runtimeId, a, b));
    });
  };

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

        {confronto.length === 2 && (
          <div className={styles.compare}>
            <span className={styles.compareLabel}>Due versioni scelte</span>
            <button type="button" className={styles.snapshot} onClick={confronta}>
              Cosa è cambiato
            </button>
          </div>
        )}

        {differenze && (
          <div className={styles.diff}>
            {/* Il confronto lavora sui NODI: non dice cosa è cambiato dentro
                uno, dice dove guardare — che davanti a venti nodi è quasi
                tutto il lavoro. */}
            <DiffLine label="Aggiunti" ids={differenze.added} />
            <DiffLine label="Tolti" ids={differenze.removed} />
            <DiffLine label="Cambiati" ids={differenze.changed} />
            {differenze.added.length === 0 &&
              differenze.removed.length === 0 &&
              differenze.changed.length === 0 && (
                <span className={styles.same}>Nessuna differenza fra i nodi.</span>
              )}
          </div>
        )}

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
                      className={styles.pick}
                      data-on={confronto.includes(version.id) ? 'true' : 'false'}
                      title="Scegline due per vedere cosa è cambiato"
                      onClick={() => {
                        perConfronto(version.id);
                      }}
                    >
                      {confronto.includes(version.id) ? '✓ scelta' : 'Confronta'}
                    </button>
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

/** Una riga del confronto. Le righe vuote non si mostrano: dicono niente. */
function DiffLine({ label, ids }: { label: string; ids: string[] }) {
  if (ids.length === 0) return null;
  return (
    <span className={styles.diffLine}>
      <strong>{label}:</strong> {ids.join(', ')}
    </span>
  );
}
