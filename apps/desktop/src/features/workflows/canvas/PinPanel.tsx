/**
 * «Non eseguirlo: usa questo.»
 *
 * Fissare un risultato su un nodo serve a due cose che oggi costano tempo:
 * provare quello che viene dopo senza rifare quello che c'è prima — e un
 * nodo che manda una email non va rieseguito venti volte per sistemare il
 * nodo dopo — e provare un caso che nella realtà capita di rado, tipo la
 * risposta vuota, senza aspettare che capiti.
 *
 * Il modo più comodo di riempirlo è **prendere l'ultima esecuzione**: quello
 * che il nodo ha prodotto davvero è quasi sempre il punto di partenza giusto,
 * e riscriverlo a mano sarebbe copiare un JSON dalla schermata accanto.
 */

import { useEffect, useState } from 'react';

import { clearPin, listPins, setPin } from '../runtime';

import styles from './PinPanel.module.css';

interface Props {
  nodeId: string;
  /** L'identificativo del workflow nel motore. Senza, non c'è dove fissare. */
  runtimeId: string | undefined;
  /** Cosa il nodo ha prodotto nell'ultima esecuzione, se c'è stata. */
  lastOutput?: unknown;
}

export function PinPanel({ nodeId, runtimeId, lastOutput }: Props) {
  const [testo, setTesto] = useState('');
  const [fissato, setFissato] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);
  const [salvato, setSalvato] = useState(false);

  useEffect(() => {
    if (!runtimeId) return;
    let vivo = true;
    void listPins(runtimeId)
      .then((pins) => {
        if (!vivo) return;
        const mio = pins.find((p) => p.nodeId === nodeId);
        setFissato(Boolean(mio?.enabled));
        if (mio) setTesto(JSON.stringify(mio.output, null, 2));
      })
      .catch(() => {
        // Nessun dato fissato, o motore spento: si parte da vuoto.
      });
    return () => {
      vivo = false;
    };
  }, [runtimeId, nodeId]);

  if (!runtimeId) {
    return (
      <p className={styles.pending}>
        I dati fissati vivono nel motore: compaiono dopo la prima esecuzione di questo workflow.
      </p>
    );
  }

  const salva = () => {
    let valore: unknown;
    try {
      valore = JSON.parse(testo || 'null');
    } catch {
      setErrore('Deve essere JSON: è quello che il nodo dopo si aspetta di ricevere.');
      return;
    }
    setErrore(null);
    void setPin(runtimeId, nodeId, valore)
      .then(() => {
        setFissato(true);
        setSalvato(true);
        setTimeout(() => {
          setSalvato(false);
        }, 1500);
      })
      .catch((e: unknown) => {
        setErrore(e instanceof Error ? e.message : String(e));
      });
  };

  return (
    <section className={styles.root}>
      <h4 className={styles.title}>Dati fissati</h4>

      <p className={styles.hint}>
        {fissato
          ? 'Questo nodo non viene eseguito: al suo posto il motore usa quello che c’è qui sotto.'
          : 'Fissa un risultato per provare quello che viene dopo senza rieseguire questo nodo.'}
      </p>

      <textarea
        className={styles.editor}
        rows={6}
        spellCheck={false}
        placeholder="{}"
        aria-label="Risultato fissato"
        value={testo}
        onChange={(e) => {
          setTesto(e.target.value);
        }}
      />

      {errore && <p className={styles.error}>{errore}</p>}

      <div className={styles.actions}>
        {lastOutput !== undefined && (
          <button
            type="button"
            className={styles.secondary}
            title="Parte da quello che il nodo ha prodotto davvero"
            onClick={() => {
              setTesto(JSON.stringify(lastOutput, null, 2));
            }}
          >
            Prendi dall’ultima esecuzione
          </button>
        )}

        <button type="button" className={styles.primary} onClick={salva}>
          {salvato ? 'Fissato' : 'Fissa'}
        </button>

        {fissato && (
          <button
            type="button"
            className={styles.secondary}
            onClick={() => {
              void clearPin(runtimeId, nodeId).then(() => {
                setFissato(false);
              });
            }}
          >
            Torna a eseguirlo
          </button>
        )}
      </div>
    </section>
  );
}
