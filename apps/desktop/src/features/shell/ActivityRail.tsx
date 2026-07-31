import { Tooltip } from '@medea/ui';
import type { ReactNode } from 'react';


import styles from './ActivityRail.module.css';

export type SectionId =
  | 'mail'
  | 'address-book'
  | 'contacts'
  | 'articles'
  | 'price-lists'
  | 'documents'
  | 'db-studio'
  | 'settings';

interface Entry {
  id: SectionId;
  label: string;
  icon: ReactNode;
}

const ENTRIES: Entry[] = [
  { id: 'mail', label: 'Posta', icon: '✉' },
  { id: 'address-book', label: 'Rubrica indirizzi', icon: '📇' },
  { id: 'contacts', label: 'Anagrafica clienti & fornitori', icon: '🤝' },
  { id: 'articles', label: 'Articoli', icon: '📦' },
  { id: 'price-lists', label: 'Listini', icon: '€' },
  { id: 'documents', label: 'Documenti & Template', icon: '📄' },
  { id: 'db-studio', label: 'DB Studio', icon: '🗄' },
  { id: 'settings', label: 'Profilo & Firma', icon: '⚙' },
];

interface Props {
  active: SectionId;
  onSelect: (s: SectionId) => void;
}

export function ActivityRail({ active, onSelect }: Props) {
  return (
    <nav className={styles.rail} aria-label="Sezioni Medea">
      <div className={styles.brand}>
        <img src="/icon.png" alt="Medea" width={28} height={28} className={styles.brandIcon} />
      </div>
      <ul className={styles.list}>
        {ENTRIES.map((e) => (
          <li key={e.id}>
            <Tooltip label={e.label} placement="right">
              <button
                type="button"
                aria-label={e.label}
                aria-pressed={e.id === active}
                className={`${styles.btn} ${e.id === active ? styles.active : ''}`}
                onClick={() => { onSelect(e.id); }}
              >
                <span className={styles.icon}>{e.icon}</span>
              </button>
            </Tooltip>
          </li>
        ))}
      </ul>
    </nav>
  );
}
