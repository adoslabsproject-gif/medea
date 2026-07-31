/**
 * I messaggi della conversazione.
 *
 * Mentre l'agente lavora si vedono i passi che sta compiendo — cerca il nodo,
 * lo aggiunge, lo configura — invece di una rotellina. Su un'operazione che
 * dura venti secondi la differenza fra le due cose è sapere se sta andando o
 * si è piantato.
 */

import { useEffect, useRef } from 'react';

import type { AgentStep } from '../scaffold';

import styles from './MessageList.module.css';
import { PatchDiff } from './PatchDiff';
import type { ChatMessage } from './types';

interface Props {
  messages: ChatMessage[];
  busy: boolean;
  liveSteps: AgentStep[];
  onApply: (messageId: string) => void;
  onDismiss: (messageId: string) => void;
}

export function MessageList({ messages, busy, liveSteps, onApply, onDismiss }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, liveSteps]);

  return (
    <div className={styles.root}>
      {messages.length === 0 && !busy && (
        <div className={styles.empty}>
          <p>Descrivi cosa deve fare il workflow, e lo costruisco.</p>
          <p className={styles.emptyHint}>
            Se ce n’è già uno aperto, posso modificarlo: «aggiungi un controllo prima dell’invio»,
            «manda anche su Telegram», «togli il passaggio dal database».
          </p>
        </div>
      )}

      {messages.map((m) => (
        <article key={m.id} className={styles.message} data-role={m.role}>
          <div className={styles.bubble}>
            {m.text && <p className={styles.text}>{m.text}</p>}
            {m.error && <pre className={styles.error}>{m.error}</pre>}
            {m.steps && m.steps.length > 0 && <StepTrace steps={m.steps} />}
          </div>

          {m.patch && (
            <PatchDiff
              patch={m.patch}
              {...(m.applied ? { applied: true } : {})}
              onApply={() => {
                onApply(m.id);
              }}
              onDismiss={() => {
                onDismiss(m.id);
              }}
            />
          )}
        </article>
      ))}

      {busy && (
        <article className={styles.message} data-role="assistant">
          <div className={styles.bubble}>
            <p className={styles.working}>
              Sto costruendo
              <span className={styles.dots} aria-hidden="true" />
            </p>
            {liveSteps.length > 0 && <StepTrace steps={liveSteps.slice(-6)} live />}
          </div>
        </article>
      )}

      <div ref={endRef} />
    </div>
  );
}

/** I passi dell'agente, in una riga ciascuno. Chiusi di default quando sono
 *  finiti: interessano mentre succedono, non dopo. */
function StepTrace({ steps, live }: { steps: AgentStep[]; live?: boolean }) {
  const list = (
    <ol className={styles.steps}>
      {steps.map((s) => (
        <li key={s.step} className={styles.step}>
          <code>{s.tool}</code>
          <span className={styles.stepArgs}>{describeArgs(s)}</span>
        </li>
      ))}
    </ol>
  );

  if (live) return list;

  return (
    <details className={styles.trace}>
      <summary className={styles.traceSummary}>
        {steps.length} {steps.length === 1 ? 'passo' : 'passi'}
      </summary>
      {list}
    </details>
  );
}

/** Il riassunto di un passo: cosa ha toccato, non tutto il JSON. */
function describeArgs(step: AgentStep): string {
  const a = step.args;
  const from = typeof a.from === 'string' ? a.from : '';
  const to = typeof a.to === 'string' ? a.to : '';
  if (from && to) return `${from} → ${to}`;
  for (const key of ['defId', 'nodeId', 'query', 'id']) {
    const v = a[key];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}
