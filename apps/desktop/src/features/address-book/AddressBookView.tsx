import { useEffect, useMemo, useState } from 'react';

import { mailApi } from '../mail/api';
import type { DbContactRow, DbOrganizationRow } from '../mail/api';

import styles from './AddressBookView.module.css';
import { ContactMessagesPanel } from './ContactMessagesPanel';

type TabId = 'orgs' | 'contacts';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('it-IT', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
    });
  } catch {
    return iso;
  }
}

function initials(name: string | null, fallback: string): string {
  const trimmed = name?.trim() ?? '';
  const s = trimmed.length > 0 ? trimmed : fallback;
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]!.charAt(0) + parts[1]!.charAt(0)).toUpperCase();
}

interface Props {
  /** Chiede alla sezione Posta di aprire un messaggio nel pannello di
   *  lettura. Assente quando la rubrica è usata da sola. */
  onOpenMessage?: (id: number) => void;
}

export function AddressBookView({ onOpenMessage }: Props = {}) {
  // Si apre sulle persone: è da lì che si parte quasi sempre — si cerca chi
  // ha scritto, non l'anagrafica dell'azienda.
  const [tab, setTab] = useState<TabId>('contacts');
  const [contacts, setContacts] = useState<DbContactRow[]>([]);
  const [orgs, setOrgs] = useState<DbOrganizationRow[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirmingBulk, setConfirmingBulk] = useState(false);
  const [contactPanel, setContactPanel] = useState<DbContactRow | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [c, o] = await Promise.all([
        mailApi.db.listContacts(5000, 0),
        mailApi.db.listOrganizations(5000, 0),
      ]);
      setContacts(c);
      setOrgs(o);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function toggleContactClient(c: DbContactRow) {
    await mailApi.db.contactSetFlags(c.id, !c.isClient, c.isSupplier);
    void refresh();
  }
  async function toggleContactSupplier(c: DbContactRow) {
    await mailApi.db.contactSetFlags(c.id, c.isClient, !c.isSupplier);
    void refresh();
  }
  async function toggleOrgClient(o: DbOrganizationRow) {
    // Optimistic update: cambio subito UI, poi sincronizzo
    const next = !o.isClient;
    setOrgs((prev) => prev.map((x) => (x.id === o.id ? { ...x, isClient: next } : x)));
    try {
      await mailApi.db.organizationSetRoles(o.id, next, o.isSupplier);
    } catch (e) {
      setError(String(e));
      void refresh();
    }
  }
  async function toggleOrgSupplier(o: DbOrganizationRow) {
    const next = !o.isSupplier;
    setOrgs((prev) => prev.map((x) => (x.id === o.id ? { ...x, isSupplier: next } : x)));
    try {
      await mailApi.db.organizationSetRoles(o.id, o.isClient, next);
    } catch (e) {
      setError(String(e));
      void refresh();
    }
  }
  async function deleteOrg(id: number) {
    if (confirmingDelete !== id) {
      setConfirmingDelete(id);
      setTimeout(() => {
        setConfirmingDelete(null);
      }, 3000);
      return;
    }
    setConfirmingDelete(null);
    try {
      await mailApi.db.organizationDelete(id);
      void refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  function toggleSelect(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }
  function selectAllVisible(ids: number[]) {
    setSelected(new Set(ids));
  }
  async function bulkDelete() {
    if (selected.size === 0) return;
    if (!confirmingBulk) {
      setConfirmingBulk(true);
      setTimeout(() => {
        setConfirmingBulk(false);
      }, 4000);
      return;
    }
    setConfirmingBulk(false);
    try {
      const n = await mailApi.db.bulkDeleteOrganizations(Array.from(selected));
      console.info(`[Medea] bulk-deleted ${n} organizations`);
      setSelected(new Set());
      void refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  const filteredContacts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (c) =>
        c.emailAddress.toLowerCase().includes(q) ||
        (c.displayName ?? '').toLowerCase().includes(q) ||
        (c.organizationDomain ?? '').toLowerCase().includes(q) ||
        (c.organizationName ?? '').toLowerCase().includes(q),
    );
  }, [contacts, search]);

  /** Contatti raggruppati per dominio, gruppi ordinati per numerosità. */
  const groupedContacts = useMemo(() => {
    const groups = new Map<
      string,
      { domain: string; orgName: string | null; items: DbContactRow[] }
    >();
    for (const c of filteredContacts) {
      const domain = c.organizationDomain ?? c.emailAddress.split('@')[1] ?? '(sconosciuto)';
      const g = groups.get(domain) ?? { domain, orgName: null, items: [] };
      if (!g.orgName && c.organizationName) g.orgName = c.organizationName;
      g.items.push(c);
      groups.set(domain, g);
    }
    return Array.from(groups.values()).sort((a, b) => b.items.length - a.items.length);
  }, [filteredContacts]);

  const filteredOrgs = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = orgs;
    if (q) {
      list = list.filter(
        (o) =>
          o.domain.toLowerCase().includes(q) ||
          (o.displayName ?? '').toLowerCase().includes(q) ||
          (o.vatNumber ?? '').toLowerCase().includes(q),
      );
    }
    return list.sort((a, b) => b.contactCount - a.contactCount);
  }, [orgs, search]);

  return (
    <div className={styles.root}>
      <header className={styles.head}>
        <div className={styles.title}>
          <span className={styles.titleIcon}>📇</span>
          <div>
            <h1 className={styles.titleText}>Rubrica indirizzi</h1>
            <p className={styles.titleHint}>
              Tutti gli indirizzi auto-aggregati dal sync IMAP. Clicca <strong>+C</strong> o
              <strong> +F</strong> per marcare come <em>Cliente</em> o <em>Fornitore</em> —
              comparirà automaticamente anche nella sezione <strong>🤝 Anagrafica</strong>.
            </p>
          </div>
        </div>
        <div className={styles.tabs} role="tablist">
          <button
            type="button"
            className={`${styles.tabBtn} ${tab === 'orgs' ? styles.tabActive : ''}`}
            onClick={() => {
              setTab('orgs');
            }}
          >
            🏢 Aziende / domini
            <span className={styles.count}>{orgs.length}</span>
          </button>
          <button
            type="button"
            className={`${styles.tabBtn} ${tab === 'contacts' ? styles.tabActive : ''}`}
            onClick={() => {
              setTab('contacts');
            }}
          >
            👤 Persone (email)
            <span className={styles.count}>{contacts.length}</span>
          </button>
        </div>
      </header>

      <div className={styles.toolbar}>
        <input
          type="search"
          className={styles.search}
          placeholder={
            tab === 'orgs'
              ? 'Cerca per dominio, ragione sociale, P.IVA…'
              : 'Cerca per email, nome, dominio…'
          }
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
        />
        <span className={styles.summary}>
          {tab === 'orgs'
            ? `${filteredOrgs.length} di ${orgs.length} aziende`
            : `${filteredContacts.length} di ${contacts.length} contatti`}
        </span>
      </div>

      {error && <div className={styles.error}>❌ {error}</div>}
      {loading && <div className={styles.empty}>Caricamento…</div>}

      {!loading && tab === 'orgs' && (
        <>
          {(selected.size > 0 || filteredOrgs.length > 0) && (
            <div className={styles.bulkBar}>
              <label>
                <input
                  type="checkbox"
                  checked={filteredOrgs.length > 0 && filteredOrgs.every((o) => selected.has(o.id))}
                  onChange={(e) => {
                    if (e.target.checked) selectAllVisible(filteredOrgs.map((o) => o.id));
                    else setSelected(new Set());
                  }}
                />{' '}
                Seleziona tutti i {filteredOrgs.length} visibili
              </label>
              {selected.size > 0 && (
                <>
                  <span className={styles.bulkInfo}>{selected.size} selezionati</span>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => {
                      setSelected(new Set());
                    }}
                  >
                    Deseleziona
                  </button>
                  <button
                    type="button"
                    className={`${styles.btn} ${confirmingBulk ? styles.btnDanger : ''}`}
                    onClick={() => void bulkDelete()}
                  >
                    {confirmingBulk
                      ? `✓ Conferma elimina ${selected.size}`
                      : `🗑 Elimina ${selected.size}`}
                  </button>
                </>
              )}
            </div>
          )}
          <div className={styles.cardGrid}>
            {filteredOrgs.length === 0 && (
              <div className={styles.empty}>Nessuna azienda trovata.</div>
            )}
            {filteredOrgs.map((o) => {
              const classified = o.isClient || o.isSupplier;
              const isSel = selected.has(o.id);
              return (
                <div
                  key={o.id}
                  className={`${styles.card} ${classified ? styles.cardClassified : ''} ${isSel ? styles.cardSelected : ''}`}
                >
                  <div className={styles.cardHead}>
                    <input
                      type="checkbox"
                      checked={isSel}
                      onChange={() => {
                        toggleSelect(o.id);
                      }}
                      style={{ marginRight: 8 }}
                    />
                    <div className={styles.avatar}>{initials(o.displayName, o.domain)}</div>
                    <div className={styles.cardTitle}>
                      <div className={styles.cardName}>{o.displayName ?? o.domain}</div>
                      <div className={styles.cardDomain}>{o.domain}</div>
                    </div>
                    <div className={styles.cardBadges}>
                      {o.isClient && (
                        <span className={`${styles.badge} ${styles.badgeClient}`}>Cliente</span>
                      )}
                      {o.isSupplier && (
                        <span className={`${styles.badge} ${styles.badgeSupplier}`}>Fornitore</span>
                      )}
                    </div>
                  </div>

                  <div className={styles.cardMeta}>
                    <span>
                      <strong>{o.contactCount}</strong> contatti
                    </span>
                    {o.vatNumber && (
                      <span>
                        P.IVA <code>{o.vatNumber}</code>
                      </span>
                    )}
                    {o.city && (
                      <span>
                        {o.city}
                        {o.countryIso2 && ` · ${o.countryIso2}`}
                      </span>
                    )}
                  </div>

                  <div className={styles.cardActions}>
                    <button
                      type="button"
                      className={`${styles.toggleBtn} ${o.isClient ? styles.toggleClient : ''}`}
                      onClick={() => void toggleOrgClient(o)}
                    >
                      {o.isClient ? '✓ Cliente' : '+ Cliente'}
                    </button>
                    <button
                      type="button"
                      className={`${styles.toggleBtn} ${o.isSupplier ? styles.toggleSupplier : ''}`}
                      onClick={() => void toggleOrgSupplier(o)}
                    >
                      {o.isSupplier ? '✓ Fornitore' : '+ Fornitore'}
                    </button>
                    <span style={{ flex: 1 }} />
                    <button
                      type="button"
                      className={`${styles.iconBtn} ${confirmingDelete === o.id ? styles.iconBtnDanger : ''}`}
                      onClick={() => void deleteOrg(o.id)}
                      title={
                        confirmingDelete === o.id
                          ? 'Clicca di nuovo per confermare'
                          : 'Elimina dalla rubrica'
                      }
                    >
                      {confirmingDelete === o.id ? '✓' : '🗑'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {!loading && tab === 'contacts' && (
        <div className={styles.groupList}>
          {groupedContacts.length === 0 && (
            <div className={styles.empty}>Nessun contatto trovato.</div>
          )}
          {groupedContacts.map((g) => (
            <details
              key={g.domain}
              className={styles.domainGroup}
              open={groupedContacts.length <= 8 || search.trim().length > 0}
            >
              <summary className={styles.domainSummary}>
                <span className={styles.domainName}>@{g.domain}</span>
                {g.orgName && <span className={styles.domainOrg}>{g.orgName}</span>}
                <span className={styles.domainCount}>
                  {g.items.length} {g.items.length === 1 ? 'contatto' : 'contatti'}
                </span>
              </summary>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Nome</th>
                      <th className={styles.right}>Msg</th>
                      <th className={styles.right}>Ultimo</th>
                      <th>Ruolo</th>
                      <th style={{ width: 210 }}>Azioni</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.items.map((c) => (
                      <tr key={c.id}>
                        <td className={styles.mono}>{c.emailAddress}</td>
                        <td>{c.displayName ?? <em className={styles.muted}>—</em>}</td>
                        <td className={styles.right}>{c.messageCount}</td>
                        <td className={styles.right}>{fmtDate(c.lastSeenAt)}</td>
                        <td>
                          {c.isClient && (
                            <span className={`${styles.badge} ${styles.badgeClient}`}>C</span>
                          )}
                          {c.isSupplier && (
                            <span className={`${styles.badge} ${styles.badgeSupplier}`}>F</span>
                          )}
                          {!c.isClient && !c.isSupplier && <em className={styles.muted}>—</em>}
                        </td>
                        <td className={styles.cellActions}>
                          <button
                            type="button"
                            className={styles.toggleBtn}
                            onClick={() => {
                              setContactPanel(c);
                            }}
                            title="Vedi le email scambiate con questo contatto"
                          >
                            ✉ Email
                          </button>
                          <button
                            type="button"
                            className={`${styles.toggleBtn} ${c.isClient ? styles.toggleClient : ''}`}
                            onClick={() => void toggleContactClient(c)}
                          >
                            {c.isClient ? '✓ C' : '+C'}
                          </button>
                          <button
                            type="button"
                            className={`${styles.toggleBtn} ${c.isSupplier ? styles.toggleSupplier : ''}`}
                            onClick={() => void toggleContactSupplier(c)}
                          >
                            {c.isSupplier ? '✓ F' : '+F'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
        </div>
      )}

      {contactPanel && (
        <ContactMessagesPanel
          {...(onOpenMessage ? { onOpenMessage } : {})}
          contact={contactPanel}
          onClose={() => {
            setContactPanel(null);
          }}
        />
      )}
    </div>
  );
}
