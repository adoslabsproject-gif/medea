import { useEffect, useMemo, useState } from 'react';

import { mailApi } from '../../mail/api';
import type {
  CustomerDocumentInput,
  CustomerDocumentRow,
  DocDirection,
  DocType,
  OrganizationDetail,
} from '../../mail/types';

import styles from './shared.module.css';
import own from './TabDocumenti.module.css';

interface Props { partner: OrganizationDetail; }

interface SectionMeta {
  type: DocType;
  icon: string;
  label: string;
  direction: DocDirection;
  hint: string;
}

const SECTIONS: SectionMeta[] = [
  { type: 'sales_order',      icon: '📥', label: 'Ordini cliente',              direction: 'incoming', hint: 'Ordini ricevuti dal cliente' },
  { type: 'sales_confirm',    icon: '✅', label: "Conferme d'ordine cliente",   direction: 'outgoing', hint: 'Conferme emesse al cliente' },
  { type: 'quote',            icon: '💬', label: 'Offerte',                     direction: 'outgoing', hint: 'Preventivi emessi' },
  { type: 'purchase_order',   icon: '📤', label: 'Ordini fornitore',            direction: 'outgoing', hint: 'Ordini emessi al fornitore' },
  { type: 'purchase_confirm', icon: '🔁', label: 'Conferme fornitore',          direction: 'incoming', hint: 'Conferme ricevute dal fornitore' },
  { type: 'communication',    icon: '📨', label: 'Comunicazioni rilevanti',     direction: 'incoming', hint: 'Doc generici' },
];

function fmtMoney(v: number | null, currency = 'EUR'): string {
  if (v === null) return '—';
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency }).format(v);
}

