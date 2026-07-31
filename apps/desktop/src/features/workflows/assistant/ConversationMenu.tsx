/**
 * Le conversazioni precedenti con l'assistente su questo workflow.
 *
 * Perché serve: il ragionamento che ha portato al workflow sta nella
 * conversazione, non nel documento. «Perché quel controllo è lì» si ritrova
 * solo qui — e a distanza di giorni è la domanda che ci si fa.
 */

import { useEffect, useRef, useState } from 'react';

import styles from './ConversationMenu.module.css';
import type { Conversation } from './conversations';

interface Props {
  conversations: readonly Conversation[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
}

function when(ts: number): string {
  const date = new Date(ts);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
}

export function ConversationMenu({ conversations, activeId, onOpen, onRemove }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (conversations.length === 0) return null;

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Conversazioni precedenti"
        aria-label="Conversazioni precedenti"
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        ⏱ {conversations.length}
      </button>

      {open && (
        <div className={styles.menu} role="menu">
          {conversations.map((c) => (
            <div key={c.id} className={styles.row} data-on={c.id === activeId ? 'true' : 'false'}>
              <button
                type="button"
                role="menuitem"
                className={styles.item}
                onClick={() => {
                  setOpen(false);
                  onOpen(c.id);
                }}
              >
                <span className={styles.title}>{c.title}</span>
                <span className={styles.meta}>
                  {when(c.updatedAt)} · {c.messages.length} messaggi
                </span>
              </button>
              <button
                type="button"
                className={styles.remove}
                title="Elimina questa conversazione"
                aria-label={`Elimina ${c.title}`}
                onClick={() => {
                  onRemove(c.id);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
