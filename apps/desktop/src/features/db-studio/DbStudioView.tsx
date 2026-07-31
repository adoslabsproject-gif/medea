
import { Button, TextField } from '@medea/ui';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useState } from 'react';

import styles from './DbStudioView.module.css';

interface TableInfo { name: string; rowCount: number; columnCount: number; }
interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
}
interface TablePage { columns: string[]; rows: unknown[][]; total: number; }

const PAGE_SIZE = 100;

/** Mappa tabelle → icona, accent, gruppo logico */
const TABLE_META: Record<string, { icon: string; group: string; accent: string }> = {
  accounts:           { icon: '📧', group: 'Email',       accent: 'blue' },
  folders:            { icon: '📁', group: 'Email',       accent: 'blue' },
  messages:           { icon: '✉',  group: 'Email',       accent: 'blue' },
  message_labels:     { icon: '🏷', group: 'Email',       accent: 'blue' },
  attachments:        { icon: '📎', group: 'Email',       accent: 'blue' },
  contacts:           { icon: '👤', group: 'Anagrafica',  accent: 'green' },
  organizations:      { icon: '🏢', group: 'Anagrafica',  accent: 'green' },
  articles:           { icon: '📦', group: 'Commercio',   accent: 'purple' },
  article_brands:     { icon: '🏷', group: 'Commercio',   accent: 'purple' },
  article_categories: { icon: '🗂', group: 'Commercio',   accent: 'purple' },
  price_lists:        { icon: '€',  group: 'Commercio',   accent: 'purple' },
  price_list_items:   { icon: '€',  group: 'Commercio',   accent: 'purple' },
  customer_documents:        { icon: '📄', group: 'Commercio', accent: 'purple' },
  customer_document_items:   { icon: '📄', group: 'Commercio', accent: 'purple' },
  customer_category_discounts: { icon: '💸', group: 'Commercio', accent: 'purple' },
  customer_price_overrides:    { icon: '💸', group: 'Commercio', accent: 'purple' },
  reminders:          { icon: '⏰', group: 'Sistema',     accent: 'gray' },
  app_settings:       { icon: '⚙',  group: 'Sistema',     accent: 'gray' },
  schema_version:     { icon: '🔖', group: 'Sistema',     accent: 'gray' },
};

function metaFor(name: string) {
  return TABLE_META[name] ?? { icon: '🗂', group: 'Altro', accent: 'gray' };
}

function fmtNum(n: number): string {
  return new Intl.NumberFormat('it-IT').format(n);
}

type CellKind = 'null' | 'number' | 'boolean' | 'string' | 'json-array' | 'json-object' | 'date' | 'id';

function inferType(value: unknown, colName?: string): CellKind {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (colName && (colName === 'id' || colName.endsWith("_id"))) return 'id';
    return 'number';
  }
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/.test(value)) return 'date';
    const t = value.trim();
    if (t.startsWith('[') && t.endsWith(']')) return 'json-array';
    if (t.startsWith('{') && t.endsWith('}')) return 'json-object';
    return 'string';
  }
  return 'string';
}

