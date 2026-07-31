import { useState } from 'react';

import type { BrandRow, CategoryRow, OrganizationDetail } from '../mail/types';

import styles from './PartnerDetail.module.css';
import { TabAnagrafica } from './tabs/TabAnagrafica';
import { TabComunicazioni } from './tabs/TabComunicazioni';
import { TabContatti } from './tabs/TabContatti';
import { TabDocumenti } from './tabs/TabDocumenti';
import { TabListino } from './tabs/TabListino';
import { TabNote } from './tabs/TabNote';
import { TabSconti } from './tabs/TabSconti';
import type { DetailTab } from './types';


interface Props {
  partner: OrganizationDetail;
  brands: BrandRow[];
  categories: CategoryRow[];
  onToggleRole: (role: 'client' | 'supplier') => void;
  onDelete: () => void;
  /** Chiamata dopo un salvataggio riuscito nei tab, per ricaricare l'hero. */
  onSaved?: () => void;
}

const TABS: { id: DetailTab; icon: string; label: string }[] = [
  { id: 'anagrafica',    icon: '🪪', label: 'Anagrafica' },
  { id: 'contatti',      icon: '📇', label: 'Contatti email' },
  { id: 'listino',       icon: '💶', label: 'Listino dedicato' },
  { id: 'sconti',        icon: '🎯', label: 'Sconti cat × marchio' },
  { id: 'documenti',     icon: '📑', label: 'Documenti' },
  { id: 'comunicazioni', icon: '📨', label: 'Comunicazioni' },
  { id: 'note',          icon: '📝', label: 'Note' },
];

function initials(d: OrganizationDetail): string {
  const trimmed = d.displayName?.trim() ?? '';
  const s = trimmed.length > 0 ? trimmed : d.domain;
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]!.charAt(0) + parts[1]!.charAt(0)).toUpperCase();
}

export function PartnerDetail({ partner, brands, categories, onToggleRole, onDelete, onSaved }: Props) {
  const [tab, setTab] = useState<DetailTab>('anagrafica');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  function handleDeleteClick() {
    if (confirmingDelete) {
      onDelete();
      setConfirmingDelete(false);
    } else {
      setConfirmingDelete(true);
      setTimeout(() => { setConfirmingDelete(false); }, 3000);
    }
  }

  return (
    <div className={styles.detail}>
      <header className={styles.hero}>
        <div className={styles.heroLeft}>
          <div className={styles.avatar}>{initials(partner)}</div>
          <div className={styles.heroInfo}>
            <h2 className={styles.heroName}>{partner.displayName ?? partner.domain}</h2>
            <div className={styles.heroMeta}>
              {partner.vatNumber && <span>P.IVA <strong>{partner.vatNumber}</strong></span>}
              {partner.taxCode && <span>CF <strong>{partner.taxCode}</strong></span>}
              {partner.city && (
                <span>
                  {partner.city}
                  {partner.province && ` (${partner.province})`}
                  {partner.countryIso2 && `, ${partner.countryIso2}`}
                </span>
              )}
            </div>
            <div className={styles.heroRoles}>
              <RoleChip
                active={partner.isClient}
                onClick={() => { onToggleRole('client'); }}
                icon="🤝" label="Cliente" accent="emerald"
              />
              <RoleChip
                active={partner.isSupplier}
                onClick={() => { onToggleRole('supplier'); }}
                icon="🏭" label="Fornitore" accent="amber"
              />
            </div>
          </div>
        </div>
        <div className={styles.heroActions}>
          <button
            type="button"
            className={`${styles.actionBtn} ${confirmingDelete ? styles.danger : ''}`}
            onClick={handleDeleteClick}
            title={confirmingDelete ? 'Clicca di nuovo per confermare' : 'Elimina anagrafica'}
          >
            {confirmingDelete ? '✓ Conferma' : '🗑 Elimina'}
          </button>
        </div>
      </header>

      <nav className={styles.tabBar} role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`${styles.tab} ${tab === t.id ? styles.tabActive : ''}`}
            onClick={() => { setTab(t.id); }}
            role="tab"
            aria-selected={tab === t.id}
          >
            <span className={styles.tabIcon}>{t.icon}</span>
            <span className={styles.tabLabel}>{t.label}</span>
          </button>
        ))}
      </nav>

      <div className={styles.tabContent}>
        {tab === 'anagrafica'    && <TabAnagrafica partner={partner} {...(onSaved ? { onSaved } : {})} />}
        {tab === 'contatti'      && <TabContatti partner={partner} />}
        {tab === 'listino'       && <TabListino partner={partner} />}
        {tab === 'sconti'        && <TabSconti partner={partner} brands={brands} categories={categories} />}
        {tab === 'documenti'     && <TabDocumenti partner={partner} />}
        {tab === 'comunicazioni' && <TabComunicazioni partner={partner} />}
        {tab === 'note'          && <TabNote partner={partner} />}
      </div>
    </div>
  );
}

interface RoleChipProps {
  active: boolean;
  onClick: () => void;
  icon: string;
  label: string;
  accent: 'emerald' | 'amber';
}

function RoleChip({ active, onClick, icon, label, accent }: RoleChipProps) {
  const cls = [
    styles.roleChip,
    active ? styles.roleChipActive : '',
    accent === 'emerald' ? styles.roleChipEmerald : '',
    accent === 'amber'   ? styles.roleChipAmber   : '',
  ].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} onClick={onClick}>
      <span>{icon}</span>
      <span>{active ? label : `+ ${label}`}</span>
    </button>
  );
}
