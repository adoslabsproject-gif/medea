/**
 * «Rifallo, ma con questo dato diverso.»
 *
 * Ripartire da un nodo riusa le uscite di quelli prima. Cambiarle a mano
 * prima di ripartire è un'altra cosa ancora: è la differenza fra «rifai lo
 * stesso giro» e «rifallo come sarebbe andato se quel campo fosse stato
 * diverso».
 *
 * Serve a provare i casi limite senza farli accadere: la risposta vuota, il
 * cliente senza partita IVA, l'importo negativo. Aspettare che capitino
 * davvero, per capire come reagisce il flusso, non è un piano.
 */

import { useState } from 'react';

import { DataView } from './DataView';
import styles from './ReplayDialog.module.css';
import type { RunStep } from './types';

interface Props {
  /** Il nodo da cui si riparte. */
  fromNode: string;
  /** I passi a monte: sono quelli le cui uscite si possono cambiare. */
  upstream: RunStep[];
  onClose: () => void;
  onReplay: (overrides: Record<string, unknown>) => void;
}

export function ReplayDialog({ fromNode, upstream, onClose, onReplay }: Props) {
  /** Le uscite riscritte, per nodo. Chi non si tocca non entra qui. */
  const [modifiche, setModifiche] = useState<Record<string, string>>({});
  const [errore, setErrore] = useState<string | null>(null);

  const riparti = () => {
    const overrides: Record<string, unknown> = {};
    for (const [nodeId, testo] of Object.entries(modifiche)) {
      try {
        overrides[nodeId] = JSON.parse(testo);
      } catch {
        setErrore(`Il dato di ${nodeId} non è JSON: il motore lo consegnerebbe così com’è.`);
        return;
      }
    }
    onReplay(overrides);
    onClose();
  };

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label="Riparti da qui">
      <div className={styles.panel}>
        <header className={styles.head}>
          <div>
            <h2 className={styles.title}>Riparti da {fromNode}</h2>
            <span className={styles.subtitle}>
              I nodi prima non si rieseguono: si riusano le loro uscite
            </span>
          </div>
          <button type="button" className={styles.close} aria-label="Chiudi" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className={styles.body}>
          {upstream.length === 0 ? (
            <p className={styles.hint}>Non c’è niente prima di questo nodo: riparte dall’inizio.</p>
          ) : (
            <>
              <p className={styles.hint}>
                Puoi cambiare cosa avevano prodotto, per provare un caso che nella realtà capita di
                rado.
              </p>

              {upstream.map((step) => {
                const modificato = modifiche[step.nodeId];
                return (
                  <section key={step.nodeId} className={styles.node}>
                    <header className={styles.nodeHead}>
                      <code className={styles.nodeId}>{step.nodeId}</code>
                      <button
                        type="button"
                        className={styles.edit}
                        onClick={() => {
                          setModifiche((m) => {
                            if (step.nodeId in m) {
                              const { [step.nodeId]: _tolto, ...resto } = m;
                              return resto;
                            }
                            return { ...m, [step.nodeId]: step.output ?? '{}' };
                          });
                        }}
                      >
                        {modificato === undefined ? 'Cambia' : 'Lascia com’era'}
                      </button>
                    </header>

                    {modificato === undefined ? (
                      step.output && <DataView text={step.output} />
                    ) : (
                      <textarea
                        className={styles.editor}
                        rows={6}
                        spellCheck={false}
                        aria-label={`Uscita di ${step.nodeId}`}
                        value={modificato}
                        onChange={(e) => {
                          setModifiche((m) => ({ ...m, [step.nodeId]: e.target.value }));
                        }}
                      />
                    )}
                  </section>
                );
              })}
            </>
          )}

          {errore && <p className={styles.error}>{errore}</p>}

          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={onClose}>
              Annulla
            </button>
            <button type="button" className={styles.primary} onClick={riparti}>
              Riparti
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
