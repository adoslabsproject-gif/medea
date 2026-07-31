import { useEffect, useMemo, useState } from 'react';

import { mailApi } from '../../mail/api';
import type { DbArticleRow } from '../../mail/api';
import type {
  CustomerPriceOverrideRow,
  OrganizationDetail,
  PriceResolution,
} from '../../mail/types';

import styles from './shared.module.css';
import own from './TabListino.module.css';

interface Props { partner: OrganizationDetail; }

interface DraftOverride {
  articleId: number;
  unitPrice: number;
  notes: string;
}

function fmtMoney(v: number | null | undefined, currency = 'EUR'): string {
  if (v === null || v === undefined) return '—';
  return `${v.toFixed(2)} ${currency}`;
}

export function TabListino({ partner }: Props) {
  const [articles, setArticles] = useState<DbArticleRow[]>([]);
  const [overrides, setOverrides] = useState<CustomerPriceOverrideRow[]>([]);
  const [resolvedMap, setResolvedMap] = useState<Map<string, PriceResolution>>(new Map());
  const [draft, setDraft] = useState<DraftOverride | null>(null);
  const [search, setSearch] = useState('');
  const [showOnlyOverrides, setShowOnlyOverrides] = useState(false);

  async function refresh() {
    const [arts, ovs] = await Promise.all([
      mailApi.db.listArticles(500, 0),
      mailApi.db.listCustomerPriceOverrides(partner.id),
    ]);
    setArticles(arts);
    setOverrides(ovs);
    // Risolviamo i prezzi finali per i primi N visibili (deterministico, server-side)
    const codes = arts.slice(0, 100).map((a) => a.code);
    const resolutions = await Promise.all(
      codes.map((c) => mailApi.db.resolvePrice(partner.id, c).catch(() => null)),
    );
    const m = new Map<string, PriceResolution>();
    codes.forEach((c, i) => {
      const r = resolutions[i];
      if (r) m.set(c, r);
    });
    setResolvedMap(m);
  }
  useEffect(() => { void refresh();   }, [partner.id]);

  const overrideMap = useMemo(() => {
    const m = new Map<number, CustomerPriceOverrideRow>();
    for (const o of overrides) m.set(o.articleId, o);
    return m;
  }, [overrides]);

  const visible = useMemo(() => {
    let list = articles;
    if (showOnlyOverrides) list = list.filter((a) => overrideMap.has(a.id));
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((a) =>
        a.code.toLowerCase().includes(q)
        || a.description.toLowerCase().includes(q)
        || (a.brandName ?? '').toLowerCase().includes(q));
    }
    return list;
  }, [articles, overrideMap, showOnlyOverrides, search]);

  async function saveDraft() {
    if (!draft) return;
    await mailApi.db.customerPriceOverrideUpsert({
      customerId: partner.id,
      articleId: draft.articleId,
      unitPrice: draft.unitPrice,
      notes: draft.notes || null,
    });
    setDraft(null);
    void refresh();
  }

  async function removeOverride(id: number) {
    await mailApi.db.customerPriceOverrideDelete(id);
    void refresh();
  }

  return (
    <div>
      <div className={own.intro}>
        <p>
          Listino di vendita applicato a <strong>{partner.displayName ?? partner.domain}</strong>.
          La colonna <strong>Prezzo finale</strong> è calcolata dal motore deterministico:
          override del cliente vince sempre, altrimenti si applicano gli sconti per categoria/marchio
          definiti nel tab «Sconti».
        </p>
      </div>

      <div className={styles.toolbar}>
        <input
          type="search"
          className={styles.toolbarSearch}
          placeholder="Cerca per codice, descrizione, marchio…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); }}
        />
        <label className={own.toggle}>
          <input
            type="checkbox"
            checked={showOnlyOverrides}
            onChange={(e) => { setShowOnlyOverrides(e.target.checked); }}
          />
          Solo override
        </label>
        <span className={own.summary}>
          {overrides.length} override · {visible.length} righe
        </span>
      </div>

      <table className={styles.editTable}>
        <thead>
          <tr>
            <th>Codice</th>
            <th>Descrizione</th>
            <th>Marchio</th>
            <th>Categoria</th>
            <th style={{ textAlign: 'right' }}>Listino base</th>
            <th style={{ textAlign: 'right' }}>Sconto</th>
            <th style={{ textAlign: 'right' }}>Prezzo cliente</th>
            <th style={{ width: 110 }}></th>
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 && (
            <tr><td colSpan={8} className={styles.empty}>Nessun articolo.</td></tr>
          )}
          {visible.map((a) => {
            const ov = overrideMap.get(a.id);
            const res = resolvedMap.get(a.code);
            const isOverride = res?.discountSource === 'override' || !!ov;
            const editing = draft?.articleId === a.id;
            return (
              <tr key={a.id} className={isOverride ? own.rowOverride : ''}>
                <td className={own.code}>{a.code}</td>
                <td className={own.descr}>{a.description}</td>
                <td>{a.brandName ?? <em className={own.muted}>—</em>}</td>
                <td>{a.categoryName ?? <em className={own.muted}>—</em>}</td>
                <td className={own.right}>{fmtMoney(a.salePrice, a.currency ?? 'EUR')}</td>
                <td className={own.right}>
                  {res?.discountSource ? (
                    <span className={own.discountTag}>
                      {res.discountPctApplied.toFixed(1)}% <em>{res.discountSource}</em>
                    </span>
                  ) : <em className={own.muted}>—</em>}
                </td>
                <td className={`${own.right} ${isOverride ? own.priceOverride : ''}`}>
                  {editing ? (
                    <input
                      type="number"
                      step={0.01}
                      className={styles.numInput}
                      value={draft.unitPrice}
                      onChange={(e) => { setDraft({ ...draft, unitPrice: Number(e.target.value) }); }}
                    />
                  ) : (
                    <strong>{fmtMoney(res?.finalPrice ?? null, res?.currency ?? a.currency ?? 'EUR')}</strong>
                  )}
                </td>
                <td className={own.rowActions}>
                  {editing ? (
                    <>
                      <button type="button" className={`${styles.smallBtn} ${own.btnPrimary}`} onClick={() => void saveDraft()}>✓</button>
                      <button type="button" className={styles.smallBtn} onClick={() => { setDraft(null); }}>✕</button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={styles.smallBtn}
                        title={ov ? 'Modifica override' : 'Crea override per questo cliente'}
                        onClick={() => { setDraft({
                          articleId: a.id,
                          unitPrice: ov?.unitPrice ?? (a.salePrice ?? 0),
                          notes: ov?.notes ?? '',
                        }); }}
                      >
                        {ov ? '✎' : '＋'}
                      </button>
                      {ov && (
                        <button
                          type="button"
                          className={`${styles.smallBtn} ${styles.smallBtnDanger}`}
                          onClick={() => void removeOverride(ov.id)}
                          title="Rimuovi override"
                        >🗑</button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