/** Snake_case → "Title Case" con override sugli acronimi tecnici noti. */
function humanizeColumn(name: string): string {
  const overrides: Record<string, string> = {
    id: 'ID',
    sdi_code: 'SDI',
    vat_number: 'P. IVA',
    tax_code: 'C. Fiscale',
    iban: 'IBAN',
    pec: 'PEC',
    is_client: 'Cliente?',
    is_supplier: 'Fornitore?',
    is_active: 'Attivo?',
    is_seen: 'Letto?',
    is_flagged: 'Stella?',
    is_local_deleted: 'Cancellato?',
    has_attachments: 'Allegati?',
    references_json: 'References',
    to_json: 'A',
    cc_json: 'CC',
    bcc_json: 'BCC',
    body_text: 'Body',
    body_html: 'Body HTML',
    raw_eml: 'RAW EML',
    created_at: 'Creato',
    updated_at: 'Aggiornato',
    last_seen_at: 'Ultimo contatto',
    first_seen_at: 'Primo contatto',
    internal_date: 'Data',
    message_id: 'Message-ID',
    in_reply_to: 'In-Reply-To',
    thread_id: 'Thread',
    organization_id: 'Org ID',
    primary_folder_id: 'Cartella',
    contact_id: 'Contatto ID',
    customer_id: 'Cliente ID',
    supplier_id: 'Fornitore ID',
    article_id: 'Articolo ID',
    price_list_id: 'Listino ID',
    document_id: 'Doc ID',
    brand_id: 'Brand ID',
    category_id: 'Categoria ID',
    parent_id: 'Padre',
    folder_id: 'Cartella ID',
    label: 'Etichetta',
    folder_type: 'Tipo',
    folder_path: 'Path',
    domain: 'Dominio',
    display_name: 'Nome',
    organization_name: 'Organizzazione',
    organization_domain: 'Dominio',
    email_address: 'Email',
    from_address: 'Da',
    from_name: 'Da (nome)',
    subject: 'Oggetto',
    preview: 'Anteprima',
    discount_percent: 'Sconto %',
    discount_pct: 'Sconto %',
    unit_price: 'Prezzo unitario',
    total_amount: 'Totale',
    doc_type: 'Tipo',
    doc_number: 'Numero',
    doc_date: 'Data',
    purchase_price: 'Acquisto',
    sale_price: 'Vendita',
    box_quantity: 'Pz/scatola',
    country_of_origin: 'Origine',
    hs_code: 'Cod. HS',
    vat_percent: 'IVA %',
    preferred_courier: 'Corriere',
    payment_terms: 'Pagamento',
    shipping_terms: 'Porto',
    preferred_language: 'Lingua',
    bank_name: 'Banca',
    street_address: 'Indirizzo',
    postal_code: 'CAP',
    province: 'Prov.',
    country_iso2: 'Paese',
    base_price: 'Prezzo base',
    year_partition: 'Anno',
    uid_validity: 'UID validity',
    last_known_uid: 'Ultimo UID',
    last_sync_at: 'Ultimo sync',
    last_full_sync: 'Ultimo full sync',
    schema_version: 'Versione schema',
    applied_at: 'Applicata',
  };
  if (overrides[name]) return overrides[name];
  return name
    .replace(/_/g, ' ')
    .replace(/\bjson\b/i, '')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function chipClassForFluid(label: string): string {
  const k = label.toLowerCase();
  if (k.includes('acqua')) return styles.chip_acqua ?? '';
  if (k.includes('aria')) return styles.chip_aria ?? '';
  if (k.includes('olio')) return styles.chip_olio ?? '';
  if (k.includes('vapore')) return styles.chip_vapore ?? '';
  if (k.includes('gas')) return styles.chip_gas ?? '';
  return '';
}

/** Testo di un valore SQLite arbitrario: gli oggetti diventano JSON, non
 *  `[object Object]`. */
function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- qui è un primitivo
  return String(value);
}

/** Restituisce il ReactNode da renderizzare in cella + il testo "full" per modal e i metadata. */
function renderCellNode(value: unknown, colName: string): { node: React.ReactNode; full: string; kind: CellKind } {
  if (value === null || value === undefined) {
    return { node: <span className={styles.nullVal}>NULL</span>, full: '', kind: 'null' };
  }
  const kind = inferType(value, colName);
  const raw = toText(value);

  if (kind === 'json-array') {
    try {
      const arr = JSON.parse(raw) as unknown[];
      if (Array.isArray(arr) && arr.length > 0 && arr.every((x) => typeof x === 'string' || typeof x === 'number')) {
        const labels = arr.map((x) => String(x));
        return {
          node: (
            <span className={styles.chipRow}>
              {labels.slice(0, 6).map((label, idx) => (
                <span key={idx} className={`${styles.chip} ${chipClassForFluid(label)}`}>{label}</span>
              ))}
              {labels.length > 6 && (
                <span className={styles.chip} title={labels.join(', ')}>+{labels.length - 6}</span>
              )}
            </span>
          ),
          full: JSON.stringify(arr, null, 2),
          kind,
        };
      }
      return { node: <pre className={styles.jsonPretty}>{JSON.stringify(arr, null, 2)}</pre>, full: JSON.stringify(arr, null, 2), kind };
    } catch {
      return { node: raw, full: raw, kind: 'string' };
    }
  }

  if (kind === 'json-object') {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const pretty = JSON.stringify(obj, null, 2);
      return { node: <pre className={styles.jsonPretty}>{pretty}</pre>, full: pretty, kind };
    } catch {
      return { node: raw, full: raw, kind: 'string' };
    }
  }

  if (kind === 'boolean' || (kind === 'number' && (raw === '0' || raw === '1') && /^(is_|has_)/.test(colName))) {
    const truthy = raw === 'true' || raw === '1';
    return {
      node: (
        <span className={`${styles.boolBadge} ${truthy ? styles.true : styles.false}`}>
          {truthy ? '✓ Sì' : '✗ No'}
        </span>
      ),
      full: truthy ? 'true' : 'false',
      kind: 'boolean',
    };
  }

  // truncate stringhe lunghe
  const display = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
  return { node: display, full: raw, kind };
}

