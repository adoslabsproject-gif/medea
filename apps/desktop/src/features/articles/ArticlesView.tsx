import { Button, Dialog, Select, TextField } from '@medea/ui';
import { useCallback, useEffect, useState } from 'react';


import { mailApi } from '../mail/api';
import type { ArticleInput, DbArticleRow } from '../mail/api';

import styles from './ArticlesView.module.css';

const EMPTY: ArticleInput = {
  code: '',
  description: '',
  unit: 'pz',
  categoryId: null,
  brandId: null,
  purchasePrice: null,
  salePrice: null,
  currency: 'EUR',
  boxQuantity: null,
  countryOfOrigin: null,
  hsCode: null,
  vatPercent: 22,
  notes: '',
  isActive: true,
};

export function ArticlesView() {
  const [items, setItems] = useState<DbArticleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ArticleInput>(EMPTY);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirmingBulk, setConfirmingBulk] = useState(false);

  function toggleSelect(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }
  async function bulkDelete() {
    if (selected.size === 0) return;
    if (!confirmingBulk) {
      setConfirmingBulk(true);
      setTimeout(() => { setConfirmingBulk(false); }, 4000);
      return;
    }
    setConfirmingBulk(false);
    try {
      await mailApi.db.bulkDeleteArticles(Array.from(selected));
      setSelected(new Set());
      await reload();
    } catch (e) { setError(String(e)); }
  }

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await mailApi.db.listArticles(2000, 0);
      setItems(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  function openNew() {
    setEditing({ ...EMPTY });
    setEditorOpen(true);
  }
  function openEdit(a: DbArticleRow) {
    setEditing({
      id: a.id,
      code: a.code,
      description: a.description,
      unit: a.unit,
      vatPercent: a.vatPercent,
      notes: a.notes,
      isActive: a.isActive,
      brandId: a.brandId,
      categoryId: a.categoryId,
      purchasePrice: a.purchasePrice,
      salePrice: a.salePrice,
      currency: a.currency,
      boxQuantity: a.boxQuantity,
      countryOfOrigin: a.countryOfOrigin,
      hsCode: a.hsCode,
    });
    setEditorOpen(true);
  }
  async function save() {
    setError(null);
    if (!editing.code.trim() || !editing.description.trim()) {
      setError('Codice e descrizione sono obbligatori.');
      return;
    }
    try {
      await mailApi.db.articleUpsert(editing);
      setEditorOpen(false);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }
  async function remove(id: number) {
    if (!window.confirm('Eliminare definitivamente questo articolo?')) return;
    try {
      await mailApi.db.articleDelete(id);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  const filtered = items.filter((a) => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    return [a.code, a.description, a.categoryName, a.brandName, a.unit].some((v) => (v ?? '').toLowerCase().includes(q));
  });

  return (
    <main className={styles.root}>
      <header className={styles.head}>
        <div className={styles.titleGroup}>
          <h1 className={styles.title}>📦 Articoli</h1>
          <p className={styles.subtitle}>
            Anagrafica unica articoli — codice, descrizione, prezzo base, IVA. Usata da tutti i listini.
          </p>
        </div>
        <div className={styles.actions}>
          <TextField
            placeholder="🔍 Filtra per codice / descrizione / categoria…"
            value={filter}
            onChange={(e) => { setFilter(e.target.value); }}
            size="sm"
          />
          <Button variant="solid" onClick={openNew}>+ Nuovo articolo</Button>
        </div>
      </header>

      {error && (
        <div className={styles.error}>
          {error}
          <button type="button" onClick={() => { setError(null); }}>✕</button>
        </div>
      )}

      <div className={styles.body}>
        {loading && <p className={styles.empty}>Carico…</p>}
        {!loading && filtered.length === 0 && (
          <div className={styles.emptyCard}>
            <div className={styles.emptyGlyph}>📦</div>
            <h2>Nessun articolo {filter ? 'corrisponde al filtro' : ''}</h2>
            <p>Crea il primo articolo per iniziare a costruire i tuoi listini.</p>
            <Button variant="solid" onClick={openNew}>+ Crea articolo</Button>
          </div>
        )}
        {filtered.length > 0 && (
          <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', fontSize: 12.5 }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={filtered.length > 0 && filtered.every((a) => selected.has(a.id))}
                onChange={(e) => {
                  if (e.target.checked) setSelected(new Set(filtered.map((a) => a.id)));
                  else setSelected(new Set());
                }}
              />
              Seleziona tutti i {filtered.length} visibili
            </label>
            {selected.size > 0 && (
              <>
                <span style={{ marginLeft: 'auto', fontWeight: 700, color: 'var(--color-text-primary)' }}>
                  {selected.size} selezionati
                </span>
                <Button variant="ghost" size="sm" onClick={() => { setSelected(new Set()); }}>Deseleziona</Button>
                <Button
                  variant={confirmingBulk ? 'solid' : 'soft'}
                  size="sm"
                  onClick={() => void bulkDelete()}
                >
                  {confirmingBulk ? `✓ Conferma elimina ${selected.size.toString()}` : `🗑 Elimina ${selected.size.toString()}`}
                </Button>
              </>
            )}
          </div>
          <table className={styles.table}>
            <thead>
              <tr>
                <th style={{ width: 30 }}></th>
                <th>Codice</th>
                <th>Descrizione</th>
                <th>UM</th>
                <th>Categoria</th>
                <th>Prezzo base</th>
                <th>IVA</th>
                <th>Stato</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <tr key={a.id} onDoubleClick={() => { openEdit(a); }}>
                  <td><input type="checkbox" checked={selected.has(a.id)}
                    onChange={() => { toggleSelect(a.id); }} /></td>
                  <td><code>{a.code}</code></td>
                  <td>{a.description}</td>
                  <td>{a.unit ?? '—'}</td>
                  <td>{a.categoryName ?? '—'}</td>
                  <td className={styles.numCell}>
                    {a.salePrice !== null
                      ? new Intl.NumberFormat('it-IT', { style: 'currency', currency: a.currency ?? 'EUR' }).format(a.salePrice)
                      : '—'}
                  </td>
                  <td className={styles.numCell}>{a.vatPercent !== null ? `${a.vatPercent.toFixed(0)}%` : '—'}</td>
                  <td>{a.isActive ? <span className={styles.badgeOk}>attivo</span> : <span className={styles.badgeOff}>off</span>}</td>
                  <td className={styles.rowActions}>
                    <button type="button" className={styles.rowBtn} onClick={() => { openEdit(a); }} title="Modifica">✎</button>
                    <button type="button" className={styles.rowBtn} onClick={() => void remove(a.id)} title="Elimina">🗑</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </>
        )}
      </div>

      <Dialog
        open={editorOpen}
        onClose={() => { setEditorOpen(false); }}
        title={editing.id ? 'Modifica articolo' : 'Nuovo articolo'}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setEditorOpen(false); }}>Annulla</Button>
            <Button variant="solid" onClick={() => void save()}>
              {editing.id ? 'Salva modifiche' : 'Crea articolo'}
            </Button>
          </>
        }
      >
        <div className={styles.editorGrid}>
          <TextField
            label="Codice articolo *"
            value={editing.code}
            onChange={(e) => { setEditing({ ...editing, code: e.target.value }); }}
            placeholder="Es. ART-001"
            fullWidth
          />
          <Select
            label="Unità di misura"
            value={editing.unit ?? 'pz'}
            onChange={(e) => { setEditing({ ...editing, unit: e.target.value }); }}
            items={[
              { value: 'pz', label: 'pz (pezzi)' },
              { value: 'kg', label: 'kg' },
              { value: 'g', label: 'g' },
              { value: 'm', label: 'm' },
              { value: 'cm', label: 'cm' },
              { value: 'mm', label: 'mm' },
              { value: 'm²', label: 'm² (metri quadri)' },
              { value: 'm³', label: 'm³ (metri cubi)' },
              { value: 'l', label: 'l (litri)' },
              { value: 'h', label: 'h (ore)' },
              { value: 'gg', label: 'gg (giornate)' },
            ]}
            fullWidth
          />
          <TextField
            label="Descrizione *"
            value={editing.description}
            onChange={(e) => { setEditing({ ...editing, description: e.target.value }); }}
            placeholder="Descrizione articolo"
            fullWidth
          />
          <TextField
            label="Listino vendita (€)"
            type="number"
            value={editing.salePrice?.toString() ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              setEditing({ ...editing, salePrice: v === '' ? null : Number(v) });
            }}
            placeholder="0.00"
            fullWidth
          />
          <TextField
            label="Prezzo acquisto (€)"
            type="number"
            value={editing.purchasePrice?.toString() ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              setEditing({ ...editing, purchasePrice: v === '' ? null : Number(v) });
            }}
            placeholder="0.00"
            fullWidth
          />
          <TextField
            label="IVA %"
            type="number"
            value={editing.vatPercent?.toString() ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              setEditing({ ...editing, vatPercent: v === '' ? null : Number(v) });
            }}
            placeholder="22"
            fullWidth
          />
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={editing.isActive ?? true}
              onChange={(e) => { setEditing({ ...editing, isActive: e.target.checked }); }}
            />{' '}
            Articolo attivo (visibile nei listini)
          </label>
        </div>
      </Dialog>
    </main>
  );
}
