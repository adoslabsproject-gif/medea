/**
 * Il wizard: creare un workflow descrivendolo a parole.
 *
 * Tre passi in un pannello solo — cosa deve fare, cosa sta facendo, cosa ne è
 * uscito. Mentre costruisce non si chiude per sbaglio: un minuto di lavoro
 * buttato via con un tasto premuto distratto è il modo migliore per far
 * odiare una funzione.
 */

import { useEffect } from 'react';

import type { Workflow } from '../types';

import { BuildingStage } from './BuildingStage';
import { GoalStage } from './GoalStage';
import { ReviewStage } from './ReviewStage';
import { useWizard } from './useWizard';
import styles from './WizardModal.module.css';

interface Props {
  onClose: () => void;
  /** Il workflow costruito, da aprire nell'editor. */
  onImport: (workflow: Workflow) => void;
}

const TITLES: Record<string, string> = {
  goal: 'Crea con l’assistente',
  building: 'Crea con l’assistente',
  review: 'Ecco cosa ho costruito',
  failed: 'Non ce l’ho fatta',
};

export function WizardModal({ onClose, onImport }: Props) {
  const wizard = useWizard();
  const busy = wizard.stage === 'building';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, busy]);

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label="Crea workflow">
      <div className={styles.panel}>
        <header className={styles.head}>
          <h2 className={styles.title}>{TITLES[wizard.stage] ?? 'Crea con l’assistente'}</h2>
          <button
            type="button"
            className={styles.close}
            aria-label="Chiudi"
            disabled={busy}
            title={busy ? 'Sta lavorando: aspetta che finisca' : 'Chiudi'}
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className={styles.body}>
          {wizard.stage === 'goal' && (
            <GoalStage goal={wizard.goal} onGoal={wizard.setGoal} onStart={wizard.start} />
          )}

          {wizard.stage === 'building' && (
            <BuildingStage elapsedMs={wizard.elapsedMs} built={wizard.built} trace={wizard.trace} />
          )}

          {wizard.stage === 'review' && wizard.result && (
            <ReviewStage
              workflow={wizard.result}
              issues={wizard.issues}
              warnings={wizard.warnings}
              trace={wizard.trace}
              onRetry={wizard.retry}
              onImport={() => {
                if (wizard.result) onImport(wizard.result);
              }}
            />
          )}

          {wizard.stage === 'failed' && (
            <div className={styles.failed}>
              <p className={styles.reason}>{wizard.reason ?? 'Qualcosa è andato storto.'}</p>
              {wizard.issues.length > 0 && (
                <ul className={styles.issues}>
                  {wizard.issues.map((issue, i) => (
                    <li key={`${issue.code}-${String(i)}`}>{issue.message}</li>
                  ))}
                </ul>
              )}
              <p className={styles.advice}>
                Spesso basta essere più precisi: da dove arriva il dato, dove deve finire, quando
                deve partire.
              </p>
              <div className={styles.actions}>
                <button type="button" className={styles.secondary} onClick={onClose}>
                  Chiudi
                </button>
                <button type="button" className={styles.primary} onClick={wizard.retry}>
                  Riprova
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