type EditorMode = { kind: 'insert' } | { kind: 'edit'; pkCol: string; pkVal: unknown; initial: Record<string, unknown> };

function RowEditor({
  table, schema, mode, onClose, onSaved, setError,
}: {
  table: string;
  schema: ColumnInfo[];
  mode: EditorMode;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
  setError: (s: string | null) => void;
}) {
  const isEdit = mode.kind === 'edit';
  const initial = isEdit ? mode.initial : {};
  const [values, setValues] = useState<Record<string, string | null>>(() => {
    const out: Record<string, string | null> = {};
    for (const c of schema) {
      const v = (initial)[c.name];
      out[c.name] = v === null || v === undefined ? null : toText(v);
    }
    return out;
  });
  const [busy, setBusy] = useState(false);

  function setField(name: string, raw: string | null) {
    setValues((s) => ({ ...s, [name]: raw }));
  }

  function buildPayload(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const c of schema) {
      // Skip PK auto-increment in insert (lasciala vuota → SQLite assegna)
      if (!isEdit && c.primaryKey && c.dataType.toUpperCase().includes('INT') && (values[c.name] == null || values[c.name] === '')) {
        continue;
      }
      const raw = values[c.name];
      if (raw === null || raw === undefined || raw === '') {
        if (c.nullable || !!c.defaultValue) {
          out[c.name] = null;
        } else {
          // forziamo stringa vuota per NOT NULL TEXT senza default
          if (c.dataType.toUpperCase().includes('INT') || c.dataType.toUpperCase().includes('REAL')) {
            out[c.name] = 0;
          } else {
            out[c.name] = '';
          }
        }
        continue;
      }
      const t = c.dataType.toUpperCase();
      if (t.includes('INT')) {
        const n = Number.parseInt(raw, 10);
        out[c.name] = Number.isFinite(n) ? n : null;
      } else if (t.includes('REAL') || t.includes('FLOAT') || t.includes('NUMERIC')) {
        const n = Number.parseFloat(raw.replace(',', '.'));
        out[c.name] = Number.isFinite(n) ? n : null;
      } else {
        out[c.name] = raw;
      }
    }
    return out;
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = buildPayload();
      if (isEdit) {
        await invoke('db_studio_row_update', {
          table, pkCol: mode.pkCol, pkVal: mode.pkVal, patch: payload,
        });
      } else {
        await invoke('db_studio_row_insert', { table, values: payload });
      }
      await onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.cellModalBackdrop} onClick={onClose}>
      <div
        className={styles.cellModal}
        style={{ maxWidth: 720, width: '92vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => { e.stopPropagation(); }}
      >
        <header className={styles.cellModalHead}>
          <span className={styles.cellModalCol}>
            {isEdit ? `✎ Modifica riga` : `+ Nuovo record`} — <code>{table}</code>
          </span>
          <button type="button" className={styles.cellModalClose} onClick={onClose} aria-label="Chiudi">✕</button>
        </header>
        <div className={styles.cellModalBody} style={{ overflowY: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12 }}>
            {schema.map((c) => {
              const t = c.dataType.toUpperCase();
              const isLong = t.includes('TEXT') || t.includes('JSON') || t.includes('BLOB');
              const raw = values[c.name] ?? '';
              return (
                <label key={c.name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                    {c.primaryKey && '🔑 '}
                    <code>{c.name}</code>
                    {' '}<span style={{ color: 'var(--color-text-tertiary)' }}>· {c.dataType || 'TEXT'}{c.nullable ? '' : ' · NOT NULL'}</span>
                  </span>
                  {isLong ? (
                    <textarea
                      value={raw ?? ''}
                      onChange={(e) => { setField(c.name, e.target.value); }}
                      placeholder={c.defaultValue ? `default: ${c.defaultValue}` : c.nullable ? 'NULL ammesso (lascia vuoto)' : ''}
                      style={{ fontFamily: 'monospace', fontSize: 12, padding: 8, minHeight: 64 }}
                    />
                  ) : (
                    <input
                      type={t.includes('INT') || t.includes('REAL') ? 'number' : 'text'}
                      step={t.includes('REAL') ? 'any' : undefined}
                      value={raw ?? ''}
                      onChange={(e) => { setField(c.name, e.target.value); }}
                      placeholder={c.defaultValue ? `default: ${c.defaultValue}` : c.nullable ? 'NULL ammesso (lascia vuoto)' : ''}
                      style={{ fontFamily: 'monospace', fontSize: 13, padding: '6px 8px' }}
                    />
                  )}
                </label>
              );
            })}
          </div>
        </div>
        <footer className={styles.cellModalFoot} style={{ gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>Annulla</Button>
          <Button variant="solid" onClick={() => void save()} isLoading={busy}>
            {isEdit ? '💾 Salva modifiche' : '✓ Crea record'}
          </Button>
        </footer>
      </div>
    </div>
  );
}

export function DbStudioView() {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [schema, setSchema] = useState<ColumnInfo[]>([]);
  const [page, setPage] = useState<TablePage | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cellModal, setCellModal] = useState<{ column: string; value: string; kind: string } | null>(null);
  const [tableFilter, setTableFilter] = useState('');
  const [primaryKey, setPrimaryKey] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorMode | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    void (async () => {
      try {
        const ts = await invoke<TableInfo[]>('db_studio_list_tables');
        setTables(ts);
        if (ts.length > 0 && !activeTable) setActiveTable(ts[0]!.name);
      } catch (e) { setError(String(e)); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeTable) return;
    setLoading(true);
    setPageIndex(0);
    setFilter('');
    setError(null);
    void (async () => {
      try {
        const [s, p, pk] = await Promise.all([
          invoke<ColumnInfo[]>('db_studio_describe_table', { table: activeTable }),
          invoke<TablePage>('db_studio_query_table', { table: activeTable, limit: PAGE_SIZE, offset: 0, filter: null }),
          invoke<string | null>('db_studio_primary_key', { table: activeTable }),
        ]);
        setSchema(s);
        setPage(p);
        setPrimaryKey(pk);
      } catch (e) { setError(String(e)); }
      finally { setLoading(false); }
    })();
  }, [activeTable]);

  useEffect(() => {
    if (!activeTable) return;
    setLoading(true);
    void (async () => {
      try {
        const p = await invoke<TablePage>('db_studio_query_table', {
          table: activeTable, limit: PAGE_SIZE, offset: pageIndex * PAGE_SIZE,
          filter: filter.trim() || null,
        });
        setPage(p);
      } catch (e) { setError(String(e)); }
      finally { setLoading(false); }
    })();
  }, [pageIndex, filter, activeTable, refreshTick]);

  async function refreshAll() {
    setRefreshTick((t) => t + 1);
    try {
      const ts = await invoke<TableInfo[]>('db_studio_list_tables');
      setTables(ts);
    } catch (e) { console.error(e); }
  }

  function startInsert() {
    if (!activeTable) return;
    setEditor({ kind: 'insert' });
  }

  function startEdit(rowIdx: number) {
    if (!page || !primaryKey) return;
    const pkIdx = page.columns.indexOf(primaryKey);
    if (pkIdx < 0) return;
    const pkVal = page.rows[rowIdx]?.[pkIdx];
    const initial: Record<string, unknown> = {};
    page.columns.forEach((c, i) => { initial[c] = page.rows[rowIdx]?.[i] ?? null; });
    setEditor({ kind: 'edit', pkCol: primaryKey, pkVal, initial });
  }

  async function deleteRow(rowIdx: number) {
    if (!activeTable || !page || !primaryKey) return;
    const pkIdx = page.columns.indexOf(primaryKey);
    if (pkIdx < 0) return;
    const pkVal = page.rows[rowIdx]?.[pkIdx];
    if (!window.confirm(`Eliminare la riga con ${primaryKey} = ${String(pkVal)}? Operazione irreversibile.`)) return;
    try {
      await invoke('db_studio_row_delete', { table: activeTable, pkCol: primaryKey, pkVal });
      await refreshAll();
    } catch (e) { setError(String(e)); }
  }

  /** Scarica TUTTE le righe che soddisfano il filtro, non solo la pagina a
   *  video: l'export paginato produceva file silenziosamente incompleti. */
  async function fetchAllRows(): Promise<TablePage | null> {
    if (!page || !activeTable) return null;
    const CHUNK = 1000;
    const rows: unknown[][] = [];
    for (let offset = 0; offset < page.total; offset += CHUNK) {
      const p = await invoke<TablePage>('db_studio_query_table', {
        table: activeTable, limit: CHUNK, offset,
        filter: filter.trim() || null,
      });
      rows.push(...p.rows);
      if (p.rows.length === 0) break;
    }
    return { ...page, rows };
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const all = await fetchAllRows();
      if (!all) return;
      const esc = (v: unknown) => {
        const s = toText(v);
        if (/[",\n;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
      };
      const csv = [
        all.columns.map(esc).join(','),
        ...all.rows.map((r) => r.map(esc).join(',')),
      ].join('\n');
      download(csv, `${activeTable ?? 'table'}.csv`, 'text/csv;charset=utf-8');
    } catch (e) { setError(String(e)); }
    finally { setExporting(false); }
  }

  async function exportJson() {
    setExporting(true);
    try {
      const all = await fetchAllRows();
      if (!all) return;
      const objs = all.rows.map((r) => {
        const o: Record<string, unknown> = {};
        all.columns.forEach((c, i) => { o[c] = r[i]; });
        return o;
      });
      download(JSON.stringify(objs, null, 2), `${activeTable ?? 'table'}.json`, 'application/json');
    } catch (e) { setError(String(e)); }
    finally { setExporting(false); }
  }
  function download(content: string, name: string, type: string) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const lastPage = page ? Math.max(0, Math.ceil(page.total / PAGE_SIZE) - 1) : 0;
  const totalRows = tables.reduce((s, t) => s + t.rowCount, 0);

  const groupedTables = useMemo(() => {
    const q = tableFilter.toLowerCase().trim();
    const filtered = q ? tables.filter((t) => t.name.toLowerCase().includes(q)) : tables;
    const groups = new Map<string, TableInfo[]>();
    for (const t of filtered) {
      const g = metaFor(t.name).group;
      const arr = groups.get(g) ?? [];
      arr.push(t);
      groups.set(g, arr);
    }
    const order = ['Email', 'Anagrafica', 'Commercio', 'Sistema', 'Altro'];
    return order
      .filter((g) => groups.has(g))
      .map((g) => ({ group: g, items: groups.get(g)! }));
  }, [tables, tableFilter]);

  return (
    <main className={styles.root}>
      <header className={styles.head}>
        <div className={styles.titleGroup}>
          <h1 className={styles.title}>🗄 DB Studio</h1>
          <p className={styles.subtitle}>
            Esplora, modifica, inserisci o elimina record nelle tabelle del DB Medea.
          </p>
        </div>
        <div className={styles.statsRow}>
          <div className={styles.statBadge}>
            <div className={styles.statBadgeVal}>{tables.length}</div>
            <div className={styles.statBadgeLabel}>Tabelle</div>
          </div>
          <div className={styles.statBadge}>
            <div className={styles.statBadgeVal}>{fmtNum(totalRows)}</div>
            <div className={styles.statBadgeLabel}>Righe totali</div>
          </div>
        </div>
      </header>

      <div className={styles.body}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarSearch}>
            <TextField
              placeholder="🔍 Cerca tabella…"
              value={tableFilter}
              onChange={(e) => { setTableFilter(e.target.value); }}
              size="sm"
              fullWidth
            />
          </div>
          <div className={styles.tableGroups}>
            {groupedTables.map((g) => (
              <div key={g.group} className={styles.groupBlock}>
                <div className={styles.groupTitle}>{g.group}</div>
                <ul className={styles.tableList}>
                  {g.items.map((t) => {
                    const m = metaFor(t.name);
                    return (
                      <li key={t.name}>
                        <button
                          type="button"
                          className={`${styles.tableItem} ${t.name === activeTable ? styles.tableActive : ''}`}
                          data-accent={m.accent}
                          onClick={() => { setActiveTable(t.name); }}
                        >
                          <span className={styles.tableIcon}>{m.icon}</span>
                          <span className={styles.tableInfo}>
                            <span className={styles.tableNameLine}>{t.name}</span>
                            <span className={styles.tableSub}>{t.columnCount} colonne</span>
                          </span>
                          <span className={styles.tableCount}>{fmtNum(t.rowCount)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </aside>

        <section className={styles.content}>
          {error && (
            <div className={styles.error}>
              {error}
              <button type="button" onClick={() => { setError(null); }}>✕</button>
            </div>
          )}

          {activeTable && page && (
            <>
              <div className={styles.tableHero} data-accent={metaFor(activeTable).accent}>
                <div className={styles.heroLeft}>
                  <span className={styles.heroIcon}>{metaFor(activeTable).icon}</span>
                  <div>
                    <h2 className={styles.heroTitle}>{activeTable}</h2>
                    <div className={styles.heroMeta}>
                      <span><strong>{fmtNum(page.total)}</strong> righe</span>
                      <span>·</span>
                      <span><strong>{schema.length}</strong> colonne</span>
                      <span>·</span>
                      <span>{metaFor(activeTable).group}</span>
                    </div>
                  </div>
                </div>
                <div className={styles.heroActions}>
                  <TextField
                    placeholder="🔍 Filtra in qualsiasi colonna…"
                    value={filter}
                    onChange={(e) => { setFilter(e.target.value); setPageIndex(0); }}
                    size="sm"
                  />
                  <Button variant="solid" size="sm" onClick={startInsert}>+ Nuovo record</Button>
                  <Button variant="outline" size="sm" isLoading={exporting}
                    onClick={() => { void exportCsv(); }}>⬇ CSV</Button>
                  <Button variant="outline" size="sm" isLoading={exporting}
                    onClick={() => { void exportJson(); }}>⬇ JSON</Button>
                </div>
              </div>

              <details className={styles.schemaPanel}>
                <summary>
                  <span className={styles.schemaChev}>▶</span>
                  Schema · {schema.length} colonne
                </summary>
                <div className={styles.schemaGrid}>
                  {schema.map((c) => (
                    <div key={c.name} className={styles.schemaCard}>
                      <div className={styles.schemaCardHead}>
                        <span className={styles.schemaCol}>
                          {c.primaryKey && <span className={styles.pkBadge}>🔑</span>}
                          {c.name}
                        </span>
                        <span className={`${styles.typeBadge} ${styles[`type_${c.dataType.toLowerCase().split(' ')[0]}`] ?? styles.typeOther}`}>
                          {c.dataType || 'TEXT'}
                        </span>
                      </div>
                      <div className={styles.schemaCardFoot}>
                        {!c.nullable && <span className={styles.constraintBadge}>NOT NULL</span>}
                        {c.defaultValue !== null && (
                          <span className={styles.defaultBadge}>= {c.defaultValue}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </details>

              <div className={styles.dataWrap}>
                {loading && (
                  <div className={styles.loadingOverlay}>
                    <span className={styles.spinner} /> Carico…
                  </div>
                )}
                {page.rows.length === 0 ? (
                  <div className={styles.emptyData}>
                    <div className={styles.emptyGlyph}>{metaFor(activeTable).icon}</div>
                    <h3>Nessun risultato</h3>
                    <p>
                      {filter.trim()
                        ? `Nessuna riga corrisponde a "${filter}".`
                        : 'Tabella vuota — niente da mostrare.'}
                    </p>
                  </div>
                ) : (
                  <table className={styles.dataTable}>
                    <thead>
                      <tr>
                        <th className={styles.rowNumHead}>#</th>
                        {page.columns.map((c) => (
                          <th key={c} className={styles.colHead} title={c}>
                            {humanizeColumn(c)}
                            <span className={styles.colHeadHint}>{c}</span>
                          </th>
                        ))}
                        {primaryKey && <th className={styles.rowNumHead}>Azioni</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {page.rows.map((r, i) => (
                        <tr key={i}>
                          <td className={styles.rowNum}>{pageIndex * PAGE_SIZE + i + 1}</td>
                          {r.map((cell, j) => {
                            const colName = page.columns[j] ?? '';
                            const c = renderCellNode(cell, colName);
                            const kindClass = (styles as Record<string, string | undefined>)[`cell_${c.kind.replace('-', '_')}`] ?? '';
                            return (
                              <td
                                key={j}
                                className={`${styles.cell} ${kindClass}`}
                                onClick={() => { setCellModal({ column: colName, value: c.full, kind: c.kind }); }}
                                title={c.full}
                              >
                                {c.node}
                              </td>
                            );
                          })}
                          {primaryKey && (
                            <td className={styles.rowNum}>
                              <button
                                type="button"
                                title="Modifica riga"
                                style={{ marginRight: 4, padding: '2px 6px', cursor: 'pointer' }}
                                onClick={(e) => { e.stopPropagation(); startEdit(i); }}
                              >✎</button>
                              <button
                                type="button"
                                title="Elimina riga"
                                style={{ padding: '2px 6px', cursor: 'pointer', color: 'var(--color-danger-text, var(--color-text-primary))' }}
                                onClick={(e) => { e.stopPropagation(); void deleteRow(i); }}
                              >🗑</button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className={styles.paginator}>
                <Button variant="ghost" size="sm" onClick={() => { setPageIndex(0); }} isDisabled={pageIndex === 0}>
                  ⟵⟵ Inizio
                </Button>
                <Button variant="ghost" size="sm" onClick={() => { setPageIndex(Math.max(0, pageIndex - 1)); }} isDisabled={pageIndex === 0}>
                  ⟵ Indietro
                </Button>
                <span className={styles.pageInfo}>
                  Righe <strong>{fmtNum(pageIndex * PAGE_SIZE + 1)}–{fmtNum(Math.min((pageIndex + 1) * PAGE_SIZE, page.total))}</strong> di {fmtNum(page.total)}
                </span>
                <Button variant="ghost" size="sm" onClick={() => { setPageIndex(Math.min(lastPage, pageIndex + 1)); }} isDisabled={pageIndex >= lastPage}>
                  Avanti ⟶
                </Button>
                <Button variant="ghost" size="sm" onClick={() => { setPageIndex(lastPage); }} isDisabled={pageIndex >= lastPage}>
                  Fine ⟶⟶
                </Button>
              </div>
            </>
          )}
        </section>
      </div>

      {editor && activeTable && (
        <RowEditor
          table={activeTable}
          schema={schema}
          mode={editor}
          onClose={() => { setEditor(null); }}
          onSaved={async () => { setEditor(null); await refreshAll(); }}
          setError={setError}
        />
      )}

      {cellModal && (
        <div className={styles.cellModalBackdrop} onClick={() => { setCellModal(null); }}>
          <div className={styles.cellModal} onClick={(e) => { e.stopPropagation(); }}>
            <header className={styles.cellModalHead}>
              <span className={styles.cellModalCol}>{cellModal.column}</span>
              <span className={`${styles.typeBadge} ${styles[`type_${cellModal.kind}`] ?? ''}`}>{cellModal.kind}</span>
              <button type="button" className={styles.cellModalClose} onClick={() => { setCellModal(null); }} aria-label="Chiudi">✕</button>
            </header>
            <div className={styles.cellModalBody}>
              <pre>{cellModal.value || '(vuoto)'}</pre>
            </div>
            <footer className={styles.cellModalFoot}>
              <Button
                variant="outline" size="sm"
                onClick={() => { void navigator.clipboard.writeText(cellModal.value); }}
              >
                ⎘ Copia valore
              </Button>
            </footer>
          </div>
        </div>
      )}
    </main>
  );
}
