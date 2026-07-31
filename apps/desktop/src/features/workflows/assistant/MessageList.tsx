/**
 * I messaggi della conversazione.
 *
 * Mentre l'agente lavora si vedono i passi che sta compiendo — cerca il nodo,
 * lo aggiunge, lo configura — invece di una rotellina. Su un'operazione che
 * dura venti secondi la differenza fra le due cose è sapere se sta andando o
 * si è piantato.
 */

import { useEffect, useRef, useState } from 'react';

import type { AgentStep } from '../scaffold';

import styles from './MessageList.module.css';
import { PatchDiff } from './PatchDiff';
import { ToolTrace } from './ToolTrace';
import type { ChatMessage } from './types';

interface Props {
  messages: ChatMessage[];
  busy: boolean;
  liveSteps: AgentStep[];
  onApply: (messageId: string) => void;
  onDismiss: (messageId: string) => void;
  /** Corregge una richiesta già inviata e rilancia da lì. */
  onEdit: (messageId: string, text: string) => void;
}

export function MessageList({ messages, busy, liveSteps, onApply, onDismiss, onEdit }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<string | null>(null);

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
          {editing === m.id ? (
            <EditBox
              initial={m.text}
              onCancel={() => {
                setEditing(null);
              }}
              onSubmit={(text) => {
                setEditing(null);
                onEdit(m.id, text);
              }}
            />
          ) : (
            <div className={styles.bubble}>
              {m.text && <p className={styles.text}>{m.text}</p>}
              {m.error && <pre className={styles.error}>{m.error}</pre>}
              {m.steps && m.steps.length > 0 && <ToolTrace steps={m.steps} />}
              {m.role === 'user' && !busy && (
                <button
                  type="button"
                  className={styles.edit}
                  title="Correggi questa richiesta e riparti da qui"
                  onClick={() => {
                    setEditing(m.id);
                  }}
                >
                  ✎ Correggi
                </button>
              )}
            </div>
          )}

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
            {liveSteps.length > 0 && <ToolTrace steps={liveSteps.slice(-6)} live />}
          </div>
        </article>
      )}

      <div ref={endRef} />
    </div>
  );
}

/**
 * La correzione di una richiesta già inviata.
 *
 * Quello che veniva dopo rispondeva a una domanda che non è più stata fatta:
 * riscrivere qui taglia il seguito e riparte da questo punto.
 */
function EditBox({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <div className={styles.editBox}>
      <textarea
        className={styles.editInput}
        rows={3}
        autoFocus
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSubmit(text);
          }
        }}
      />
      <div className={styles.editActions}>
        <span className={styles.editHint}>
          Da qui in poi la conversazione riparte: le risposte successive vengono sostituite.
        </span>
        <button type="button" className={styles.editCancel} onClick={onCancel}>
          Annulla
        </button>
        <button
          type="button"
          className={styles.editSend}
          onClick={() => {
            onSubmit(text);
          }}
        >
          Rimanda
        </button>
      </div>
    </div>
  );
}
