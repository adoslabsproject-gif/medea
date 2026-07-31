import { useEffect, useMemo, useRef, useState } from 'react';

import styles from './ConversationsSidebar.module.css';
import type { Conversation } from './store/conversations';


interface Props {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  collapsed: boolean;
  onToggle: () => void;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  const isYest =
    d.getFullYear() === yest.getFullYear() &&
    d.getMonth() === yest.getMonth() &&
    d.getDate() === yest.getDate();
  if (isYest) return 'Ieri';
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('it-IT', sameYear
    ? { day: '2-digit', month: 'short' }
    : { day: '2-digit', month: 'short', year: '2-digit' });
}

function bucketOf(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return 'Oggi';
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  const isYest =
    d.getFullYear() === yest.getFullYear() &&
    d.getMonth() === yest.getMonth() &&
    d.getDate() === yest.getDate();
  if (isYest) return 'Ieri';
  const diff = (now.getTime() - d.getTime()) / 86_400_000;
  if (diff < 7) return 'Settimana scorsa';
  if (diff < 30) return 'Mese scorso';
  return 'Più vecchie';
}

export function ConversationsSidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onRename,
  onDelete,
  collapsed,
  onToggle,
}: Props) {
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const confirmTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
    };
  }, []);

  function askDelete(id: string) {
    if (confirmingDelete === id) {
      if (confirmTimerRef.current !== null) {
        window.clearTimeout(confirmTimerRef.current);
        confirmTimerRef.current = null;
      }
      setConfirmingDelete(null);
      onDelete(id);
      return;
    }
    setConfirmingDelete(id);
    if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = window.setTimeout(() => {
      setConfirmingDelete(null);
      confirmTimerRef.current = null;
    }, 3000);
  }

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, filter]);

  const grouped = useMemo(() => {
    const groups = new Map<string, Conversation[]>();
    for (const c of filtered) {
      const k = bucketOf(c.updatedAt);
      const arr = groups.get(k) ?? [];
      arr.push(c);
      groups.set(k, arr);
    }
    return Array.from(groups.entries());
  }, [filtered]);

  if (collapsed) {
    return (
      <div className={styles.collapsed}>
        <button
          type="button"
          className={styles.expandBtn}
          onClick={onToggle}
          title="Mostra archivio conversazioni"
          aria-label="Mostra archivio conversazioni"
        >
          ☰
        </button>
        <button
          type="button"
          className={styles.expandBtn}
          onClick={onNew}
          title="Nuova conversazione"
          aria-label="Nuova conversazione"
        >
          ＋
        </button>
      </div>
    );
  }

  return (
    <aside className={styles.sidebar}>
      <div className={styles.head}>
        <button type="button" className={styles.newBtn} onClick={onNew}>
          <span className={styles.newBtnIcon}>＋</span>
          Nuova conversazione
        </button>
        <button
          type="button"
          className={styles.collapseBtn}
          onClick={onToggle}
          title="Comprimi archivio"
          aria-label="Comprimi archivio"
        >
          ‹
        </button>
      </div>

      <div className={styles.searchWrap}>
        <input
          type="text"
          className={styles.search}
          placeholder="Cerca conversazione…"
          value={filter}
          onChange={(e) => { setFilter(e.target.value); }}
        />
      </div>

      <div className={styles.list}>
        {grouped.length === 0 && (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>💬</div>
            <div className={styles.emptyText}>
              Nessuna conversazione.<br />
              Premi <strong>Nuova conversazione</strong> per iniziare.
            </div>
          </div>
        )}
        {grouped.map(([bucket, items]) => (
          <div key={bucket} className={styles.group}>
            <div className={styles.groupTitle}>{bucket}</div>
            {items.map((c) => (
              <div
                key={c.id}
                className={`${styles.row} ${c.id === activeId ? styles.rowActive : ''}`}
                onClick={() => { onSelect(c.id); }}
              >
                {editing === c.id ? (
                  <input
                    autoFocus
                    type="text"
                    className={styles.titleInput}
                    value={draftTitle}
                    onChange={(e) => { setDraftTitle(e.target.value); }}
                    onBlur={() => {
                      if (draftTitle.trim()) onRename(c.id, draftTitle.trim());
                      setEditing(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        if (draftTitle.trim()) onRename(c.id, draftTitle.trim());
                        setEditing(null);
                      } else if (e.key === 'Escape') {
                        setEditing(null);
                      }
                    }}
                  />
                ) : (
                  <>
                    <div className={styles.rowMain}>
                      <div className={styles.rowTitle}>{c.title}</div>
                      <div className={styles.rowMeta}>
                        {c.messages.length} msg · {fmtWhen(c.updatedAt)}
                      </div>
                    </div>
                    <div className={styles.rowActions}>
                      <button
                        type="button"
                        className={styles.rowIconBtn}
                        title="Rinomina"
                        aria-label="Rinomina"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing(c.id);
                          setDraftTitle(c.title);
                        }}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className={`${styles.rowIconBtn} ${confirmingDelete === c.id ? styles.rowIconBtnDanger : ''}`}
                        title={confirmingDelete === c.id ? 'Clicca di nuovo per confermare' : 'Elimina conversazione'}
                        aria-label="Elimina"
                        onClick={(e) => {
                          e.stopPropagation();
                          askDelete(c.id);
                        }}
                      >
                        {confirmingDelete === c.id ? '✓' : '🗑'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
