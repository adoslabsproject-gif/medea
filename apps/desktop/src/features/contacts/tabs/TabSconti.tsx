import { useEffect, useState } from 'react';

import { mailApi } from '../../mail/api';
import type {
  BrandRow,
  CategoryRow,
  CustomerDiscountRow,
  OrganizationDetail,
} from '../../mail/types';

import styles from './shared.module.css';
import own from './TabSconti.module.css';

interface Props {
  partner: OrganizationDetail;
  brands: BrandRow[];
  categories: CategoryRow[];
}

interface DraftRow {
  id: number | null;
  categoryId: number | null;
  brandId: number | null;
  discountPct: number;
  notes: string;
}

const NEW_DRAFT: DraftRow = {
  id: null,
  categoryId: null,
  brandId: null,
  discountPct: 10,
  notes: '',
};

export function TabSconti({ partner, brands, categories }: Props) {
  const [rows, setRows] = useState<CustomerDiscountRow[]>([]);
  const [draft, setDraft] = useState<DraftRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Solo le categorie di livello 1 (parent_id NULL).
  const rootCategories = categories.filter((c) => c.parentId === null);

  async function refresh() {
    try {
      const r = await mailApi.db.listCustomerDiscounts(partner.id);
      setRows(r);
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void refresh();
  }, [partner.id]);

  async function save() {
    if (!draft) return;
    setError(null);
    try {
      await mailApi.db.customerDiscountUpsert({
        ...(draft.id ? { id: draft.id } : {}),
        customerId: partner.id,
        categoryId: draft.categoryId,
        brandId: draft.brandId,
        discountPct: draft.discountPct,
        notes: draft.notes || null,
      });
      setDraft(null);
      void refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function remove(id: number) {
    await mailApi.db.customerDiscountDelete(id);
    void refresh();
  }

  return (
    <div>
      <div className={own.intro}>
        <p>
          Sconti applicati ai listini per <strong>{partner.displayName ?? partner.domain}</strong>.
          La regola più specifica vince:
          <code className={own.code}>override</code> →
          <code className={own.code}>cat + marchio</code> →
          <code className={own.code}>categoria</code> →<code className={own.code}>marchio</code> →
          <code className={own.code}>globale</code> → listino base.
        </p>
      </div>

      <div className={styles.toolbar}>
        <span className={own.summary}>
          {rows.length} regol{rows.length === 1 ? 'a' : 'e'} attiv{rows.length === 1 ? 'a' : 'e'}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className={styles.smallBtn}
          onClick={() => {
            setDraft({ ...NEW_DRAFT });
          }}
        >
          ＋ Nuova regola
        </button>
      </div>

      {rows.length === 0 && !draft && (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>🎯</div>
          Nessuna scontistica impostata.
          <br />
          Aggiungi una regola per categoria, marchio, o entrambi.
        </div>
      )}

      {(rows.length > 0 || draft) && (
        <table className={styles.editTable}>
          <thead>
            <tr>
              <th>Categoria</th>
              <th>Marchio</th>
              <th style={{ width: 110 }}>Sconto %</th>
              <th>Note</th>
              <th style={{ width: 120 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.categoryName ?? <em className={own.muted}>tutte</em>}</td>
                <td>{r.brandName ?? <em className={own.muted}>tutti</em>}</td>
                <td className={own.num}>{r.discountPct.toFixed(2)}%</td>
                <td className={own.muted}>{r.notes ?? '—'}</td>
                <td className={own.rowActions}>
                  <button
                    type="button"
                    className={styles.smallBtn}
                    onClick={() => {
                      setDraft({
                        id: r.id,
                        categoryId: r.categoryId,
                        brandId: r.brandId,
                        discountPct: r.discountPct,
                        notes: r.notes ?? '',
                      });
                    }}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className={`${styles.smallBtn} ${styles.smallBtnDanger}`}
                    onClick={() => void remove(r.id)}
                  >
                    🗑
                  </button>
                </td>
              </tr>
            ))}

            {draft && (
              <tr className={own.draftRow}>
                <td>
                  <select
                    className={own.select}
                    value={draft.categoryId ?? ''}
                    onChange={(e) => {
                      setDraft({
                        ...draft,
                        categoryId: e.target.value ? Number(e.target.value) : null,
                      });
                    }}
                  >
                    <option value="">— tutte le categorie —</option>
                    {rootCategories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    className={own.select}
                    value={draft.brandId ?? ''}
                    onChange={(e) => {
                      setDraft({
                        ...draft,
                        brandId: e.target.value ? Number(e.target.value) : null,
                      });
                    }}
                  >
                    <option value="">— tutti i marchi —</option>
                    {brands.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="number"
                    step={0.5}
                    min={-100}
                    max={100}
                    className={styles.numInput}
                    value={draft.discountPct}
                    onChange={(e) => {
                      setDraft({ ...draft, discountPct: Number(e.target.value) });
                    }}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    className={own.text}
                    placeholder="opzionale"
                    value={draft.notes}
                    onChange={(e) => {
                      setDraft({ ...draft, notes: e.target.value });
                    }}
                  />
                </td>
                <td className={own.rowActions}>
                  <button
                    type="button"
                    className={`${styles.smallBtn} ${own.btnPrimary}`}
                    onClick={() => void save()}
                  >
                    ✓ Salva
                  </button>
                  <button
                    type="button"
                    className={styles.smallBtn}
                    onClick={() => {
                      setDraft(null);
                    }}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {error && <div className={own.error}>❌ {error}</div>}
    </div>
  );
}
