/**
 * Quando il portachiavi non risponde, e quindi non sappiamo cosa c'è.
 *
 * Prima al suo posto compariva la configurazione di un nuovo account: una
 * schermata che al primo avvio è giusta e qui è dannosa, perché invita a
 * reinserire credenziali già salvate. Il 2026-08-04 è successo davvero — il
 * nuovo account aveva lo stesso indirizzo del vecchio, la colonna è unica, e
 * il database ha rifiutato la riga. Da lì in poi ogni cartella si agganciava a
 * un account inesistente e la posta non caricava più.
 *
 * Non sapere è uno stato legittimo: si dichiara e si offre di riprovare.
 *
 * @module app/PortachiaviBloccato
 */

import styles from './PortachiaviBloccato.module.css';

interface Props {
  onRiprova: () => void;
}

export function PortachiaviBloccato({ onRiprova }: Props) {
  return (
    <div className={styles.root} role="alert">
      <div className={styles.card}>
        <span className={styles.icon} aria-hidden="true">
          🔐
        </span>
        <h1 className={styles.title}>Il portachiavi non risponde</h1>
        <p className={styles.body}>
          Gli account di posta sono salvati nel portachiavi di sistema, e il sistema non ha
          risposto. I tuoi account <strong>non sono stati persi</strong>: semplicemente adesso non
          si riescono a leggere.
        </p>
        <p className={styles.hint}>
          Di solito basta autorizzare Medea nella finestra che il Mac mostra — può essere finita
          dietro le altre. Se non compare, apri <em>Accesso Portachiavi</em> e sbloccalo, poi
          riprova.
        </p>
        <button type="button" className={styles.action} onClick={onRiprova} autoFocus>
          Riprova
        </button>
      </div>
    </div>
  );
}
