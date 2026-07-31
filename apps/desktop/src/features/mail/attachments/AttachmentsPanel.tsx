import { useEffect, useState } from 'react';

import { mailApi } from '../api';
import type { AttachmentEntry, ThreatLevel } from '../types';

import styles from './AttachmentsPanel.module.css';

interface Props {
  messageId: number | null;
}

function fmtSize(b: number): string {
  if (b < 1024) return `${b.toString()} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function levelLabel(l: ThreatLevel): string {
  switch (l) {
    case 'safe':
      return 'Sicuro';
    case 'caution':
      return 'Attenzione';
    case 'danger':
      return 'Pericoloso';
  }
}

function levelClass(l: ThreatLevel): string {
  return styles[`level_${l}`] ?? '';
}

export function AttachmentsPanel({ messageId }: Props) {
  const [items, setItems] = useState<AttachmentEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<AttachmentEntry | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setItems([]);
    setSelected(null);
    setSavedTo(null);
    setError(null);
    if (messageId === null) return;
    setLoading(true);
    void mailApi.db
      .listAttachments(messageId)
      .then((list) => {
        setItems(list.filter((a) => !a.isInline));
      })
      .catch((e: unknown) => {
        setError(String(e));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [messageId]);

  if (messageId === null) return null;
  if (loading)
    return (
      <div className={styles.row}>
        <span className={styles.muted}>Analizzo allegati…</span>
      </div>
    );
  if (items.length === 0) return null;

  async function handleSave(entry: AttachmentEntry) {
    if (messageId === null) return;
    try {
      setSaving(true);
      setError(null);
      // Path nativo cross-platform: Tauri `downloadDir()` ritorna
      // `~/Downloads` su macOS/Linux, `C:\Users\<user>\Downloads` su Windows.
      // `join` usa il separatore corretto del sistema operativo host.
      const { downloadDir, join } = await import('@tauri-apps/api/path');
      const downloads = await downloadDir();
      const safeName = entry.filename.replace(/[^a-zA-Z0-9._\- ]+/g, '_');
      const dest = await join(downloads, 'Medea', safeName);
      const written = await mailApi.db.saveAttachment(messageId, entry.index, dest);
      setSavedTo(written);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const danger = items.filter((a) => a.threat.level === 'danger').length;
  const caution = items.filter((a) => a.threat.level === 'caution').length;

  return (
    <section className={styles.panel} aria-label="Allegati">
      <header className={styles.head}>
        <span className={styles.headIcon}>📎</span>
        <span className={styles.headTitle}>
          {items.length} {items.length === 1 ? 'allegato' : 'allegati'}
        </span>
        {danger > 0 && (
          <span className={`${styles.headBadge} ${styles.level_danger}`}>
            {danger} pericoloso{danger > 1 ? 'si' : ''}
          </span>
        )}
        {caution > 0 && (
          <span className={`${styles.headBadge} ${styles.level_caution}`}>
            {caution} attenzione
          </span>
        )}
      </header>

      <div className={styles.list}>
        {items.map((a) => (
          <button
            key={a.index}
            type="button"
            className={`${styles.item} ${levelClass(a.threat.level)}`}
            onClick={() => {
              setSelected(a);
              setSavedTo(null);
              setError(null);
            }}
          >
            <span className={styles.itemIcon}>{a.threat.icon}</span>
            <div className={styles.itemMain}>
              <div className={styles.itemName} title={a.filename}>
                {a.filename}
              </div>
              <div className={styles.itemMeta}>
                <span>{a.threat.category}</span>
                <span> · </span>
                <span>{fmtSize(a.sizeBytes)}</span>
              </div>
            </div>
            <span className={`${styles.itemBadge} ${levelClass(a.threat.level)}`}>
              {levelLabel(a.threat.level)}
            </span>
          </button>
        ))}
      </div>

      {selected && (
        <div
          className={styles.backdrop}
          onClick={() => {
            setSelected(null);
          }}
        >
          <div
            className={styles.modal}
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <header className={`${styles.modalHead} ${levelClass(selected.threat.level)}`}>
              <span className={styles.modalIcon}>{selected.threat.icon}</span>
              <div className={styles.modalTitle}>
                <div className={styles.modalLevel}>
                  {selected.threat.level === 'safe' && '🛡 ANALISI: SICURO'}
                  {selected.threat.level === 'caution' && '⚠️ ANALISI: ATTENZIONE'}
                  {selected.threat.level === 'danger' && '🚫 ANALISI: PERICOLO'}
                </div>
                <div className={styles.modalFilename}>{selected.filename}</div>
              </div>
              <button
                type="button"
                className={styles.closeBtn}
                onClick={() => {
                  setSelected(null);
                }}
                aria-label="Chiudi"
              >
                ✕
              </button>
            </header>

            <div className={styles.modalBody}>
              <dl className={styles.modalMeta}>
                <div>
                  <dt>Tipo</dt>
                  <dd>{selected.threat.category}</dd>
                </div>
                <div>
                  <dt>MIME</dt>
                  <dd>
                    <code>{selected.contentType}</code>
                  </dd>
                </div>
                <div>
                  <dt>Dimensione</dt>
                  <dd>{fmtSize(selected.sizeBytes)}</dd>
                </div>
                {selected.threat.sha256Hex && (
                  <div>
                    <dt>SHA-256</dt>
                    <dd className={styles.sha}>
                      <code>{selected.threat.sha256Hex}</code>
                    </dd>
                  </div>
                )}
              </dl>

              {selected.threat.reasons.length > 0 && (
                <section className={styles.section}>
                  <h4 className={styles.sectionTitle}>
                    {selected.threat.level === 'safe' ? 'Note' : 'Motivi della segnalazione'}
                  </h4>
                  <ul className={styles.reasonList}>
                    {selected.threat.reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </section>
              )}

              {selected.threat.suggestions.length > 0 && (
                <section className={styles.section}>
                  <h4 className={styles.sectionTitle}>Consigli</h4>
                  <ul className={styles.suggList}>
                    {selected.threat.suggestions.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </section>
              )}

              {selected.threat.level === 'danger' && (
                <div className={styles.dangerBanner}>
                  🚫 <strong>NON aprire.</strong> Salvalo SOLO se sei certo del mittente e sai cosa
                  stai facendo.
                </div>
              )}

              {error && <div className={styles.errorBanner}>❌ {error}</div>}
              {savedTo && (
                <div className={styles.successBanner}>
                  ✓ Salvato in: <code>{savedTo}</code>
                </div>
              )}
            </div>

            <footer className={styles.modalFoot}>
              {selected.threat.sha256Hex && (
                <a
                  className={styles.linkBtn}
                  href={`https://www.virustotal.com/gui/file/${selected.threat.sha256Hex}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Cerca hash su VirusTotal ↗
                </a>
              )}
              <span style={{ flex: 1 }} />
              <button
                type="button"
                className={styles.ghostBtn}
                onClick={() => {
                  setSelected(null);
                }}
              >
                Chiudi
              </button>
              <button
                type="button"
                className={`${styles.saveBtn} ${selected.threat.level === 'danger' ? styles.saveBtnDanger : ''}`}
                onClick={() => void handleSave(selected)}
                disabled={saving}
              >
                {saving
                  ? 'Salvataggio…'
                  : selected.threat.level === 'danger'
                    ? '⚠️ Salva comunque'
                    : '💾 Salva in Downloads/Medea'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}
