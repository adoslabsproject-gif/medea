import { useEffect, useMemo, useRef, useState } from 'react';

import type { DbListedMessage } from '../api';
import { folderLabel } from '../folders/folder-label';

import styles from './MessageList.module.css';

type SortKey = 'date' | 'from' | 'subject' | 'size';
type SortDir = 'asc' | 'desc';

interface Props {
  folder: string;
  folderAttributes?: string[];
  messages: DbListedMessage[];
  loading: boolean;
  activeId: number | null;
  filterText: string;
  onSelect: (id: number) => void;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  if (sameYear) {
    return new Intl.DateTimeFormat('it-IT', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d);
  }
  return new Intl.DateTimeFormat('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes.toString()} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fmtTo(toJson: string): string {
  try {
    const arr = JSON.parse(toJson) as ({ address?: string } | string)[];
    return arr
      .map((x) => (typeof x === 'string' ? x : (x.address ?? '')))
      .filter(Boolean)
      .join(', ');
  } catch {
    return '';
  }
}

/**
 * Raggruppa i messaggi per «epoca» relativa rispetto ad oggi.
 * Outlook-style: Oggi, Ieri, Questa settimana, Questo mese, <Mese di YYYY>.
 */
function groupKey(iso: string | null, now: Date): { key: string; label: string; order: number } {
  if (!iso) return { key: 'none', label: 'Senza data', order: 9999 };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { key: 'none', label: 'Senza data', order: 9999 };

  const startOfDay = (x: Date) => {
    const y = new Date(x);
    y.setHours(0, 0, 0, 0);
    return y;
  };
  const today = startOfDay(now);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const startOfWeek = new Date(today);
  const dow = today.getDay() === 0 ? 6 : today.getDay() - 1; // lunedì = 0
  startOfWeek.setDate(today.getDate() - dow);
  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  const dDay = startOfDay(d);

  if (dDay.getTime() === today.getTime()) return { key: 'today', label: 'Oggi', order: 0 };
  if (dDay.getTime() === yesterday.getTime()) return { key: 'yesterday', label: 'Ieri', order: 1 };
  if (dDay >= startOfWeek) return { key: 'thisWeek', label: 'Questa settimana', order: 2 };
  if (dDay >= startOfMonth) return { key: 'thisMonth', label: 'Questo mese', order: 3 };

  // <Mese YYYY> con ordine decrescente (più recente in alto)
  const year = d.getFullYear();
  const month = d.getMonth();
  const monthName = new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric' }).format(d);
  const monthCap = monthName.charAt(0).toUpperCase() + monthName.slice(1);
  // order: più recente prima — usa -timestamp truncato a mese
  return {
    key: `${year.toString()}-${month.toString().padStart(2, '0')}`,
    label: monthCap,
    order: 4 + (10000 - year) * 12 + (11 - month),
  };
}

function sortMessages(messages: DbListedMessage[], key: SortKey, dir: SortDir): DbListedMessage[] {
  const sign = dir === 'asc' ? 1 : -1;
  const copy = [...messages];
  copy.sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case 'date':
        cmp = (a.internalDate ?? '').localeCompare(b.internalDate ?? '');
        break;
      case 'from':
        cmp = (a.fromName ?? a.fromAddress ?? '').localeCompare(b.fromName ?? b.fromAddress ?? '');
        break;
      case 'subject':
        cmp = (a.subject ?? '').localeCompare(b.subject ?? '');
        break;
      case 'size':
        cmp = a.size - b.size;
        break;
    }
    return cmp * sign;
  });
  return copy;
}

