import { useEffect, useState } from 'react';

import { mailApi } from '../mail/api';
import type { DbContactRow, DbListedMessage } from '../mail/api';

import styles from './ContactMessagesPanel.module.css';

interface Props {
  contact: DbContactRow;
  onClose: () => void;
  /** Apre il messaggio nel pannello di lettura della sezione Posta. Assente
   *  quando non c'è una sezione Posta a cui passarlo. */
  onOpenMessage?: (id: number) => void;
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('it-IT', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** Drawer con tutte le email scambiate con un contatto (in/out). */
export function ContactMessagesPanel({ contact, onClose, onOpenMessage }: Props) {
  const [messages, setMessages] = useState<DbListedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    mailApi.db
      .listMessagesForAddress(contact.emailAddress, 200)
      .then((list) => {
        if (!cancelled) setMessages(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [contact.emailAddress]);

  return (
    <aside className={styles.drawer} aria-label={`Email di ${contact.emailAddress}`}>
      <header className={styles.head}>
        <div className={styles.headText}>
          <div className={styles.name}>{contact.displayName ?? contact.emailAddress}</div>
          <div className={styles.address}>{contact.emailAddress}</div>
        </div>
        <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Chiudi">
          ✕
        </button>
      </header>

      {loading && <div className={styles.empty}>Caricamento…</div>}
      {error && <div className={styles.error}>❌ {error}</div>}
      {!loading && !error && messages.length === 0 && (
        <div className={styles.empty}>Nessuna email scambiata con questo contatto.</div>
      )}

      <div className={styles.list}>
        {messages.map((m) => {
          const incoming =
            (m.fromAddress ?? '').toLowerCase() === contact.emailAddress.toLowerCase();
          return (
            <article
              key={m.id}
              className={styles.row}
              {...(onOpenMessage
                ? {
                    // Non è un `button`: dentro c'è già del testo strutturato,
                    // e un pulsante che ne contiene altro non si annuncia
                    // bene. Ruolo e tastiera restituiscono quello che serve.
                    role: 'button',
                    tabIndex: 0,
                    'data-clickable': 'true',
                    title: 'Apri nella posta',
                    onClick: () => {
                      onOpenMessage(m.id);
                    },
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpenMessage(m.id);
                      }
                    },
                  }
                : {})}
            >
              <div className={styles.rowHead}>
                <span className={incoming ? styles.dirIn : styles.dirOut}>
                  {incoming ? '↓ Ricevuta' : '↑ Inviata'}
                </span>
                <span className={styles.date}>{fmtDateTime(m.internalDate)}</span>
                {m.folderPath && <span className={styles.folder}>{m.folderPath}</span>}
              </div>
              <div className={styles.subject}>
                {!m.isSeen && <span className={styles.unreadDot} aria-label="Non letta" />}
                {m.subject ?? '(senza oggetto)'}
                {m.hasAttachments && ' 📎'}
              </div>
              {m.preview && <div className={styles.preview}>{m.preview}</div>}
            </article>
          );
        })}
      </div>
    </aside>
  );
}
