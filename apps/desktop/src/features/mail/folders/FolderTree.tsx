import type { FolderInfo } from '../types';

import { folderLabelFromInfo } from './folder-label';
import styles from './FolderTree.module.css';

interface Props {
  folders: FolderInfo[];
  loading: boolean;
  active: string;
  onSelect: (name: string) => void;
}

function classify(f: FolderInfo): { label: string; order: number } {
  const label = folderLabelFromInfo(f);
  const orderMap: Record<string, number> = {
    'Posta in arrivo': 1,
    Inviata: 2,
    Bozze: 3,
    Spam: 4,
    Cestino: 5,
    Archivio: 6,
  };
  return { label, order: orderMap[label] ?? 10 };
}

export function FolderTree({ folders, loading, active, onSelect }: Props) {
  if (loading) {
    return (
      <div className={styles.placeholder}>
        <span className={styles.spinner} aria-hidden />
        Carico cartelle…
      </div>
    );
  }

  if (folders.length === 0) {
    return <div className={styles.placeholder}>Nessuna cartella.</div>;
  }

  const enriched = folders
    .filter((f) => !f.attributes.some((a) => a.toLowerCase().includes('noselect')))
    .map((f) => ({ ...f, ...classify(f) }))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));

  return (
    <nav className={styles.tree} aria-label="Cartelle">
      <ul>
        {enriched.map((f) => (
          <li key={f.name}>
            <button
              type="button"
              className={`${styles.item} ${f.name === active ? styles.active : ''}`}
              onClick={() => { onSelect(f.name); }}
            >
              <span className={styles.label}>{f.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
