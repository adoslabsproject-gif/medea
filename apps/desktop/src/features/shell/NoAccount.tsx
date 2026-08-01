/**
 * «Qui serve un account di posta.»
 *
 * Si arriva qui da chi ha scelto di guardare l'app prima di configurare
 * niente. Sette sezioni su nove funzionano lo stesso — rubrica, anagrafiche,
 * articoli, listini, documenti, database, workflow — e non c'è ragione di
 * tenerle chiuse dietro una casella di posta.
 *
 * Le altre due la richiedono davvero: senza un account non c'è posta da
 * mostrare, e non ci sono impostazioni da cambiare. Meglio dirlo con una
 * frase e un pulsante, che con una schermata vuota.
 */

import { Button } from '@medea/ui';

import styles from './NoAccount.module.css';

interface Props {
  /** Cosa non si può fare senza account, in una parola. */
  what: string;
  onConfigure: () => void;
}

export function NoAccount({ what, onConfigure }: Props) {
  return (
    <div className={styles.root}>
      <div className={styles.card}>
        <h2 className={styles.title}>Serve un account di posta</h2>
        <p className={styles.body}>
          {what} arriva da una casella email, e non ne hai ancora configurata nessuna. Il resto
          dell’app funziona lo stesso: rubrica, anagrafiche, articoli, listini, documenti e workflow
          non hanno bisogno della posta.
        </p>
        <Button onClick={onConfigure}>Configura un account</Button>
      </div>
    </div>
  );
}