function fmtDate(iso: string): string {
  try { return new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
  catch { return iso; }
}

export function TabDocumenti({ partner }: Props) {
  const [docs, setDocs] = useState<CustomerDocumentRow[]>([]);
  const [draft, setDraft] = useState<CustomerDocumentInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);

  async function refresh() {
    setError(null);
    try {
      const r = await mailApi.db.listCustomerDocuments(partner.id);
      setDocs(r);
    } catch (e) { setError(String(e)); }
  }
  useEffect(() => { void refresh();   }, [partner.id]);

  const grouped = useMemo(() => {
    const m = new Map<DocType, CustomerDocumentRow[]>();
    for (const s of SECTIONS) m.set(s.type, []);
    for (const d of docs) {
      const arr = m.get(d.docType) ?? [];
      arr.push(d);
      m.set(d.docType, arr);
    }
    return m;
  }, [docs]);

  function openNew(meta: SectionMeta) {
    setDraft({
      organizationId: partner.id,
      direction: meta.direction,
      docType: meta.type,
      docNumber: '',
      docDate: new Date().toISOString().slice(0, 10),
      status: null,
      totalAmount: null,
      currency: 'EUR',
      messageId: null,
      attachmentFilename: null,
      attachmentPath: null,
      attachmentSha256: null,
      notes: null,
    });
  }

  function openEdit(doc: CustomerDocumentRow) {
    setDraft({
      id: doc.id,
      organizationId: doc.organizationId,
      direction: doc.direction,
      docType: doc.docType,
      docNumber: doc.docNumber,
      docDate: doc.docDate,
      status: doc.status,
      totalAmount: doc.totalAmount,
      currency: doc.currency,
      messageId: doc.messageId,
      attachmentFilename: doc.attachmentFilename,
      attachmentPath: doc.attachmentPath,
      attachmentSha256: doc.attachmentSha256,
      notes: doc.notes,
    });
  }

  async function save() {
    if (!draft) return;
    setError(null);
    try {
      await mailApi.db.customerDocumentUpsert(draft);
      setDraft(null);
      void refresh();
    } catch (e) { setError(String(e)); }
  }

  async function remove(id: number) {
    if (confirmingDelete !== id) {
      setConfirmingDelete(id);
      setTimeout(() => { setConfirmingDelete(null); }, 3000);
      return;
    }
    setConfirmingDelete(null);
    await mailApi.db.customerDocumentDelete(id);
    void refresh();
  }

  return (
    <div>
      {error && <div className={own.errorBox}>❌ {error}</div>}

      {SECTIONS.map((meta) => {
        const list = grouped.get(meta.type) ?? [];
        return (
          <section key={meta.type} className={own.section}>
            <header className={own.sectionHead}>
              <div className={own.sectionTitle}>
                <span className={own.icon}>{meta.icon}</span>
                <span className={own.label}>{meta.label}</span>
                <span className={own.count}>{list.length}</span>
              </div>
              <span className={own.hint}>{meta.hint}</span>
              <button type="button" className={styles.smallBtn} onClick={() => { openNew(meta); }}>
                ＋ Aggiungi
              </button>
            </header>

            {list.length === 0 ? (
              <div className={own.empty}>Nessun documento.</div>
            ) : (
              <table className={styles.editTable}>
                <thead>
                  <tr>
                    <th style={{ width: 100 }}>Data</th>
                    <th style={{ width: 140 }}>Numero</th>
                    <th>Stato</th>
                    <th className={own.right}>Totale</th>
                    <th>Allegato</th>
                    <th>Note</th>
                    <th style={{ width: 110 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((d) => (
                    <tr key={d.id}>
                      <td>{fmtDate(d.docDate)}</td>
                      <td className={own.mono}>{d.docNumber ?? '—'}</td>
                      <td>{d.status ?? <em className={own.muted}>—</em>}</td>
                      <td className={own.right}>{fmtMoney(d.totalAmount, d.currency)}</td>
                      <td>
                        {d.attachmentFilename ? (
                          <span title={d.attachmentPath ?? ''}>📎 {d.attachmentFilename}</span>
                        ) : <em className={own.muted}>—</em>}
                      </td>
                      <td className={own.notes}>{d.notes ?? <em className={own.muted}>—</em>}</td>
                      <td className={own.rowActions}>
                        <button type="button" className={styles.smallBtn} onClick={() => { openEdit(d); }}>✎</button>
                        <button
                          type="button"
                          className={`${styles.smallBtn} ${confirmingDelete === d.id ? own.dangerActive : styles.smallBtnDanger}`}
                          onClick={() => void remove(d.id)}
                        >{confirmingDelete === d.id ? '✓' : '🗑'}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}

      {draft && (
        <DocDialog
          draft={draft}
          setDraft={setDraft}
          onClose={() => { setDraft(null); }}
          onSave={() => void save()}
        />
      )}
    </div>
  );
}

interface DialogProps {
  draft: CustomerDocumentInput;
  setDraft: (d: CustomerDocumentInput) => void;
  onClose: () => void;
  onSave: () => void;
}

function DocDialog({ draft, setDraft, onClose, onSave }: DialogProps) {
  return (
    <div className={own.backdrop} onClick={onClose}>
      <div className={own.modal} onClick={(e) => { e.stopPropagation(); }}>
        <header className={own.modalHead}>
          <h3>{draft.id ? 'Modifica documento' : 'Nuovo documento'}</h3>
          <button type="button" className={styles.smallBtn} onClick={onClose}>✕</button>
        </header>
        <div className={own.modalBody}>
          <Row label="Tipo documento">
            <select className={own.input} value={draft.docType}
              onChange={(e) => { setDraft({ ...draft, docType: e.target.value as DocType }); }}>
              {SECTIONS.map((s) => (
                <option key={s.type} value={s.type}>{s.icon} {s.label}</option>
              ))}
            </select>
          </Row>
          <Row label="Direzione">
            <select className={own.input} value={draft.direction}
              onChange={(e) => { setDraft({ ...draft, direction: e.target.value as DocDirection }); }}>
              <option value="incoming">📥 In ingresso</option>
              <option value="outgoing">📤 In uscita</option>
            </select>
          </Row>
          <div className={own.row2}>
            <Row label="Numero documento">
              <input className={own.input} value={draft.docNumber ?? ''}
                onChange={(e) => { setDraft({ ...draft, docNumber: e.target.value || null }); }} />
            </Row>
            <Row label="Data">
              <input type="date" className={own.input} value={draft.docDate}
                onChange={(e) => { setDraft({ ...draft, docDate: e.target.value }); }} />
            </Row>
          </div>
          <div className={own.row2}>
            <Row label="Stato">
              <input className={own.input} placeholder="aperto / chiuso / evaso…" value={draft.status ?? ''}
                onChange={(e) => { setDraft({ ...draft, status: e.target.value || null }); }} />
            </Row>
            <Row label="Totale">
              <input type="number" step={0.01} className={own.input} value={draft.totalAmount?.toString() ?? ''}
                onChange={(e) => { setDraft({ ...draft, totalAmount: e.target.value === '' ? null : Number(e.target.value) }); }} />
            </Row>
          </div>
          <Row label="Allegato — nome file">
            <input className={own.input} value={draft.attachmentFilename ?? ''}
              placeholder="ordine-2026-001.pdf"
              onChange={(e) => { setDraft({ ...draft, attachmentFilename: e.target.value || null }); }} />
          </Row>
          <Row label="Allegato — percorso locale">
            <input className={own.input} value={draft.attachmentPath ?? ''}
              placeholder="es. ordine-2026-001.pdf (path assoluto auto-derivato)"
              onChange={(e) => { setDraft({ ...draft, attachmentPath: e.target.value || null }); }} />
          </Row>
          <Row label="Note">
            <textarea className={`${own.input} ${own.textarea}`} rows={3} value={draft.notes ?? ''}
              onChange={(e) => { setDraft({ ...draft, notes: e.target.value || null }); }} />
          </Row>
        </div>
        <footer className={own.modalFoot}>
          <button type="button" className={styles.smallBtn} onClick={onClose}>Annulla</button>
          <button type="button" className={`${styles.smallBtn} ${own.btnPrimary}`} onClick={onSave}>
            💾 Salva documento
          </button>
        </footer>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className={own.formRow}>
      <span className={own.formLabel}>{label}</span>
      {children}
    </label>
  );
}
