import { useState } from 'react';

import { mailApi } from '../../mail/api';

import styles from './EditPartnerDialog.module.css';

interface Props {
  onClose: () => void;
  onCreated: (id: number) => void;
}

export function NewPartnerDialog({ onClose, onCreated }: Props) {
  const [displayName, setDisplayName] = useState('');
  const [emailAddress, setEmailAddress] = useState('');
  const [domain, setDomain] = useState('');
  const [isClient, setIsClient] = useState(true);
  const [isSupplier, setIsSupplier] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!displayName.trim()) {
      setError('Inserisci la ragione sociale.');
      return;
    }
    if (!isClient && !isSupplier) {
      setError('Seleziona almeno un ruolo: cliente o fornitore.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const derivedDomain = domain.trim()
        || (emailAddress.includes('@') ? emailAddress.split('@')[1] ?? '' : '');
      const id = await mailApi.db.organizationInsert({
        displayName: displayName.trim(),
        domain: derivedDomain || null,
        emailAddress: emailAddress.trim() || null,
        isClient,
        isSupplier,
      });
      onCreated(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => { e.stopPropagation(); }} style={{ width: 480 }}>
        <header className={styles.head}>
          <h2 className={styles.title}>Nuova anagrafica</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose}>✕</button>
        </header>

        <div className={styles.body}>
          <section className={styles.section}>
            <div className={styles.sectionBody}>
              <label className={styles.formRow}>
                <span className={styles.formLabel}>Ragione sociale *</span>
                <input
                  autoFocus
                  className={styles.input}
                  value={displayName}
                  onChange={(e) => { setDisplayName(e.target.value); }}
                  placeholder="es. ACME Industries S.r.l."
                />
              </label>
              <label className={styles.formRow}>
                <span className={styles.formLabel}>Email principale (opzionale)</span>
                <input
                  className={styles.input}
                  type="email"
                  value={emailAddress}
                  onChange={(e) => { setEmailAddress(e.target.value); }}
                  placeholder="info@acme.it"
                />
              </label>
              <label className={styles.formRow}>
                <span className={styles.formLabel}>Dominio (auto-derivato dall'email se vuoto)</span>
                <input
                  className={styles.input}
                  value={domain}
                  onChange={(e) => { setDomain(e.target.value); }}
                  placeholder="acme.it"
                />
              </label>
            </div>
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Ruoli</h3>
            <div className={styles.sectionBody}>
              <label className={styles.checkRow}>
                <input type="checkbox" checked={isClient}
                  onChange={(e) => { setIsClient(e.target.checked); }} />
                <span>🤝 È un <strong>cliente</strong></span>
              </label>
              <label className={styles.checkRow}>
                <input type="checkbox" checked={isSupplier}
                  onChange={(e) => { setIsSupplier(e.target.checked); }} />
                <span>🏭 È un <strong>fornitore</strong></span>
              </label>
            </div>
          </section>

          {error && <div className={styles.error}>❌ {error}</div>}
        </div>

        <footer className={styles.foot}>
          <button type="button" className={styles.ghostBtn} onClick={onClose}>Annulla</button>
          <button type="button" className={styles.primaryBtn} onClick={() => void save()} disabled={saving}>
            {saving ? 'Creazione…' : 'Crea scheda'}
          </button>
        </footer>
      </div>
    </div>
  );
}
