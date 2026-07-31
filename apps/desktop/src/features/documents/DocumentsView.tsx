import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useState } from 'react';

import styles from '../shared/SectionPage.module.css';

import ownStyles from './DocumentsView.module.css';

interface DocumentRow {
  id: number;
  organizationId: number;
  organizationName: string | null;
  direction: string;
  docType: string;
  docNumber: string | null;
  docDate: string;
  totalAmount: number | null;
  currency: string;
  notes: string | null;
  attachmentFilename: string | null;
  attachmentPath: string | null;
  itemCount: number;
}

const DOC_TYPES: { value: string; label: string }[] = [
  { value: '', label: 'Tutti i tipi' },
  { value: 'quote', label: 'Preventivi' },
  { value: 'sales_order', label: 'Ordini cliente' },
  { value: 'sales_confirm', label: 'Conferme cliente' },
  { value: 'purchase_order', label: 'Ordini fornitore' },
  { value: 'purchase_confirm', label: 'Conferme fornitore' },
  { value: 'communication', label: 'Comunicazioni' },
];

const TYPE_LABEL: Record<string, string> = {
  quote: 'Preventivo',
  sales_order: 'Ordine cliente',
  sales_confirm: 'Conferma cliente',
  purchase_order: 'Ordine fornitore',
  purchase_confirm: 'Conferma fornitore',
  communication: 'Comunicazione',
};

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('it-IT', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function fmtAmount(v: number | null, currency: string): string {
  if (v === null) return '—';
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency }).format(v);
}

/** Archivio dei documenti registrati (preventivi, ordini, conferme), di ogni
 *  partner. I documenti nascono dalla scheda partner o dai tool AI. */
export function DocumentsView() {
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [docType, setDocType] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<DocumentRow[]>('db_list_all_documents', { docType: docType || null, limit: 500 })
      .then((rows) => {
        if (!cancelled) setDocs(rows);
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
  }, [docType]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter(
      (d) =>
        (d.organizationName ?? '').toLowerCase().includes(q) ||
        (d.docNumber ?? '').toLowerCase().includes(q) ||
        (d.notes ?? '').toLowerCase().includes(q),
    );
  }, [docs, search]);

  const total = useMemo(() => filtered.reduce((s, d) => s + (d.totalAmount ?? 0), 0), [filtered]);

  async function openAttachment(path: string) {
    try {
      await invoke('open_path_in_default_app', { path });
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <main className={styles.root}>
      <header className={styles.head}>
        <div className={styles.titleGroup}>
          <h1 className={styles.title}>Documenti</h1>
          <p className={styles.subtitle}>
            Preventivi, ordini e conferme registrati — creati dalla scheda di un partner o
            dall&apos;assistente AI.
          </p>
        </div>
      </header>

      <div className={ownStyles.toolbar}>
        <select
          className={ownStyles.select}
          value={docType}
          onChange={(e) => {
            setDocType(e.target.value);
          }}
          aria-label="Tipo documento"
        >
          {DOC_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <input
          type="search"
          className={ownStyles.search}
          placeholder="Cerca per partner, numero o note…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
        />
        <span className={ownStyles.summary}>
          {filtered.length} document{filtered.length === 1 ? 'o' : 'i'} · totale{' '}
          {fmtAmount(total, 'EUR')}
        </span>
      </div>

      <div className={styles.body}>
        {error && <div className={ownStyles.error}>❌ {error}</div>}
        {loading && <p className={styles.empty}>Caricamento…</p>}
        {!loading && filtered.length === 0 && (
          <p className={styles.empty}>
            Nessun documento archiviato.
            <br />I documenti si creano dalla scheda di un cliente/fornitore (tab «Documenti»)
            oppure chiedendo all&apos;assistente AI di registrare un preventivo o un ordine.
          </p>
        )}
        {!loading && filtered.length > 0 && (
          <div className={ownStyles.tableWrap}>
            <table className={ownStyles.table}>
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Tipo</th>
                  <th>Numero</th>
                  <th>Partner</th>
                  <th className={ownStyles.right}>Righe</th>
                  <th className={ownStyles.right}>Totale</th>
                  <th>Allegato</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((d) => (
                  <tr key={d.id}>
                    <td>{fmtDate(d.docDate)}</td>
                    <td>
                      <span className={ownStyles.badge}>{TYPE_LABEL[d.docType] ?? d.docType}</span>
                      {d.direction === 'incoming' ? ' ↓' : ' ↑'}
                    </td>
                    <td className={ownStyles.mono}>{d.docNumber ?? '—'}</td>
                    <td>{d.organizationName ?? `#${d.organizationId}`}</td>
                    <td className={ownStyles.right}>{d.itemCount}</td>
                    <td className={ownStyles.right}>{fmtAmount(d.totalAmount, d.currency)}</td>
                    <td>
                      {d.attachmentPath ? (
                        <button
                          type="button"
                          className={ownStyles.linkBtn}
                          onClick={() => {
                            void openAttachment(d.attachmentPath ?? '');
                          }}
                        >
                          📎 {d.attachmentFilename ?? 'apri'}
                        </button>
                      ) : (
                        <span className={ownStyles.muted}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
