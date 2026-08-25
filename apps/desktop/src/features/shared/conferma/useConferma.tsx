/**
 * Chiedere conferma prima di fare qualcosa di irreversibile.
 *
 * Sostituisce `window.confirm`, che nel webview di Tauri non si può usare: il
 * pannello nativo del browser lo deve implementare l'applicazione ospite, e
 * dove non è implementato la chiamata **restituisce sempre `false` senza
 * mostrare niente**. Il risultato è la cosa peggiore che possa capitare a una
 * conferma: l'utente clicca, non vede alcuna domanda, e l'azione non avviene.
 * Sembra un pulsante rotto.
 *
 * L'uso ricalca quello di prima, con un `await` in più:
 *
 *     const { chiedi, dialogo } = useConferma();
 *     …
 *     const { ok } = await chiedi({ titolo: 'Eliminare?', pericoloso: true });
 *     if (!ok) return;
 *
 * e `{dialogo}` va reso da qualche parte nel componente.
 *
 * La risposta è un OGGETTO e non un booleano perché a una conferma può
 * accompagnarsi una scelta — «elimina anche le tabelle» — e legarla a una
 * seconda finestra significherebbe due domande per una decisione sola.
 *
 * @module features/shared/conferma/useConferma
 */

import { Dialog } from '@medea/ui';
import { useCallback, useRef, useState, type ReactNode } from 'react';

import styles from './useConferma.module.css';

export interface RichiestaConferma {
  titolo: string;
  /** Cosa succede se si conferma: il dettaglio che fa decidere. */
  dettaglio?: string;
  /** Il testo del pulsante che conferma. Default: «Conferma». */
  conferma?: string;
  /** Colora di rosso il pulsante: per quello che non si può disfare. */
  pericoloso?: boolean;
  /**
   * Una scelta che si fa INSIEME alla conferma, non prima e non dopo.
   *
   * Serve quando l'azione ha una parte facoltativa che dipende dalla stessa
   * decisione — «elimina il workflow, e con lui le sue tabelle». Spenta di
   * suo: quello che porta via dei dati non si sceglie per distrazione.
   */
  spunta?: { etichetta: string; dettaglio?: string; predefinito?: boolean };
}

/** La risposta: se ha confermato, e com'era la spunta quando l'ha fatto. */
export interface EsitoConferma {
  ok: boolean;
  /** Vero solo se la spunta era offerta ED è stata segnata. */
  spuntato: boolean;
}

interface Aperta extends RichiestaConferma {
  risolvi: (risposta: EsitoConferma) => void;
}

export function useConferma(): {
  chiedi: (richiesta: RichiestaConferma) => Promise<EsitoConferma>;
  dialogo: ReactNode;
} {
  const [aperta, setAperta] = useState<Aperta | null>(null);
  const [spuntato, setSpuntato] = useState(false);
  // La promessa in corso: serve a rispondere «no» se il dialogo viene chiuso
  // in un modo che non passa dai pulsanti — Esc, clic fuori.
  const inCorso = useRef<((risposta: EsitoConferma) => void) | null>(null);
  // Letto al momento della risposta: il gestore del pulsante nasce con la
  // chiusura sul valore del primo render, e senza questo riferirebbe sempre
  // «non spuntato» qualunque cosa l'utente abbia fatto.
  const spuntaCorrente = useRef(false);

  const chiudi = useCallback((ok: boolean) => {
    inCorso.current?.({ ok, spuntato: ok && spuntaCorrente.current });
    inCorso.current = null;
    setAperta(null);
  }, []);

  const chiedi = useCallback((richiesta: RichiestaConferma): Promise<EsitoConferma> => {
    // Una domanda alla volta: se ne arriva un'altra mentre la prima è aperta,
    // la prima si chiude con un no. Meglio che sovrapporle.
    inCorso.current?.({ ok: false, spuntato: false });
    const partenza = richiesta.spunta?.predefinito ?? false;
    spuntaCorrente.current = partenza;
    setSpuntato(partenza);
    return new Promise<EsitoConferma>((risolvi) => {
      inCorso.current = risolvi;
      setAperta({ ...richiesta, risolvi });
    });
  }, []);

  const dialogo = (
    <Dialog
      open={aperta !== null}
      onClose={() => {
        chiudi(false);
      }}
      title={aperta?.titolo ?? ''}
      {...(aperta?.dettaglio ? { description: aperta.dettaglio } : {})}
      size="sm"
      footer={
        <div className={styles.azioni}>
          <button
            type="button"
            className={styles.annulla}
            onClick={() => {
              chiudi(false);
            }}
          >
            Annulla
          </button>
          <button
            type="button"
            className={aperta?.pericoloso ? styles.pericoloso : styles.conferma}
            onClick={() => {
              chiudi(true);
            }}
          >
            {aperta?.conferma ?? 'Conferma'}
          </button>
        </div>
      }
    >
      {aperta?.spunta ? (
        <label className={styles.spunta}>
          <input
            type="checkbox"
            checked={spuntato}
            onChange={(e) => {
              spuntaCorrente.current = e.target.checked;
              setSpuntato(e.target.checked);
            }}
          />
          <span>
            <span className={styles.spuntaEtichetta}>{aperta.spunta.etichetta}</span>
            {aperta.spunta.dettaglio !== undefined && (
              <span className={styles.spuntaDettaglio}>{aperta.spunta.dettaglio}</span>
            )}
          </span>
        </label>
      ) : null}
    </Dialog>
  );

  return { chiedi, dialogo };
}