export function MessageList({
  folder,
  folderAttributes,
  messages,
  loading,
  activeId,
  filterText,
  onSelect,
}: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const activeRowRef = useRef<HTMLTableRowElement | null>(null);

  useEffect(() => {
    if (activeId !== null && activeRowRef.current) {
      activeRowRef.current.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
  }, [activeId]);

  const filtered = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return messages;
    return messages.filter((m) => {
      const haystack = [m.subject, m.fromName, m.fromAddress, m.preview, fmtTo(m.toJson)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [messages, filterText]);

  const sorted = useMemo(
    () => sortMessages(filtered, sortKey, sortDir),
    [filtered, sortKey, sortDir],
  );

  // Raggruppamento solo se sort = date desc (il modo "naturale")
  const groups = useMemo(() => {
    if (sortKey !== 'date' || sortDir !== 'desc') {
      return [{ key: 'all', label: '', order: 0, items: sorted }];
    }
    const now = new Date();
    const buckets = new Map<string, { label: string; order: number; items: DbListedMessage[] }>();
    for (const m of sorted) {
      const g = groupKey(m.internalDate, now);
      let b = buckets.get(g.key);
      if (!b) {
        b = { label: g.label, order: g.order, items: [] };
        buckets.set(g.key, b);
      }
      b.items.push(m);
    }
    return Array.from(buckets.entries())
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => a.order - b.order);
  }, [sorted, sortKey, sortDir]);

  function clickHeader(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'date' || key === 'size' ? 'desc' : 'asc');
    }
  }

  const sortIndicator = (key: SortKey) =>
    sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const label = folderLabel(folder, folderAttributes);

  return (
    <div className={styles.root}>
      <header className={styles.head}>
        <div className={styles.folderName}>{label}</div>
        <span className={styles.counter}>
          {messages.length} messaggi · {filtered.length} visibili
        </span>
      </header>

      <div className={styles.tableWrap} role="region" aria-label={`Messaggi in ${label}`}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.colAtt} aria-label="Allegato">
                📎
              </th>
              <th
                className={`${styles.colFrom} ${styles.sortable}`}
                onClick={() => {
                  clickHeader('from');
                }}
              >
                Da{sortIndicator('from')}
              </th>
              <th className={styles.colTo}>A</th>
              <th
                className={`${styles.colSubj} ${styles.sortable}`}
                onClick={() => {
                  clickHeader('subject');
                }}
              >
                Oggetto{sortIndicator('subject')}
              </th>
              <th
                className={`${styles.colDate} ${styles.sortable}`}
                onClick={() => {
                  clickHeader('date');
                }}
              >
                Data{sortIndicator('date')}
              </th>
              <th
                className={`${styles.colSize} ${styles.sortable}`}
                onClick={() => {
                  clickHeader('size');
                }}
              >
                Dim.{sortIndicator('size')}
              </th>
              <th className={styles.colFolder}>Cartella</th>
            </tr>
          </thead>
          <tbody>
            {loading && messages.length === 0 && (
              <tr>
                <td colSpan={7} className={styles.placeholder}>
                  <span className={styles.spinner} aria-hidden /> Carico dal DB locale…
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={7} className={styles.placeholder}>
                  {messages.length === 0
                    ? 'Cartella vuota nel DB. Auto-sync in corso o clicca "Invia/Ricevi".'
                    : 'Nessun messaggio corrisponde al filtro.'}
                </td>
              </tr>
            )}
            {groups.map((g) => (
              <GroupRows
                key={g.key}
                label={g.label}
                items={g.items}
                activeId={activeId}
                activeRef={activeRowRef}
                onSelect={onSelect}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GroupRows({
  label,
  items,
  activeId,
  activeRef,
  onSelect,
}: {
  label: string;
  items: DbListedMessage[];
  activeId: number | null;
  activeRef: React.RefObject<HTMLTableRowElement | null>;
  onSelect: (id: number) => void;
}) {
  return (
    <>
      {label && (
        <tr className={styles.groupRow}>
          <td colSpan={7}>
            <span className={styles.groupLabel}>{label}</span>
            <span className={styles.groupCount}>{items.length}</span>
          </td>
        </tr>
      )}
      {items.map((m) => {
        const date = fmtDate(m.internalDate);
        const isActive = m.id === activeId;
        return (
          <tr
            key={m.id}
            ref={isActive ? activeRef : undefined}
            className={`${isActive ? styles.active : ''} ${!m.isSeen ? styles.unread : ''}`}
            onClick={() => {
              onSelect(m.id);
            }}
            onContextMenu={(e) => {
              // Sopprimi il menu di sistema WebView; il menu app contestuale
              // verrà aggiunto come componente custom (TODO).
              e.preventDefault();
              onSelect(m.id);
            }}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(m.id);
              }
            }}
          >
            <td className={styles.colAtt}>{m.hasAttachments ? '📎' : ''}</td>
            <td className={styles.colFrom} title={m.fromAddress ?? ''}>
              {m.fromName ?? m.fromAddress ?? ''}
            </td>
            <td className={styles.colTo} title={fmtTo(m.toJson)}>
              {fmtTo(m.toJson)}
            </td>
            <td className={styles.colSubj} title={m.subject ?? ''}>
              {m.subject ?? '(senza oggetto)'}
            </td>
            <td className={styles.colDate}>{date}</td>
            <td className={styles.colSize}>{fmtSize(m.size)}</td>
            <td className={styles.colFolder} title={m.folderPath ?? ''}>
              {m.folderPath ?? ''}
            </td>
          </tr>
        );
      })}
    </>
  );
}
