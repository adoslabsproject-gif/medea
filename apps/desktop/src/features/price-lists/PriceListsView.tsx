import { Button, Dialog, Select, TextField } from '@medea/ui';
import { useCallback, useEffect, useState } from 'react';


import { mailApi } from '../mail/api';
import type {
  DbArticleRow,
  DbOrganizationRow,
  DbPriceListItemRow,
  DbPriceListRow,
  PriceListInput,
  PriceListItemInput,
} from '../mail/api';

import styles from './PriceListsView.module.css';

const EMPTY_LIST: PriceListInput = {
  name: '',
  organizationId: null,
  isDefault: false,
  validFrom: null,
  validTo: null,
  notes: null,
};

export function PriceListsView() {
  const [lists, setLists] = useState<DbPriceListRow[]>([]);
  const [orgs, setOrgs] = useState<DbOrganizationRow[]>([]);
  const [articles, setArticles] = useState<DbArticleRow[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [items, setItems] = useState<DbPriceListItemRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<PriceListInput>(EMPTY_LIST);

  const [itemEditorOpen, setItemEditorOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<PriceListItemInput | null>(null);

  const reload = useCallback(async () => {
    try {
      const [l, o, a] = await Promise.all([
        mailApi.db.listPriceLists(),
        mailApi.db.listOrganizations(500, 0),
        mailApi.db.listArticles(2000, 0),
      ]);
      setLists(l);
      setOrgs(o);
      setArticles(a);
      if (activeId === null && l.length > 0) setActiveId(l[0]!.id);
    } catch (e) {
      setError(String(e));
    }
  }, [activeId]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (activeId === null) {
      setItems([]);
      return;
    }
    void mailApi.db.priceListItems(activeId).then(setItems).catch((e: unknown) => {
      setError(String(e));
    });
  }, [activeId]);

  function openNew() {
    setEditing({ ...EMPTY_LIST });
    setEditorOpen(true);
  }
  function openEdit(l: DbPriceListRow) {
    setEditing({
      id: l.id,
      name: l.name,
      organizationId: l.organizationId,
      isDefault: l.isDefault,
      validFrom: l.validFrom,
      validTo: l.validTo,
      notes: l.notes,
    });
    setEditorOpen(true);
  }
  async function saveList() {
    setError(null);
    if (!editing.name.trim()) { setError('Il nome del listino è obbligatorio.'); return; }
    try {
      const id = await mailApi.db.priceListUpsert(editing);
      setEditorOpen(false);
      setActiveId(id);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }
  async function removeList(id: number) {
    if (!window.confirm('Eliminare il listino e tutte le sue righe?')) return;
    try {
      await mailApi.db.priceListDelete(id);
      if (activeId === id) setActiveId(null);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  function openNewItem() {
    if (activeId === null) return;
    setEditingItem({
      priceListId: activeId,
      articleId: articles[0]?.id ?? 0,
      price: 0,
      discountPercent: 0,
      notes: null,
    });
    setItemEditorOpen(true);
  }
  function openEditItem(it: DbPriceListItemRow) {
    if (activeId === null) return;
    setEditingItem({
      id: it.id,
      priceListId: activeId,
      articleId: it.articleId,
      price: it.price,
      discountPercent: it.discountPercent,
      notes: it.notes,
    });
    setItemEditorOpen(true);
  }
  async function saveItem() {
    if (!editingItem) return;
    setError(null);
    try {
      await mailApi.db.priceListItemUpsert(editingItem);
      setItemEditorOpen(false);
      if (activeId !== null) {
        const list = await mailApi.db.priceListItems(activeId);
        setItems(list);
      }
    } catch (e) {
      setError(String(e));
    }
  }
  async function removeItem(id: number) {
    if (!window.confirm('Rimuovere questa riga dal listino?')) return;
    try {
      await mailApi.db.priceListItemDelete(id);
      if (activeId !== null) {
        const list = await mailApi.db.priceListItems(activeId);
        setItems(list);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  const active = lists.find((l) => l.id === activeId) ?? null;

  return (
    <main className={styles.root}>
      <header className={styles.head}>
        <div className={styles.titleGroup}>
          <h1 className={styles.title}>€ Listini</h1>
          <p className={styles.subtitle}>
            Listino generale + listini per cliente. Ogni cliente nella sua scheda anagrafica può
            avere un listino dedicato che pesca dalla stessa anagrafica articoli.
          </p>
        </div>
      </header>

      {error && (
        <div className={styles.error}>
          {error}
          <button type="button" onClick={() => { setError(null); }}>✕</button>
        </div>
      )}

      <div className={styles.body}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHead}>
            <span className={styles.sidebarTitle}>Listini ({lists.length})</span>
            <Button variant="solid" size="sm" onClick={openNew}>+ Nuovo</Button>
          </div>
          <ul className={styles.list}>
            {lists.map((l) => (
              <li key={l.id}>
                <button
                  type="button"
                  className={`${styles.listItem} ${l.id === activeId ? styles.activeItem : ''}`}
                  onClick={() => { setActiveId(l.id); }}
                >
                  <div className={styles.listItemMain}>
                    <span className={styles.listItemName}>
                      {l.isDefault && <span className={styles.starBadge}>★</span>}
                      {l.name}
                    </span>
                    <span className={styles.listItemMeta}>
                      {l.organizationName ?? (l.isDefault ? 'Generale' : '—')} · {l.itemCount} righe
                    </span>
                  </div>
                </button>
              </li>
            ))}
            {lists.length === 0 && (
              <li className={styles.emptyList}>
                Nessun listino. Crea il primo con «+ Nuovo».
              </li>
            )}
          </ul>
        </aside>

        <section className={styles.detail}>
          {active === null ? (
            <div className={styles.emptyDetail}>
              <div className={styles.emptyGlyph}>€</div>
              <h2>Seleziona o crea un listino</h2>
              <p>I listini collegano gli articoli a un prezzo specifico per uno o più clienti.</p>
            </div>
          ) : (
            <>
              <header className={styles.detailHead}>
                <div>
                  <h2 className={styles.detailTitle}>
                    {active.isDefault && <span className={styles.starBadge}>★</span>}
                    {active.name}
                  </h2>
                  <p className={styles.detailSub}>
                    {active.organizationName
                      ? <>Per cliente: <strong>{active.organizationName}</strong></>
                      : <>Listino generale (valido per tutti i clienti senza listino dedicato)</>}
                    {' · '}{active.itemCount} righe
                  </p>
                </div>
                <div className={styles.detailActions}>
                  <Button variant="outline" onClick={() => { openEdit(active); }}>✎ Modifica</Button>
                  <Button variant="ghost" onClick={() => void removeList(active.id)}>🗑 Elimina</Button>
                  <Button variant="solid" onClick={openNewItem}>+ Aggiungi articolo</Button>
                </div>
              </header>

              {items.length === 0 ? (
                <div className={styles.emptyDetail}>
                  <p>Listino vuoto. Aggiungi articoli con «+ Aggiungi articolo».</p>
                </div>
              ) : (
                <table className={styles.itemsTable}>
                  <thead>
                    <tr>
                      <th>Codice</th>
                      <th>Descrizione</th>
                      <th>UM</th>
                      <th>Prezzo</th>
                      <th>Sconto %</th>
                      <th>Prezzo netto</th>
                      <th>Note</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it) => {
                      const net = it.price * (1 - it.discountPercent / 100);
                      return (
                        <tr key={it.id} onDoubleClick={() => { openEditItem(it); }}>
                          <td><code>{it.articleCode}</code></td>
                          <td>{it.articleDescription}</td>
                          <td>{it.articleUnit ?? '—'}</td>
                          <td className={styles.numCell}>
                            {new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(it.price)}
                          </td>
                          <td className={styles.numCell}>{it.discountPercent.toFixed(1)}%</td>
                          <td className={styles.numCell}>
                            <strong>
                              {new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(net)}
                            </strong>
                          </td>
                          <td>{it.notes ?? ''}</td>
                          <td className={styles.rowActions}>
                            <button type="button" className={styles.rowBtn} onClick={() => { openEditItem(it); }}>✎</button>
                            <button type="button" className={styles.rowBtn} onClick={() => void removeItem(it.id)}>🗑</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </>
          )}
        </section>
      </div>

      {/* Editor listino */}
      <Dialog
        open={editorOpen}
        onClose={() => { setEditorOpen(false); }}
        title={editing.id ? 'Modifica listino' : 'Nuovo listino'}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setEditorOpen(false); }}>Annulla</Button>
            <Button variant="solid" onClick={() => void saveList()}>Salva</Button>
          </>
        }
      >
        <div className={styles.editorStack}>
          <TextField
            label="Nome listino *"
            value={editing.name}
            onChange={(e) => { setEditing({ ...editing, name: e.target.value }); }}
            placeholder="Es. Listino 2026, Listino Cliente Acme, ..."
            fullWidth
          />
          <Select
            label="Cliente (organizzazione)"
            value={editing.organizationId?.toString() ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              setEditing({ ...editing, organizationId: v ? Number(v) : null });
            }}
            items={[
              { value: '', label: '— Nessuno (listino generale) —' },
              ...orgs.map((o) => ({
                value: String(o.id),
                label: `${o.displayName ?? o.domain} (${o.domain})`,
              })),
            ]}
            fullWidth
          />
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={editing.isDefault ?? false}
              onChange={(e) => { setEditing({ ...editing, isDefault: e.target.checked }); }}
            />{' '}
            Imposta come <strong>listino default</strong> (verrà disabilitato sugli altri)
          </label>
        </div>
      </Dialog>

      {/* Editor riga listino */}
      <Dialog
        open={itemEditorOpen}
        onClose={() => { setItemEditorOpen(false); }}
        title={editingItem?.id ? 'Modifica riga listino' : 'Aggiungi articolo al listino'}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setItemEditorOpen(false); }}>Annulla</Button>
            <Button variant="solid" onClick={() => void saveItem()}>Salva</Button>
          </>
        }
      >
        {editingItem && (
          <div className={styles.editorStack}>
            <Select
              label="Articolo"
              value={String(editingItem.articleId)}
              onChange={(e) => { setEditingItem({ ...editingItem, articleId: Number(e.target.value) }); }}
              items={articles.map((a) => ({ value: String(a.id), label: `${a.code} — ${a.description}` }))}
              fullWidth
            />
            <TextField
              label="Prezzo (€)"
              type="number"
              value={String(editingItem.price)}
              onChange={(e) => { setEditingItem({ ...editingItem, price: Number(e.target.value || 0) }); }}
              fullWidth
            />
            <TextField
              label="Sconto %"
              type="number"
              value={String(editingItem.discountPercent ?? 0)}
              onChange={(e) => { setEditingItem({ ...editingItem, discountPercent: Number(e.target.value || 0) }); }}
              fullWidth
            />
            <TextField
              label="Note"
              value={editingItem.notes ?? ''}
              onChange={(e) => { setEditingItem({ ...editingItem, notes: e.target.value }); }}
              placeholder="Note opzionali per questa riga"
              fullWidth
            />
          </div>
        )}
      </Dialog>
    </main>
  );
}
