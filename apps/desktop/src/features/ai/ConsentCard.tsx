import styles from './ConsentCard.module.css';
import type { ToolCall } from './tools';


interface Props {
  call: ToolCall;
  /** Frase in italiano che descrive l'azione, es. "eliminare il file X". */
  action: string;
  onDecide: (allow: boolean) => void;
}

/**
 * Gate di consenso per i tool che scrivono davvero: finché l'utente non
 * decide, il tool NON viene eseguito e il loop resta in attesa.
 */
export function ConsentCard({ call, action, onDecide }: Props) {
  return (
    <div className={styles.card} role="alertdialog" aria-label="Richiesta di conferma">
      <div className={styles.head}>
        <span className={styles.icon} aria-hidden>🔒</span>
        <div className={styles.title}>Confermi questa azione?</div>
      </div>
      <p className={styles.action}>
        L&apos;assistente vuole <strong>{action}</strong>.
      </p>
      <details className={styles.details}>
        <summary>Dettagli tecnici</summary>
        <pre className={styles.pre}>
{`${call.name}
${JSON.stringify(call.args, null, 2)}`}
        </pre>
      </details>
      <div className={styles.actions}>
        <button type="button" className={styles.deny} onClick={() => { onDecide(false); }}>
          Nega
        </button>
        <button type="button" className={styles.allow} onClick={() => { onDecide(true); }}>
          Consenti ed esegui
        </button>
      </div>
    </div>
  );
}
