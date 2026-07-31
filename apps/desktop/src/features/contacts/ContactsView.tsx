import { useEffect, useMemo, useState } from 'react';

import { mailApi } from '../mail/api';
import type { DbOrganizationRow } from '../mail/api';
import type { BrandRow, CategoryRow, OrganizationDetail } from '../mail/types';

import styles from './ContactsView.module.css';
import { NewPartnerDialog } from './dialogs/NewPartnerDialog';
import { PartnerDetail } from './PartnerDetail';
import { PartnersSidebar } from './PartnersSidebar';
import type { PartnerFilter } from './types';

export function ContactsView() {
  const [partners, setPartners] = useState<DbOrganizationRow[]>([]);
  /** Universo completo (mai filtrato) per i conteggi reali nei chip. */
  const [allPartners, setAllPartners] = useState<DbOrganizationRow[]>([]);
  const [filter, setFilter] = useState<PartnerFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeId, setActiveId] = useState<number | null>(null);
  const [detail, setDetail] = useState<OrganizationDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [brands, setBrands] = useState<BrandRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [newOpen, setNewOpen] = useState(false);

  async function refreshList() {
    setLoading(true);
    try {
      // Carico SEMPRE in parallelo l'universo completo (per i conteggi)
      // e la lista filtrata (per la sidebar visibile).
      const [list, all] = await Promise.all([
        mailApi.db.listBusinessPartners(filter === 'clients', filter === 'suppliers'),
        // Universo: nessun filtro applicato
        mailApi.db.listBusinessPartners(false, false),
      ]);
      setPartners(list);
      setAllPartners(all);
      if (list.length > 0 && (activeId === null || !list.some((p) => p.id === activeId))) {
        setActiveId(list[0]!.id);
      } else if (list.length === 0) {
        setActiveId(null);
        setDetail(null);
      }
    } finally {
      setLoading(false);
    }
  }

  async function refreshDetail() {
    if (activeId === null) {
      setDetail(null);
      return;
    }
    const d = await mailApi.db.getOrganization(activeId);
    setDetail(d);
  }

  useEffect(() => {
    void refreshList(); /* eslint-disable-next-line */
  }, [filter]);
  useEffect(() => {
    void refreshDetail();
  }, [activeId]);

  useEffect(() => {
    void (async () => {
      const [b, c] = await Promise.all([mailApi.db.listBrands(), mailApi.db.listCategories()]);
      setBrands(b);
      setCategories(c);
    })();
  }, []);

  const filteredPartners = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return partners;
    return partners.filter(
      (p) =>
        (p.displayName ?? '').toLowerCase().includes(q) ||
        p.domain.toLowerCase().includes(q) ||
        (p.vatNumber ?? '').toLowerCase().includes(q) ||
        (p.emailAddress ?? '').toLowerCase().includes(q),
    );
  }, [partners, searchQuery]);

  async function handleToggleRole(role: 'client' | 'supplier') {
    if (!detail) return;
    const next = {
      ...mapDetailToUpdate(detail),
      isClient: role === 'client' ? !detail.isClient : detail.isClient,
      isSupplier: role === 'supplier' ? !detail.isSupplier : detail.isSupplier,
    };
    await mailApi.db.organizationUpdate(next);
    await Promise.all([refreshDetail(), refreshList()]);
  }

  async function handleDelete() {
    if (!detail) return;
    await mailApi.db.organizationDelete(detail.id);
    setActiveId(null);
    setDetail(null);
    await refreshList();
  }

  return (
    <div className={styles.root}>
      <header className={styles.head}>
        <div className={styles.title}>
          <span className={styles.titleIcon}>🤝</span>
          <div>
            <h1 className={styles.titleText}>Anagrafica Clienti &amp; Fornitori</h1>
            <p className={styles.titleHint}>
              Schede gestionali (no rubrica): dati fiscali, indirizzo, default operativi, listino
              dedicato, sconti per categoria × marchio, archivio documenti.
            </p>
          </div>
        </div>
        <button
          type="button"
          className={styles.newBtn}
          onClick={() => {
            setNewOpen(true);
          }}
        >
          ＋ Nuova anagrafica
        </button>
      </header>

      <div className={styles.frame}>
        <PartnersSidebar
          partners={filteredPartners}
          activeId={activeId}
          onSelect={setActiveId}
          filter={filter}
          onChangeFilter={setFilter}
          searchQuery={searchQuery}
          onChangeSearch={setSearchQuery}
          counts={{
            all: allPartners.length,
            clients: allPartners.filter((p) => p.isClient).length,
            suppliers: allPartners.filter((p) => p.isSupplier).length,
          }}
        />

        <main className={styles.main}>
          {loading && partners.length === 0 ? (
            <div className={styles.empty}>Caricamento…</div>
          ) : !detail ? (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>🏢</div>
              <p className={styles.emptyTitle}>Nessuna scheda selezionata</p>
              <p className={styles.emptyText}>
                Crea una nuova anagrafica o seleziona un cliente/fornitore dalla sidebar.
              </p>
            </div>
          ) : (
            <PartnerDetail
              partner={detail}
              brands={brands}
              categories={categories}
              onToggleRole={handleToggleRole}
              onDelete={() => void handleDelete()}
              onSaved={() => {
                void refreshDetail();
                void refreshList();
              }}
            />
          )}
        </main>
      </div>

      {newOpen && (
        <NewPartnerDialog
          onClose={() => {
            setNewOpen(false);
          }}
          onCreated={(id) => {
            setNewOpen(false);
            setActiveId(id);
            void refreshList();
          }}
        />
      )}
    </div>
  );
}

function mapDetailToUpdate(d: OrganizationDetail) {
  return {
    id: d.id,
    displayName: d.displayName,
    vatNumber: d.vatNumber,
    address: d.address,
    phone: d.phone,
    website: d.website,
    notes: d.notes,
    isClient: d.isClient,
    isSupplier: d.isSupplier,
    taxCode: d.taxCode,
    sdiCode: d.sdiCode,
    pec: d.pec,
    iban: d.iban,
    bankName: d.bankName,
    streetAddress: d.streetAddress,
    city: d.city,
    postalCode: d.postalCode,
    province: d.province,
    countryIso2: d.countryIso2,
    preferredCourier: d.preferredCourier,
    paymentTerms: d.paymentTerms,
    shippingTerms: d.shippingTerms,
    preferredLanguage: d.preferredLanguage,
    emailAddress: d.emailAddress,
  };
}
