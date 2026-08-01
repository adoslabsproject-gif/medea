/**
 * Con che dati parte, quando lo si prova.
 *
 * Un workflow che comincia con «quando arriva una email» o «quando qualcuno
 * chiama questo indirizzo» non si può provare a mano senza far arrivare
 * davvero una email o una chiamata. Il finto ingresso serve a quello: si
 * scrive com'è fatto il messaggio che arriverebbe, e si preme Esegui.
 *
 * Resta salvato per questo workflow. Chi lo sta mettendo a punto lo prova
 * venti volte di fila, e riscriverlo ogni volta sarebbe il lavoro più stupido
 * della giornata.
 */

import { useEffect, useState } from 'react';

import styles from './TriggerInputDialog.module.css';

interface Props {
  workflowId: string | undefined;
  onClose: () => void;
  /** Esegue con questi dati. */
  onRun: (input: unknown) => void;
}

/** Dove si ricorda il finto ingresso di un workflow. */
export function triggerInputKey(workflowId: string): string {
  return `medea.workflows.triggerInput.${workflowId}`;
}

/** Il finto ingresso salvato per questo workflow, se ce n'è uno. */
export function savedTriggerInput(workflowId: string | undefined): unknown {
  if (!workflowId) return undefined;
  const raw = localStorage.getItem(triggerInputKey(workflowId));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function TriggerInputDialog({ workflowId, onClose, onRun }: Props) {
  const [testo, setTesto] = useState(() => {
    const salvato = workflowId ? localStorage.getItem(triggerInputKey(workflowId)) : null;
    return salvato ?? '{\n  \n}';
  });
  const [errore, setErrore] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const esegui = () => {
    let valore: unknown;
    try {
      valore = JSON.parse(testo || '{}');
    } catch {
      setErrore('Deve essere JSON: è quello che il primo nodo riceverà.');
      return;
    }
    if (workflowId) localStorage.setItem(triggerInputKey(workflowId), testo);
    onRun(valore);
    onClose();
  };

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label="Dati di prova">
      <div className={styles.panel}>
        <header className={styles.head}>
          <div>
            <h2 className={styles.title}>Esegui con questi dati</h2>
            <span className={styles.subtitle}>Il finto ingresso del trigger</span>
          </div>
          <button type="button" className={styles.close} aria-label="Chiudi" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className={styles.body}>
          <p className={styles.hint}>
            Un workflow che comincia con «quando arriva una email» non si può provare senza farne
            arrivare una. Qui si scrive com’è fatto il messaggio che arriverebbe.
          </p>

          <textarea
            className={styles.editor}
            rows={10}
            spellCheck={false}
            autoFocus
            aria-label="Dati di prova"
            value={testo}
            onChange={(e) => {
              setTesto(e.target.value);
            }}
          />

          {errore && <p className={styles.error}>{errore}</p>}

          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={onClose}>
              Annulla
            </button>
            <button type="button" className={styles.primary} onClick={esegui}>
              ▶ Esegui
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
