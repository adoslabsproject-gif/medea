/**
 * I passi di un'esecuzione, uno per nodo, nell'ordine in cui sono avvenuti.
 *
 * I nodi falliti sono aperti di default e gli altri chiusi: chi apre questa
 * schermata cerca l'errore, non la conferma che i primi quattordici nodi
 * sono andati bene.
 */

import { useState } from 'react';

import styles from './RunStepList.module.css';
import {
  formatDuration,
  formatWhen,
  RUN_STATUS_LABEL,
  STEP_STATUS_LABEL,
  type RunRecord,
  type RunStep,
} from './types';

interface Props {
  run: RunRecord;
  steps: RunStep[];
  /** Riparte da questo nodo riusando quello che c'era prima. Assente quando
   *  non è possibile: il motore spento, o un workflow che il runtime non
   *  conosce ancora. */
  onReplay?: (fromNode: string) => void;
  /** Il nodo da cui si sta ripartendo in questo momento. */
  replaying?: string | null;
}

export function RunStepList({ run, steps, onReplay, replaying }: Props) {
  return (
    <>
      <header className={styles.head}>
        <span className={styles.status} data-status={run.status}>
          {RUN_STATUS_LABEL[run.status]}
        </span>
        <span className={styles.meta}>
          {formatWhen(run.startedAt)} · {formatDuration(run.totalDurationMs)}
          {run.triggerType ? ` · avviata da ${run.triggerType}` : ''}
          {run.errorCount > 0
            ? ` · ${String(run.errorCount)} ${run.errorCount === 1 ? 'errore' : 'errori'}`
            : ''}
        </span>
      </header>

      {steps.length === 0 ? (
        <p className={styles.empty}>Questa esecuzione non ha registrato nessun passo.</p>
      ) : (
        <ol className={styles.steps}>
          {steps.map((step, i) => (
            <StepRow
              key={`${step.nodeId}-${String(i)}`}
              step={step}
              index={i + 1}
              {...(onReplay ? { onReplay } : {})}
              busy={replaying === step.nodeId}
            />
          ))}
        </ol>
      )}
    </>
  );
}

function StepRow({
  step,
  index,
  onReplay,
  busy = false,
}: {
  step: RunStep;
  index: number;
  onReplay?: (fromNode: string) => void;
  busy?: boolean;
}) {
  // Un passo fallito si apre da solo: è quello che si sta cercando.
  const [open, setOpen] = useState(step.status === 'error');
  const hasDetail = Boolean(step.error ?? step.output ?? step.input);

  return (
    <li className={styles.step} data-status={step.status}>
      <button
        type="button"
        className={styles.stepHead}
        disabled={!hasDetail}
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        <span className={styles.index}>{index}</span>
        <span className={styles.nodeId}>{step.nodeId}</span>
        {step.defId && <span className={styles.defId}>{step.defId}</span>}
        <span className={styles.stepStatus}>{STEP_STATUS_LABEL[step.status]}</span>
        <span className={styles.duration}>{formatDuration(step.durationMs)}</span>
        {hasDetail && (
          <span className={styles.chevron} aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
        )}
      </button>

      {open && hasDetail && (
        <div className={styles.detail}>
          {step.error && <Block label="Errore" text={step.error} tone="error" />}
          {step.input && <Block label="Ingresso" text={step.input} />}
          {step.output && <Block label="Uscita" text={step.output} />}
        </div>
      )}

      {onReplay && (
        <button
          type="button"
          className={styles.replay}
          disabled={busy}
          title="Riparte da qui riusando le uscite dei nodi precedenti"
          onClick={() => {
            onReplay(step.nodeId);
          }}
        >
          {busy ? 'Riparto…' : 'Riparti da qui'}
        </button>
      )}
    </li>
  );
}

/** Un blocco di dati: se è JSON si mostra indentato, altrimenti com'è. */
function Block({ label, text, tone }: { label: string; text: string; tone?: 'error' }) {
  return (
    <div className={styles.block}>
      <span className={styles.blockLabel}>{label}</span>
      <pre className={styles.blockBody} data-tone={tone}>
        {prettify(text)}
      </pre>
    </div>
  );
}

function prettify(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}
