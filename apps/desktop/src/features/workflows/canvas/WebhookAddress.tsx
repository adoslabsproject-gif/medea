/**
 * «Bussa qui»: l'indirizzo del webhook, dentro il pannello del nodo.
 *
 * Un nodo webhook senza il suo indirizzo è un nodo che non si può usare: si
 * configura, si salva, e poi non c'è nessun posto scritto da nessuna parte a
 * cui mandare la chiamata.
 *
 * L'indirizzo è **locale** e lo si dice: `127.0.0.1` non è raggiungibile da
 * internet. Vale per un altro programma su questa macchina, per uno script,
 * per un tunnel aperto apposta — e dirlo è più onesto che lasciar credere che
 * un servizio esterno possa chiamarlo così com'è.
 */

import { useEffect, useState } from 'react';

import { webhookAddress } from '../runtime';
import type { WebhookAddress as Address } from '../runtime';

import styles from './WebhookAddress.module.css';

interface Props {
  /** L'identificativo con cui il motore conosce questo workflow. */
  runtimeId: string | undefined;
}

export function WebhookAddress({ runtimeId }: Props) {
  const [address, setAddress] = useState<Address | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!runtimeId) {
      setAddress(null);
      return;
    }
    let alive = true;
    void webhookAddress(runtimeId).then((found) => {
      if (alive) setAddress(found);
    });
    return () => {
      alive = false;
    };
  }, [runtimeId]);

  if (!runtimeId) {
    return (
      <p className={styles.pending}>
        L’indirizzo compare dopo la prima esecuzione: prima di allora il motore non conosce ancora
        questo workflow.
      </p>
    );
  }

  if (!address) return null;

  return (
    <div className={styles.root}>
      <span className={styles.label}>Bussa qui</span>
      <code className={styles.url}>{address.url}</code>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.copy}
          onClick={() => {
            void navigator.clipboard.writeText(address.url).then(() => {
              setCopied(true);
              setTimeout(() => {
                setCopied(false);
              }, 2000);
            });
          }}
        >
          {copied ? 'Copiato' : 'Copia'}
        </button>
      </div>
      <p className={styles.hint}>
        È un indirizzo locale: vale per programmi su questo computer, non da internet.
      </p>
    </div>
  );
}
