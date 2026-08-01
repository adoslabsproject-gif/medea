/**
 * Farsi raggiungere da internet: l'interruttore, e cosa comporta.
 *
 * Accendere questo canale significa che una chiamata partita da internet può
 * far eseguire un workflow su questo computer. È una cosa che si sceglie, e
 * il pannello lo dice prima dell'interruttore, non in una nota sotto.
 *
 * Il computer non apre nessuna porta: è lui a collegarsi al relay, in uscita.
 * È la differenza fra farsi trovare e andare a bussare, e vale la pena
 * scriverla — chi ha paura di aprire il router deve poter capire che non
 * serve.
 */

import { useEffect, useState } from 'react';

import styles from './RelayDialog.module.css';
import {
  relayEnabled,
  relayState,
  relayToken,
  relayUrl,
  setRelayEnabled,
  setRelayUrl,
  startRelay,
  stopRelay,
  subscribeRelay,
  type RelayState,
} from './runtime';

interface Props {
  onClose: () => void;
}

export function RelayDialog({ onClose }: Props) {
  const [url, setUrl] = useState(() => relayUrl());
  const [enabled, setEnabled] = useState(() => relayEnabled());
  const [state, setState] = useState<RelayState>(() => relayState());
  const [copied, setCopied] = useState(false);

  useEffect(() => subscribeRelay(setState), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const toggle = (next: boolean) => {
    setEnabled(next);
    setRelayEnabled(next);
    setRelayUrl(url);

    if (!next) {
      stopRelay();
      return;
    }
    void relayToken().then((token) => {
      startRelay({ baseUrl: url, token });
    });
  };

  const address = state.installId ? `${url.replace(/\/+$/, '')}/h/${state.installId}` : null;

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label="Raggiungibilità">
      <div className={styles.panel}>
        <header className={styles.head}>
          <div>
            <h2 className={styles.title}>Farsi raggiungere da internet</h2>
            <span className={styles.subtitle}>Per i webhook che arrivano da fuori</span>
          </div>
          <button type="button" className={styles.close} aria-label="Chiudi" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className={styles.body}>
          <p className={styles.explain}>
            Un computer di casa non è raggiungibile da internet. Con questo acceso, Medea apre un
            canale <strong>in uscita</strong> verso un relay: nessuna porta aperta sul tuo router,
            nessun indirizzo IP da dare a nessuno.
          </p>

          <p className={styles.warning}>
            Da acceso, una chiamata partita da internet può far eseguire un workflow su questo
            computer. Passano solo i percorsi dei webhook, e ogni webhook ha già il suo token — ma è
            comunque una porta che prima non c'era.
          </p>

          <label className={styles.label} htmlFor="relay-url">
            Indirizzo del relay
          </label>
          <input
            id="relay-url"
            className={styles.input}
            placeholder="https://automazionezeli.com/relay"
            value={url}
            disabled={enabled}
            onChange={(e) => {
              setUrl(e.target.value);
            }}
          />

          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={enabled}
              disabled={!url.trim()}
              onChange={(e) => {
                toggle(e.target.checked);
              }}
            />
            <span>Accendi il canale</span>
          </label>

          <p className={styles.status} data-on={state.connected ? 'true' : 'false'}>
            {enabled
              ? state.connected
                ? 'Collegato.'
                : (state.error ?? 'Sto provando a collegarmi…')
              : 'Spento.'}
          </p>

          {address && (
            <div className={styles.address}>
              <span className={styles.addressLabel}>Il tuo indirizzo pubblico</span>
              <code className={styles.url}>{address}/webhooks/…</code>
              <p className={styles.hint}>
                Ai percorsi dei webhook che trovi nel pannello di ogni nodo, sostituisci l'indirizzo
                locale con questo.
              </p>
              <button
                type="button"
                className={styles.copy}
                onClick={() => {
                  void navigator.clipboard.writeText(address).then(() => {
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
          )}
        </div>
      </div>
    </div>
  );
}
