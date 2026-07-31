import type { DbOrganizationRow } from '../mail/api';

import styles from './PartnersSidebar.module.css';
import type { PartnerFilter } from './types';


interface Props {
  partners: DbOrganizationRow[];
  activeId: number | null;
  onSelect: (id: number) => void;
  filter: PartnerFilter;
  onChangeFilter: (f: PartnerFilter) => void;
  searchQuery: string;
  onChangeSearch: (q: string) => void;
  counts: { all: number; clients: number; suppliers: number };
}

function initials(name: string | null, domain: string): string {
  const trimmed = name?.trim() ?? '';
  const s = trimmed.length > 0 ? trimmed : domain;
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]!.charAt(0) + parts[1]!.charAt(0)).toUpperCase();
}

export function PartnersSidebar({
  partners, activeId, onSelect,
  filter, onChangeFilter,
  searchQuery, onChangeSearch,
  counts,
}: Props) {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.searchWrap}>
        <input
          type="search"
          className={styles.search}
          placeholder="Cerca per nome, P.IVA, dominio, email…"
          value={searchQuery}
          onChange={(e) => { onChangeSearch(e.target.value); }}
        />
      </div>

      <div className={styles.tabsRow} role="tablist" aria-label="Filtro">
        <FilterTab
          active={filter === 'all'} onClick={() => { onChangeFilter('all'); }}
          icon="📚" label="Tutti" count={counts.all}
        />
        <FilterTab
          active={filter === 'clients'} onClick={() => { onChangeFilter('clients'); }}
          icon="🤝" label="Clienti" count={counts.clients} accent="emerald"
        />
        <FilterTab
          active={filter === 'suppliers'} onClick={() => { onChangeFilter('suppliers'); }}
          icon="🏭" label="Fornitori" count={counts.suppliers} accent="amber"
        />
      </div>

      <div className={styles.list}>
        {partners.length === 0 && (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>📭</div>
            <p className={styles.emptyText}>
              Nessuna anagrafica trovata.<br />
              {filter !== 'all' && 'Cambia filtro o '}
              crea una nuova scheda dall'header.
            </p>
          </div>
        )}

        {partners.map((p) => {
          const isActive = p.id === activeId;
          return (
            <button
              key={p.id}
              type="button"
              className={`${styles.row} ${isActive ? styles.rowActive : ''}`}
              onClick={() => { onSelect(p.id); }}
            >
              <span className={styles.avatar}>{initials(p.displayName, p.domain)}</span>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>
                  {p.displayName ?? p.domain}
                </span>
                <span className={styles.rowMeta}>
                  {p.vatNumber ? `P.IVA ${p.vatNumber}` : p.domain}
                  {p.city && ` · ${p.city}`}
                </span>
              </span>
              <span className={styles.badges}>
                {p.isClient && <span className={`${styles.badge} ${styles.badgeClient}`}>C</span>}
                {p.isSupplier && <span className={`${styles.badge} ${styles.badgeSupplier}`}>F</span>}
                {!p.isClient && !p.isSupplier && (
                  <span className={`${styles.badge} ${styles.badgeNone}`}>?</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

interface TabProps {
  active: boolean;
  onClick: () => void;
  icon: string;
  label: string;
  count: number;
  accent?: 'emerald' | 'amber';
}

function FilterTab({ active, onClick, icon, label, count, accent }: TabProps) {
  const cls = [
    styles.tab,
    active ? styles.tabActive : '',
    accent === 'emerald' ? styles.tabEmerald : '',
    accent === 'amber' ? styles.tabAmber : '',
  ].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} onClick={onClick} role="tab" aria-selected={active}>
      <span className={styles.tabIcon}>{icon}</span>
      <span className={styles.tabLabel}>{label}</span>
      <span className={styles.tabCount}>{count}</span>
    </button>
  );
}
