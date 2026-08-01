/**
 * Bussare al proprio webhook, prima che lo faccia qualcun altro.
 *
 * Un nodo webhook si configura al buio: si sceglie come autenticare, si
 * salva, e si scopre se funziona quando il servizio esterno prova a
 * chiamarlo — cioè quando sbagliare costa.
 *
 * Con la firma HMAC il motore rifiuta chi non firma, e firmare a mano vuol
 * dire aprire un terminale. Qui la firma si calcola con lo stesso contratto
 * che il motore verifica — verificato mandando una chiamata vera: firmata
 * `202`, non firmata `401`.
 */

import { useState } from 'react';

import { webhookAddress } from '../runtime';

import { comeAutenticare, intestazioniFirmate, pianoFirma } from './webhook-test';
import styles from './WebhookTester.module.css';

interface Props {
  /** L'identificativo del workflow nel motore: senza, non c'è indirizzo. */
  runtimeId: string | undefined;
  /** La configurazione del nodo webhook: da lì si capisce come firmare. */
  config: Record<string, unknown>;
}

interface Esito {
  status: number;
  body: string;
  firmata: boolean;
}

export function WebhookTester({ runtimeId, config }: Props) {
  const [corpo, setCorpo] = useState('{\n  "prova": true\n}');
  const [esito, setEsito] = useState<Esito | null>(null);
  const [errore, setErrore] = useState<string | null>(null);
  const [inCorso, setInCorso] = useState(false);

  const piano = pianoFirma(config);
  const nota = comeAutenticare(config);

  const prova = () => {
    if (!runtimeId) return;
    setInCorso(true);
    setErrore(null);
    setEsito(null);

    void (async () => {
      try {
        const indirizzo = await webhookAddress(runtimeId);
        if (!indirizzo) {
          setErrore('Questo workflow non ha un indirizzo webhook: salvalo e riprova.');
          return;
        }

        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (piano) Object.assign(headers, await intestazioniFirmate(piano, corpo));

        const risposta = await fetch(indirizzo.url, { method: 'POST', headers, body: corpo });
        setEsito({
          status: risposta.status,
          body: (await risposta.text()).slice(0, 500),
          firmata: piano !== null,
        });
      } catch (e) {
        setErrore(e instanceof Error ? e.message : String(e));
      } finally {
        setInCorso(false);
      }
    })();
  };

  if (!runtimeId) {
    return (
      <p className={styles.pending}>
        La prova parte dall’indirizzo vero, che esiste dopo la prima esecuzione di questo workflow.
      </p>
    );
  }

  return (
    <section className={styles.root}>
      <h4 className={styles.title}>Prova il webhook</h4>

      {piano ? (
        <p className={styles.hint}>
          La chiamata verrà <strong>firmata</strong> con {piano.algo} e mandata nell’intestazione{' '}
          <code>{piano.header}</code>
          {piano.timestampHeader ? `, col momento in ${piano.timestampHeader}` : ''}. È la stessa
          firma che il motore verifica.
        </p>
      ) : (
        nota && <p className={styles.hint}>{nota}</p>
      )}

      <textarea
        className={styles.body}
        rows={5}
        spellCheck={false}
        aria-label="Corpo della chiamata"
        value={corpo}
        onChange={(e) => {
          setCorpo(e.target.value);
        }}
      />

      <button type="button" className={styles.send} disabled={inCorso} onClick={prova}>
        {inCorso ? 'Chiamo…' : 'Manda la chiamata'}
      </button>

      {errore && <p className={styles.error}>{errore}</p>}

      {esito && (
        <div className={styles.result} data-ok={esito.status < 400 ? 'true' : 'false'}>
          <span className={styles.status}>
            {esito.status}
            {esito.firmata ? ' · firmata' : ''}
          </span>
          <pre className={styles.pre}>{esito.body}</pre>
          {esito.status === 401 && piano && (
            <p className={styles.hint}>
              Rifiutata nonostante la firma: di solito il segreto qui non è quello che il servizio
              esterno userà davvero.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
