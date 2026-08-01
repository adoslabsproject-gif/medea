/**
 * I nodi aggiuntivi: quelli che non erano nella scatola.
 *
 * Un pacchetto `.ffnode` è **codice di terzi che verrà eseguito su questo
 * computer**. Per questo si installa da un file scelto a mano e non da un
 * catalogo remoto: la decisione di fidarsi deve restare una decisione, non un
 * click su un pulsante «Installa» accanto a un nome.
 *
 * La firma del pacchetto la verifica il motore. Qui il verdetto si mostra —
 * «firma riconosciuta» o no — invece di nasconderlo dietro un'icona verde che
 * nessuno guarda.
 */

import { useEffect, useRef, useState } from 'react';

import styles from './NodesDialog.module.css';
import {
  installCommunityNode,
  listCommunityNodes,
  uninstallCommunityNode,
  type CommunityNode,
} from './runtime';

interface Props {
  onClose: () => void;
}

export function NodesDialog({ onClose }: Props) {
  const [nodes, setNodes] = useState<CommunityNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const refresh = () => {
    void listCommunityNodes()
      .then((r) => {
        setNodes(r.nodes);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setNodes([]);
      });
  };

  useEffect(refresh, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, busy]);

  const install = (chosen: File) => {
    setBusy(true);
    setError(null);
    void chosen
      .arrayBuffer()
      .then((buffer) => installCommunityNode(new Uint8Array(buffer)))
      .then(() => {
        refresh();
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label="Nodi aggiuntivi">
      <div className={styles.panel}>
        <header className={styles.head}>
          <div>
            <h2 className={styles.title}>Nodi aggiuntivi</h2>
            <span className={styles.subtitle}>Pacchetti installati su questo computer</span>
          </div>
          <button
            type="button"
            className={styles.close}
            aria-label="Chiudi"
            disabled={busy}
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className={styles.body}>
          <p className={styles.warning}>
            Un pacchetto contiene codice che verrà eseguito su questo computer. Installa solo quelli
            di cui ti fidi.
          </p>

          {error && <p className={styles.error}>{error}</p>}

          {nodes === null ? (
            <p className={styles.empty}>Carico…</p>
          ) : nodes.length === 0 ? (
            <p className={styles.empty}>
              Nessun nodo aggiuntivo. I 193 preinstallati ci sono comunque: questi si aggiungono,
              non li sostituiscono.
            </p>
          ) : (
            <ul className={styles.list}>
              {nodes.map((node) => (
                <li key={`${node.vendor}/${node.id}`} className={styles.row}>
                  <div className={styles.info}>
                    <span className={styles.name}>{node.displayName}</span>
                    <span className={styles.meta}>
                      {node.vendor}/{node.id} · v{node.version} ·{' '}
                      {node.actionsCount === 1 ? '1 azione' : `${String(node.actionsCount)} azioni`}
                    </span>
                    <span className={node.verified ? styles.verified : styles.unverified}>
                      {node.verified ? 'firma riconosciuta' : 'firma non riconosciuta'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={styles.remove}
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void uninstallCommunityNode(node.vendor, node.id)
                        .then(() => {
                          refresh();
                        })
                        .catch((e: unknown) => {
                          setError(e instanceof Error ? e.message : String(e));
                        })
                        .finally(() => {
                          setBusy(false);
                        });
                    }}
                  >
                    Rimuovi
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className={styles.foot}>
          <input
            ref={file}
            type="file"
            accept=".ffnode,application/zip"
            className={styles.file}
            aria-label="Pacchetto da installare"
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              if (chosen) install(chosen);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            className={styles.install}
            disabled={busy}
            onClick={() => file.current?.click()}
          >
            {busy ? 'Installo…' : 'Installa da file…'}
          </button>
        </footer>
      </div>
    </div>
  );
}
