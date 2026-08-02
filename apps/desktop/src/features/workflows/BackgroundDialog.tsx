/**
 * Tenere in vita le automazioni: i due interruttori, e cosa comportano.
 *
 * Le automazioni girano dentro Medea. Se Medea non c'è, non gira niente — e un
 * cron delle otto del mattino che funziona solo a finestra aperta non è
 * un'automazione, è un promemoria per l'utente.
 *
 * Il pannello dice prima cosa cambia e poi offre l'interruttore, perché
 * un'applicazione che resta viva dopo che l'hai chiusa deve essere una cosa
 * scelta, non una sorpresa scoperta dalla barra di stato.
 */

import { useEffect, useState } from 'react';

import styles from './BackgroundDialog.module.css';
import { backgroundStatus, setAutostart, setStayAlive } from './runtime/background';

interface Props {
  onClose: () => void;
}

export function BackgroundDialog({ onClose }: Props) {
  const [stayAlive, setStay] = useState(false);
  const [autostart, setAuto] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);

  useEffect(() => {
    void backgroundStatus()
      .then((s) => {
        setStay(s.stayAlive);
        setAuto(s.autostart);
      })
      .catch(() => {
        setErrore('Impostazioni non leggibili.');
      });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // L'interruttore si muove solo se il sistema ha davvero accettato: mostrare
  // acceso qualcosa che non lo è sarebbe peggio che non offrirlo.
  const cambia = (
    applica: (v: boolean) => Promise<void>,
    aggiorna: (v: boolean) => void,
    valore: boolean,
  ) => {
    setErrore(null);
    void applica(valore)
      .then(() => {
        aggiorna(valore);
      })
      .catch((e: unknown) => {
        setErrore(e instanceof Error ? e.message : 'Impostazione non applicata.');
      });
  };

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label="Automazioni attive"
    >
      <div className={styles.panel}>
        <header className={styles.head}>
          <div>
            <h2 className={styles.title}>Tenere in vita le automazioni</h2>
            <span className={styles.subtitle}>Quando Medea deve continuare a lavorare</span>
          </div>
          <button type="button" className={styles.close} aria-label="Chiudi" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className={styles.body}>
          <p className={styles.explain}>
            I workflow attivi girano dentro Medea. Se chiudi Medea, non gira niente: un cron delle
            otto del mattino scatta solo se a quell&apos;ora l&apos;applicazione è in funzione.
          </p>

          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={stayAlive}
              onChange={(e) => {
                cambia(setStayAlive, setStay, e.target.checked);
              }}
            />
            <span>
              <strong>Continua a lavorare a finestra chiusa</strong>
              <small>
                Chiudere la finestra non chiude Medea: resta un&apos;icona nella barra di stato, da
                cui riaprirla o uscire davvero.
              </small>
            </span>
          </label>

          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={autostart}
              onChange={(e) => {
                cambia(setAutostart, setAuto, e.target.checked);
              }}
            />
            <span>
              <strong>Riparti all&apos;accensione del computer</strong>
              <small>
                Dopo un riavvio le automazioni ripartono da sole, senza aspettare che qualcuno apra
                Medea.
              </small>
            </span>
          </label>

          <p className={styles.note}>
            Le esecuzioni cadute mentre Medea era spenta non vanno perse: alla ripartenza quella più
            recente viene recuperata, una sola volta.
          </p>

          {errore ? <p className={styles.error}>{errore}</p> : null}
        </div>
      </div>
    </div>
  );
}
