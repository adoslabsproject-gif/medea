import { useEffect, useMemo, useState } from 'react';

import { mailApi } from '../../mail/api';
import type { DbContactRow } from '../../mail/api';
import type { OrganizationDetail } from '../../mail/types';

import styles from './shared.module.css';
import own from './TabContatti.module.css';

interface Props { partner: OrganizationDetail; }

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('it-IT', {
    day: '2-digit', month: '2-digit', year: '2-digit',
  });
}

export function TabContatti({ partner }: Props) {
  const [allContacts, setAllContacts] = useState<DbContactRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    void mailApi.db.listContacts(2000, 0)
      .then(setAllContacts)
      .catch((e: unknown) => { setError(String(e)); })
      .finally(() => { setLoading(false); });
  }, [partner.id]);

  // Mostriamo i contatti il cui dominio email = dominio dell'azienda,
  // oppure organization_domain già linkato.
  const partnerContacts = useMemo(() => {
    const dom = partner.domain.toLowerCase();
    const isManual = dom.startsWith('manual:');
    return allContacts
      .filter((c) => {
        if (c.organizationDomain?.toLowerCase() === dom) return true;
        if (!isManual && c.emailAddress.toLowerCase().endsWith('@' + dom)) return true;
        return false;
      })
      .sort((a, b) => (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''));
  }, [allContacts, partner.domain]);

  async function setFlags(c: DbContactRow, isClient: boolean, isSupplier: boolean) {
    await mailApi.db.contactSetFlags(c.id, isClient, isSupplier);
    const refreshed = await mailApi.db.listContacts(2000, 0);
    setAllContacts(refreshed);
  }

  return (
    <div>
      <div className={own.intro}>
        <p>
          Contatti email aggregati dal sync IMAP che appartengono al dominio
          <strong> @{partner.domain}</strong>. Questo è il pezzo «rubrica» della scheda:
          ogni mittente diventa una riga automaticamente.
        </p>
      </div>

      {error && <div className={styles.empty}>❌ {error}</div>}
      {loading && <div className={styles.empty}>Caricamento…</div>}

      {!loading && partnerContacts.length === 0 && (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>📭</div>
          Nessun contatto email trovato per questo dominio.<br />
          <em style={{ fontSize: 12 }}>
            Quando arriverà una mail da chiunque @{partner.domain} comparirà qui automaticamente.
          </em>
        </div>
      )}

      {partnerContacts.length > 0 && (
        <table className={styles.editTable}>
          <thead>
            <tr>
              <th>Email</th>
              <th>Nome</th>
              <th className={own.right}>Messaggi</th>
              <th className={own.right}>Ultimo contatto</th>
              <th>Ruolo</th>
              <th style={{ width: 110 }}></th>
            </tr>
          </thead>
          <tbody>
            {partnerContacts.map((c) => (
              <tr key={c.id}>
                <td className={own.mono}>{c.emailAddress}</td>
                <td>{c.displayName ?? <em className={own.muted}>—</em>}</td>
                <td className={own.right}>{c.messageCount}</td>
                <td className={own.right}>{fmtDate(c.lastSeenAt)}</td>
                <td>
                  {c.isClient && <span className={`${own.tag} ${own.tagClient}`}>Cliente</span>}
                  {c.isSupplier && <span className={`${own.tag} ${own.tagSupplier}`}>Fornitore</span>}
                  {!c.isClient && !c.isSupplier && <em className={own.muted}>—</em>}
                </td>
                <td>
                  <button
                    type="button"
                    className={styles.smallBtn}
                    onClick={() => void setFlags(c, !c.isClient, c.isSupplier)}
                    title={c.isClient ? 'Rimuovi flag cliente' : 'Marca come cliente'}
                  >
                    {c.isClient ? '−C' : '+C'}
                  </button>
                  <button
                    type="button"
                    className={styles.smallBtn}
                    onClick={() => void setFlags(c, c.isClient, !c.isSupplier)}
                    title={c.isSupplier ? 'Rimuovi flag fornitore' : 'Marca come fornitore'}
                  >
                    {c.isSupplier ? '−F' : '+F'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
