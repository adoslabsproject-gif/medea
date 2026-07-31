import { useEffect, useState } from 'react';

import { mailApi } from '../../mail/api';
import type { DbListedMessage } from '../../mail/api';
import { useAccountStore } from '../../mail/store/account-store';
import type { OrganizationDetail } from '../../mail/types';

import styles from './shared.module.css';
import own from './TabComunicazioni.module.css';

interface Props {
  partner: OrganizationDetail;
}

function fmtDate(iso: string | null): string {
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

export function TabComunicazioni({ partner }: Props) {
  const accountStore = useAccountStore();
  const accountId = accountStore.active?.id ?? null;
  const [messages, setMessages] = useState<DbListedMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const dom = partner.domain;
  const isManualDomain = dom.startsWith('manual:');

  useEffect(() => {
    if (!accountId || isManualDomain) {
      setMessages([]);
      return;
    }
    setLoading(true);
    setError(null);
    void mailApi.db
      .listMessagesForDomain(accountId, dom, 500)
      .then(setMessages)
      .catch((e: unknown) => {
        setError(String(e));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [accountId, dom, isManualDomain]);

  const filtered = messages.filter((m) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      (m.subject ?? '').toLowerCase().includes(q) ||
      (m.fromAddress ?? '').toLowerCase().includes(q) ||
      (m.fromName ?? '').toLowerCase().includes(q) ||
      (m.preview ?? '').toLowerCase().includes(q)
    );
  });

  if (isManualDomain) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyIcon}>📭</div>
        Questa anagrafica è stata creata manualmente, senza un dominio email valido.
        <br />
        <em style={{ fontSize: 12 }}>
          Per vedere le email collegate aggiungi un'email ufficio nella tab Anagrafica (il dominio
          si deriva da lì).
        </em>
      </div>
    );
  }

  if (!accountId) {
    return (
      <div className={styles.empty}>Configura un account email per vedere le comunicazioni.</div>
    );
  }

  return (
    <div>
      <div className={own.intro}>
        <p>
          Email scambiate (in e out) con <strong>@{dom}</strong> dall'account
          <code className={own.code}>{accountStore.active?.emailAddress ?? ''}</code>. Filtra{' '}
          <code className={own.code}>from_address</code> e <code className={own.code}>to_json</code>{' '}
          del DB locale.
        </p>
      </div>

      <div className={styles.toolbar}>
        <input
          type="search"
          className={styles.toolbarSearch}
          placeholder="Cerca per oggetto, mittente, preview…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
        <span className={own.summary}>
          {filtered.length} di {messages.length}
        </span>
      </div>

      {error && <div className={own.errorBox}>❌ {error}</div>}

      {loading && <div className={styles.empty}>Caricamento…</div>}

      {!loading && messages.length === 0 && !error && (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>📨</div>
          Nessuna email trovata per <strong>@{dom}</strong> nel DB locale.
          <br />
          <em style={{ fontSize: 12 }}>
            Sincronizza più cartelle dalla view Mail per ampliare l'archivio locale.
          </em>
        </div>
      )}

      {filtered.length > 0 && (
        <table className={styles.editTable}>
          <thead>
            <tr>
              <th style={{ width: 130 }}>Data</th>
              <th style={{ width: 230 }}>Da</th>
              <th>Oggetto</th>
              <th>Preview</th>
              <th style={{ width: 70 }}>Flag</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => (
              <tr key={m.id} className={!m.isSeen ? own.unread : ''}>
                <td className={own.date}>{fmtDate(m.internalDate)}</td>
                <td className={own.from}>
                  <div className={own.fromName}>{m.fromName ?? m.fromAddress ?? '?'}</div>
                  <div className={own.fromAddr}>{m.fromAddress ?? ''}</div>
                </td>
                <td className={own.subject}>
                  {m.subject ?? <em className={own.muted}>(senza oggetto)</em>}
                </td>
                <td className={own.preview}>{m.preview ?? ''}</td>
                <td className={own.flags}>
                  {!m.isSeen && <span title="Non letta">🔵</span>}
                  {m.isFlagged && <span title="Importante">⭐</span>}
                  {m.hasAttachments && <span title="Allegati">📎</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
