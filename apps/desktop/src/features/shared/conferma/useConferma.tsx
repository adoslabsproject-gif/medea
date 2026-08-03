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
 *     if (!(await chiedi({ titolo: 'Eliminare?', pericoloso: true }))) return;
 *
 * e `{dialogo}` va reso da qualche parte nel componente.
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
}

interface Aperta extends RichiestaConferma {
  risolvi: (risposta: boolean) => void;
}

export function useConferma(): {
  chiedi: (richiesta: RichiestaConferma) => Promise<boolean>;
  dialogo: ReactNode;
} {
  const [aperta, setAperta] = useState<Aperta | null>(null);
  // La promessa in corso: serve a rispondere «no» se il dialogo viene chiuso
  // in un modo che non passa dai pulsanti — Esc, clic fuori.
  const inCorso = useRef<((risposta: boolean) => void) | null>(null);

  const chiudi = useCallback((risposta: boolean) => {
    inCorso.current?.(risposta);
    inCorso.current = null;
    setAperta(null);
  }, []);

  const chiedi = useCallback((richiesta: RichiestaConferma): Promise<boolean> => {
    // Una domanda alla volta: se ne arriva un'altra mentre la prima è aperta,
    // la prima si chiude con un no. Meglio che sovrapporle.
    inCorso.current?.(false);
    return new Promise<boolean>((risolvi) => {
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
      {null}
    </Dialog>
  );

  return { chiedi, dialogo };
}
