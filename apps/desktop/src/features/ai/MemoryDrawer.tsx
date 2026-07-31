import { useEffect, useRef, useState } from 'react';

import styles from './MemoryDrawer.module.css';
import type { Memory } from './store/memory';
import {
  addMemory, deleteMemory, listMemories, updateMemory,
} from './store/memory';


interface Props {
  open: boolean;
  onClose: () => void;
}

export function MemoryDrawer({ open, onClose }: Props) {
  const [items, setItems] = useState<Memory[]>([]);
  const [draft, setDraft] = useState('');
  const [draftImportance, setDraftImportance] = useState<Memory['importance']>('normal');
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);
  const confirmTimerRef = useRef<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingText, setEditingText] = useState('');

  function refresh() { void listMemories().then(setItems); }

  useEffect(() => { if (open) refresh(); }, [open]);

  useEffect(() => () => {
    if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
  }, []);

  if (!open) return null;

  function handleAdd() {
    const t = draft.trim();
    if (!t) return;
    void addMemory(t, 'manual', draftImportance).then(refresh);
    setDraft('');
    setDraftImportance('normal');
  }

  function handleDelete(id: number) {
    if (confirmingDelete === id) {
      if (confirmTimerRef.current !== null) {
        window.clearTimeout(confirmTimerRef.current);
        confirmTimerRef.current = null;
      }
      setConfirmingDelete(null);
      void deleteMemory(id).then(refresh);
      return;
    }
    setConfirmingDelete(id);
    if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = window.setTimeout(() => {
      setConfirmingDelete(null);
      confirmTimerRef.current = null;
    }, 3000);
  }

  function startEdit(id: number, current: string) {
    setEditingId(id);
    setEditingText(current);
  }
  function commitEdit() {
    if (!editingId) return;
    const t = editingText.trim();
    if (t) void updateMemory(editingId, { text: t }).then(refresh);
    setEditingId(null);
    setEditingText('');
  }
  function cancelEdit() {
    setEditingId(null);
    setEditingText('');
  }

  function handleImportance(id: number, imp: Memory['importance']) {
    void updateMemory(id, { importance: imp }).then(refresh);
  }

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => { e.stopPropagation(); }}>
        <header className={styles.head}>
          <div className={styles.title}>
            <span className={styles.titleIcon}>🧠</span>
            <div>
              <div className={styles.titleText}>Memoria persistente</div>
              <div className={styles.titleHint}>
                {items.length} memori{items.length === 1 ? 'a' : 'e'} · valide tra tutte le conversazioni
              </div>
            </div>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Chiudi">✕</button>
        </header>

        <div className={styles.composer}>
          <textarea
            className={styles.input}
            placeholder='Aggiungi una memoria… es. "il cliente ARIFIN preferisce risposte in italiano sintetiche"'
            value={draft}
            onChange={(e) => { setDraft(e.target.value); }}
            rows={2}
          />
          <div className={styles.composerRow}>
            <select
              className={styles.importanceSelect}
              value={draftImportance}
              onChange={(e) => { setDraftImportance(e.target.value as Memory['importance']); }}
            >
              <option value="low">· Bassa</option>
              <option value="normal">Normale</option>
              <option value="high">⚠️ Alta priorità</option>
            </select>
            <button type="button" className={styles.addBtn} onClick={handleAdd} disabled={!draft.trim()}>
              Salva memoria
            </button>
          </div>
        </div>

        <div className={styles.list}>
          {items.length === 0 && (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>🧠</div>
              <div className={styles.emptyText}>
                Nessuna memoria salvata.<br />
                Le memorie vengono incluse nel contesto di <strong>ogni</strong> conversazione,
                così l'AI ricorda fatti durevoli (preferenze cliente, accordi, regole).
              </div>
            </div>
          )}
          {items.map((m) => (
            <div key={m.id} className={`${styles.card} ${styles[`imp_${m.importance}`] ?? ''}`}>
              <div className={styles.cardBody}>
                {editingId === m.id ? (
                  <textarea
                    autoFocus
                    className={styles.editInput}
                    value={editingText}
                    onChange={(e) => { setEditingText(e.target.value); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(); }
                      if (e.key === 'Escape') cancelEdit();
                    }}
                    onBlur={commitEdit}
                  />
                ) : (
                  <div className={styles.cardText}>{m.text}</div>
                )}
                <div className={styles.cardMeta}>
                  {m.source === 'manual' && '✎ manuale'}
                  {m.source === 'assistant' && '✨ salvata dall\'AI'}
                  {' · '}
                  {new Date(m.createdAt).toLocaleString('it-IT', {
                    day: '2-digit', month: '2-digit', year: '2-digit',
                    hour: '2-digit', minute: '2-digit',
                  })}
                </div>
              </div>
              <div className={styles.cardActions}>
                <select
                  className={styles.priorityPicker}
                  value={m.importance}
                  onChange={(e) => { handleImportance(m.id, e.target.value as Memory['importance']); }}
                  title="Priorità"
                >
                  <option value="low">·</option>
                  <option value="normal">●</option>
                  <option value="high">⚠️</option>
                </select>
                <button type="button" className={styles.iconBtn} onClick={() => { startEdit(m.id, m.text); }} title="Modifica">✎</button>
                <button
                  type="button"
                  className={`${styles.iconBtn} ${confirmingDelete === m.id ? styles.iconBtnDanger : ''}`}
                  onClick={() => { handleDelete(m.id); }}
                  title={confirmingDelete === m.id ? 'Clicca di nuovo per confermare' : 'Elimina'}
                >
                  {confirmingDelete === m.id ? '✓' : '🗑'}
                </button>
              </div>
            </div>
          ))}
        </div>

        <footer className={styles.foot}>
          <div className={styles.footHint}>
            💡 L'AI può scrivere <code>[[MEMORIZZA: …]]</code> nelle risposte per salvare automaticamente fatti importanti.
          </div>
        </footer>
      </div>
    </div>
  );
}
