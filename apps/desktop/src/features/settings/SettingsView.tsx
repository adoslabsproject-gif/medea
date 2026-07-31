import { Button, Dialog, Select, TextField } from '@medea/ui';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';

import { useTheme, type ThemeMode } from '../../app/providers/ThemeProvider';
import { AccountSetup } from '../account-setup';
import { aiApi } from '../ai/api';
import type { ClaudeCliStatus } from '../ai/api';
import { getApiKey, setApiKey } from '../ai/keys';
import {
  CUSTOM_BASE_URL_KEY,
  CUSTOM_MODEL_KEY,
  providerLong,
  providerNeedsApiKey,
  type ProviderId,
} from '../ai/types';
import { TemplateEditor } from '../email-template';
import type { SenderInfo } from '../email-template';
import { mailApi } from '../mail/api';
import { useAccountStore } from '../mail/store/account-store';
import type { MailAccount } from '../mail/types';

import styles from './SettingsView.module.css';

interface Props {
  account: MailAccount;
}

const PROFILE_KEY = 'medea.profile.v2';
const PROFILE_PHOTO_KEY = 'medea.profile.photo.v1';
const DEFAULT_PROVIDER_KEY = 'medea.ai.defaultProvider';

interface Profile {
  displayName: string;
  role: string;
  phone: string;
  emailSignature: string;
  organizationName: string;
  vatNumber: string;
  address: string;
  website: string;
  notes: string;
}

const EMPTY_PROFILE: Profile = {
  displayName: '',
  role: '',
  phone: '',
  emailSignature: '',
  organizationName: '',
  vatNumber: '',
  address: '',
  website: '',
  notes: '',
};

const PROVIDERS: ProviderId[] = [
  'liara',
  'claude-cli',
  'custom',
  'anthropic',
  'openai',
  'gemini',
  'deepseek',
  'grok',
  'openrouter',
];

function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return EMPTY_PROFILE;
    return { ...EMPTY_PROFILE, ...(JSON.parse(raw) as Partial<Profile>) };
  } catch {
    return EMPTY_PROFILE;
  }
}
function loadPhoto(): string | null {
  return localStorage.getItem(PROFILE_PHOTO_KEY);
}

/* eslint-disable no-restricted-syntax -- documento isolato in <iframe sandbox>:
   i token del design system non lo raggiungono e questi sono i colori che il
   destinatario vedrà davvero nel suo client di posta. */
/** Anteprima della firma: HTML standalone renderizzato nell'iframe. */
function signaturePreviewHtml(signature: string): string {
  const body = signature.trim() || '<em style="color:#888;">La tua firma apparirà qui…</em>';
  return `<!doctype html><html><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; padding: 12px; color:#222; background:#fff; margin:0;">${body}</body></html>`;
}
/* eslint-enable no-restricted-syntax */

type Tab = 'profile' | 'accounts' | 'template' | 'ai';

/** Dati mittente usati dal template e dalla firma. */
function senderInfo(account: MailAccount): SenderInfo {
  const p = loadProfile();
  return {
    displayName: p.displayName || account.displayName,
    organizationName: p.organizationName,
    emailAddress: account.emailAddress,
    signatureHtml: p.emailSignature,
  };
}

export function SettingsView({ account }: Props) {
  const [tab, setTab] = useState<Tab>('profile');
  return (
    <main className={styles.root}>
      <header className={styles.head}>
        <div className={styles.titleGroup}>
          <h1 className={styles.title}>Impostazioni</h1>
          <p className={styles.subtitle}>Profilo personale, account email, modelli AI.</p>
        </div>
      </header>

      <nav className={styles.tabs} role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'profile'}
          className={`${styles.tab} ${tab === 'profile' ? styles.tabActive : ''}`}
          onClick={() => {
            setTab('profile');
          }}
        >
          <span className={styles.tabIcon}>👤</span> Profilo personale
        </button>
        <button
          role="tab"
          aria-selected={tab === 'accounts'}
          className={`${styles.tab} ${tab === 'accounts' ? styles.tabActive : ''}`}
          onClick={() => {
            setTab('accounts');
          }}
        >
          <span className={styles.tabIcon}>📧</span> Account email
        </button>
        <button
          role="tab"
          aria-selected={tab === 'template'}
          className={`${styles.tab} ${tab === 'template' ? styles.tabActive : ''}`}
          onClick={() => {
            setTab('template');
          }}
        >
          <span className={styles.tabIcon}>📄</span> Template email
        </button>
        <button
          role="tab"
          aria-selected={tab === 'ai'}
          className={`${styles.tab} ${tab === 'ai' ? styles.tabActive : ''}`}
          onClick={() => {
            setTab('ai');
          }}
        >
          <span className={styles.tabIcon}>✨</span> Modelli AI &amp; API keys
        </button>
      </nav>

      <div className={styles.body}>
        {tab === 'profile' && <ProfileTab />}
        {tab === 'accounts' && <AccountsTab activeId={account.id} />}
        {tab === 'template' && <TemplateEditor sender={senderInfo(account)} />}
        {tab === 'ai' && <AiKeysTab />}
      </div>
    </main>
  );
}

/* ───────────── PROFILO PERSONALE ───────────── */
function ProfileTab() {
  const { theme, setTheme } = useTheme();
  const [profile, setProfile] = useState<Profile>(() => loadProfile());
  const [photo, setPhoto] = useState<string | null>(() => loadPhoto());
  const [saved, setSaved] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);

  function save() {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    if (photo) localStorage.setItem(PROFILE_PHOTO_KEY, photo);
    else localStorage.removeItem(PROFILE_PHOTO_KEY);
    setSaved(true);
    setTimeout(() => {
      setSaved(false);
    }, 1500);
  }

  function onPhotoSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) {
      alert('Immagine troppo grande (max 2 MB).');
      return;
    }
    const r = new FileReader();
    r.onload = () => {
      setPhoto(typeof r.result === 'string' ? r.result : '');
    };
    r.readAsDataURL(f);
  }

  return (
    <div className={styles.form}>
      <div className={`${styles.section} ${styles.formWide}`}>
        <h2 className={styles.sectionTitle}>📷 Foto profilo</h2>
        <div className={styles.photoRow}>
          <div className={styles.photoPreview}>
            {photo ? (
              <img src={photo} alt="Foto profilo" />
            ) : (
              <div className={styles.photoPlaceholder}>
                {(profile.displayName.trim()[0] ?? '?').toUpperCase()}
              </div>
            )}
          </div>
          <div className={styles.photoActions}>
            <Button variant="solid" onClick={() => photoInputRef.current?.click()}>
              {photo ? 'Cambia foto' : 'Carica foto'}
            </Button>
            {photo && (
              <Button
                variant="ghost"
                onClick={() => {
                  setPhoto(null);
                }}
              >
                Rimuovi
              </Button>
            )}
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                onPhotoSelected(e);
              }}
            />
            <p className={styles.muted}>
              JPG/PNG, max 2 MB. Salvata localmente (base64 in localStorage). Usata come avatar
              accanto ai tuoi messaggi nella chat AI.
            </p>
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>👤 I tuoi dati</h2>
        <div className={styles.fieldStack}>
          <TextField
            label="Nome e cognome"
            value={profile.displayName}
            onChange={(e) => {
              setProfile({ ...profile, displayName: e.target.value });
            }}
            placeholder="Es. Nicola Cucurachi"
            fullWidth
          />
          <TextField
            label="Ruolo"
            value={profile.role}
            onChange={(e) => {
              setProfile({ ...profile, role: e.target.value });
            }}
            placeholder="Es. Titolare, Commerciale"
            fullWidth
          />
          <TextField
            label="Telefono"
            value={profile.phone}
            onChange={(e) => {
              setProfile({ ...profile, phone: e.target.value });
            }}
            placeholder="+39 ..."
            fullWidth
          />
          <TextField
            label="Sito web"
            value={profile.website}
            onChange={(e) => {
              setProfile({ ...profile, website: e.target.value });
            }}
            placeholder="https://..."
            fullWidth
          />
        </div>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>🎨 Aspetto</h2>
        <Select
          label="Tema"
          value={theme}
          onChange={(e) => {
            setTheme(e.target.value as ThemeMode);
          }}
          items={[
            { value: 'system', label: 'Automatico (segue il sistema)' },
            { value: 'light', label: 'Chiaro' },
            { value: 'dark', label: 'Scuro' },
            { value: 'hc', label: 'Alto contrasto' },
          ]}
          fullWidth
        />
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>🏢 Azienda (mittente)</h2>
        <div className={styles.fieldStack}>
          <TextField
            label="Ragione sociale"
            value={profile.organizationName}
            onChange={(e) => {
              setProfile({ ...profile, organizationName: e.target.value });
            }}
            placeholder="Es. ACME S.r.l."
            fullWidth
          />
          <TextField
            label="P. IVA / VAT"
            value={profile.vatNumber}
            onChange={(e) => {
              setProfile({ ...profile, vatNumber: e.target.value });
            }}
            placeholder="IT01234567890"
            fullWidth
          />
          <TextField
            label="Indirizzo"
            value={profile.address}
            onChange={(e) => {
              setProfile({ ...profile, address: e.target.value });
            }}
            placeholder="Via, Civico, CAP, Città, Stato"
            fullWidth
          />
        </div>
      </div>

      <div className={`${styles.section} ${styles.formWide}`}>
        <h2 className={styles.sectionTitle}>✍ Firma email (HTML supportato)</h2>
        <div className={styles.firmaGrid}>
          <label className={styles.textareaLabel}>
            <span>HTML sorgente</span>
            <textarea
              className={styles.textarea}
              rows={10}
              value={profile.emailSignature}
              onChange={(e) => {
                setProfile({ ...profile, emailSignature: e.target.value });
              }}
              placeholder={
                '<p><strong>Mario Rossi</strong><br/>Titolare — ACME S.r.l.<br/>+39 ...</p>'
              }
            />
          </label>
          <div className={styles.firmaPreviewCol}>
            <div className={styles.previewLabel}>Anteprima live</div>
            <iframe
              title="Anteprima firma"
              srcDoc={signaturePreviewHtml(profile.emailSignature)}
              sandbox=""
              className={styles.previewFrame}
            />
          </div>
        </div>
      </div>

      <div className={`${styles.section} ${styles.formWide}`}>
        <h2 className={styles.sectionTitle}>📝 Note personali (per l'AI)</h2>
        <textarea
          className={styles.textarea}
          rows={4}
          value={profile.notes}
          onChange={(e) => {
            setProfile({ ...profile, notes: e.target.value });
          }}
          placeholder="Note che l'AI può usare per personalizzare le risposte (es. tono formale/informale, settori che tratto, lingua principale dei clienti, ecc.)"
        />
      </div>

      <div className={`${styles.actions} ${styles.formWide}`}>
        <Button variant="solid" size="lg" onClick={save}>
          {saved ? '✓ Profilo salvato' : '💾 Salva profilo'}
        </Button>
      </div>

      <MaintenanceSection />
    </div>
  );
}

/* ───────────── CLAUDE IN ABBONAMENTO ───────────── */
/** Stato della CLI `claude` locale: è lei a portare l'abbonamento. */
function ClaudeCliStatusRow() {
  const [status, setStatus] = useState<ClaudeCliStatus | null>(null);

  useEffect(() => {
    aiApi
      .claudeCliStatus()
      .then(setStatus)
      .catch(() => {
        setStatus(null);
      });
  }, []);

  if (!status) return null;
  return (
    <p className={styles.muted} style={{ marginBlockStart: 'var(--space-2)' }}>
      {status.available ? '✓' : '○'} <strong>Claude (abbonamento)</strong>: {status.message}
      {status.version ? ` — ${status.version}` : ''}
      <br />
      Con questo provider i tool di Medea (posta, agenda, anagrafiche) passano dalla CLI via MCP:
      niente API key, nessun costo a token.
    </p>
  );
}

/* ───────────── MANUTENZIONE DATI ───────────── */
interface BusinessStats {
  importedOrganizations: number;
  articles: number;
  priceLists: number;
  priceListItems: number;
  discounts: number;
  priceOverrides: number;
  documents: number;
}

function MaintenanceSection() {
  const [stats, setStats] = useState<BusinessStats | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    invoke<BusinessStats>('db_business_data_stats')
      .then(setStats)
      .catch((e: unknown) => {
        setError(String(e));
      });
  }
  useEffect(() => {
    refresh();
  }, []);

  const total = stats
    ? stats.importedOrganizations +
      stats.articles +
      stats.priceLists +
      stats.priceListItems +
      stats.discounts +
      stats.priceOverrides +
      stats.documents
    : 0;

  async function purge() {
    setBusy(true);
    setError(null);
    try {
      const res = await invoke<Record<string, number>>('db_purge_business_data');
      const n = Object.values(res).reduce((s, v) => s + v, 0);
      setDone(`${n} record eliminati.`);
      setConfirming(false);
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!stats || total === 0) return null;

  return (
    <div className={`${styles.section} ${styles.formWide}`}>
      <h2 className={styles.sectionTitle}>🧹 Dati commerciali importati</h2>
      <p className={styles.muted}>
        Nel database ci sono ancora {stats.importedOrganizations} anagrafiche da import gestionale,{' '}
        {stats.articles} articoli, {stats.priceLists} listini ({stats.priceListItems} righe),{' '}
        {stats.discounts} sconti, {stats.priceOverrides} prezzi dedicati e {stats.documents}{' '}
        documenti. Svuotarli lascia intatte <strong>email, cartelle, account e rubrica</strong>:
        resta solo la struttura, pronta per i tuoi dati.
      </p>
      {done && <p className={styles.muted}>✓ {done}</p>}
      {error && <p className={styles.muted}>❌ {error}</p>}
      <div className={styles.actions}>
        {confirming ? (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Annulla
            </Button>
            <Button
              variant="solid"
              isLoading={busy}
              onClick={() => {
                void purge();
              }}
            >
              ⚠️ Confermo: elimina {total} record
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            onClick={() => {
              setConfirming(true);
            }}
          >
            🧹 Svuota i dati commerciali
          </Button>
        )}
      </div>
    </div>
  );
}

/* ───────────── ACCOUNT EMAIL ───────────── */
function AccountsTab({ activeId }: { activeId: string }) {
  const store = useAccountStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, { imap: boolean | string; smtp: boolean | string } | undefined>
  >({});
  const [renaming, setRenaming] = useState<MailAccount | null>(null);
  const [renameValue, setRenameValue] = useState('');

  async function testAccount(acc: MailAccount) {
    setTesting(acc.id);
    setTestResults({ ...testResults, [acc.id]: undefined });
    const out: { imap: boolean | string; smtp: boolean | string } = { imap: false, smtp: false };
    try {
      await mailApi.imap.test(acc.imap);
      out.imap = true;
    } catch (e) {
      out.imap = String(e);
    }
    try {
      await mailApi.smtp.test(acc.smtp);
      out.smtp = true;
    } catch (e) {
      out.smtp = String(e);
    }
    setTestResults({ ...testResults, [acc.id]: out });
    setTesting(null);
  }

  async function deleteAccount(acc: MailAccount) {
    if (
      !window.confirm(
        `Rimuovere l'account ${acc.emailAddress}? Le email scaricate restano nel DB locale finché non lo svuoti dal DB Studio.`,
      )
    )
      return;
    await store.removeAccount(acc.id);
  }

  function startRename(acc: MailAccount) {
    setRenaming(acc);
    setRenameValue(acc.displayName);
  }
  async function saveRename() {
    if (!renaming) return;
    await store.updateAccount(renaming.id, {
      displayName: renameValue.trim() || renaming.emailAddress,
    });
    setRenaming(null);
  }

  if (adding) {
    return (
      <div>
        <div className={styles.accountsHead}>
          <Button
            variant="ghost"
            onClick={() => {
              setAdding(false);
            }}
          >
            ← Indietro
          </Button>
        </div>
        <AccountSetup
          onSaved={(acc) => {
            void (async () => {
              await store.addAccount(acc);
              try {
                await mailApi.db.accountUpsert(acc);
              } catch (e) {
                console.error(e);
              }
              setAdding(false);
            })();
          }}
        />
      </div>
    );
  }

  if (editingId) {
    const acc = store.accounts.find((a) => a.id === editingId);
    if (!acc) {
      setEditingId(null);
      return null;
    }
    return (
      <AccountEditor
        account={acc}
        onSave={async (patched) => {
          await store.updateAccount(acc.id, patched);
          try {
            await mailApi.db.accountUpsert({ ...acc, ...patched });
          } catch (e) {
            console.error(e);
          }
          setEditingId(null);
        }}
        onCancel={() => {
          setEditingId(null);
        }}
      />
    );
  }

  return (
    <div className={styles.form}>
      <div className={`${styles.section} ${styles.formWide}`}>
        <div className={styles.accountsHead}>
          <h2 className={styles.sectionTitle}>📧 Account configurati ({store.accounts.length})</h2>
          <Button
            variant="solid"
            onClick={() => {
              setAdding(true);
            }}
          >
            + Aggiungi account
          </Button>
        </div>
        <div className={styles.accountsList}>
          {store.accounts.map((a) => {
            const isActive = a.id === activeId;
            const res = testResults[a.id];
            return (
              <article
                key={a.id}
                className={`${styles.accountCard} ${isActive ? styles.accountActive : ''}`}
              >
                <header className={styles.accountCardHead}>
                  <div className={styles.accountIcon}>
                    {(a.displayName.trim()[0] ?? a.emailAddress[0] ?? '?').toUpperCase()}
                  </div>
                  <div className={styles.accountCardInfo}>
                    <div className={styles.accountCardName}>
                      {a.displayName}
                      {isActive && <span className={styles.activeBadge}>Attivo</span>}
                    </div>
                    <div className={styles.accountCardEmail}>{a.emailAddress}</div>
                  </div>
                </header>
                <dl className={styles.accountCardData}>
                  <div>
                    <dt>IMAP</dt>
                    <dd>
                      <code>
                        {a.imap.host}:{a.imap.port}
                      </code>{' '}
                      · user: {a.imap.username}
                    </dd>
                  </div>
                  <div>
                    <dt>SMTP</dt>
                    <dd>
                      <code>
                        {a.smtp.host}:{a.smtp.port}
                      </code>{' '}
                      · user: {a.smtp.username} ·{' '}
                      {a.smtp.implicitTls ? 'TLS implicito' : 'STARTTLS'}
                    </dd>
                  </div>
                </dl>
                {res && (
                  <div className={styles.testResult}>
                    <span className={res.imap === true ? styles.testOk : styles.testKo}>
                      IMAP: {res.imap === true ? '✓ OK' : `✗ ${String(res.imap)}`}
                    </span>
                    <span className={res.smtp === true ? styles.testOk : styles.testKo}>
                      SMTP: {res.smtp === true ? '✓ OK' : `✗ ${String(res.smtp)}`}
                    </span>
                  </div>
                )}
                <div className={styles.accountCardActions}>
                  {!isActive && (
                    <Button variant="solid" size="sm" onClick={() => void store.setActive(a.id)}>
                      Imposta attivo
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void testAccount(a)}
                    isLoading={testing === a.id}
                  >
                    Test connessione
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditingId(a.id);
                    }}
                  >
                    Modifica server/credenziali
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      startRename(a);
                    }}
                  >
                    Rinomina
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void deleteAccount(a)}>
                    Rimuovi
                  </Button>
                </div>
              </article>
            );
          })}
          {store.accounts.length === 0 && (
            <div className={styles.emptyAccounts}>
              <p>Nessun account configurato.</p>
              <Button
                variant="solid"
                onClick={() => {
                  setAdding(true);
                }}
              >
                + Aggiungi il primo
              </Button>
            </div>
          )}
        </div>
      </div>

      <Dialog
        open={renaming !== null}
        onClose={() => {
          setRenaming(null);
        }}
        title="Rinomina account"
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setRenaming(null);
              }}
            >
              Annulla
            </Button>
            <Button variant="solid" onClick={() => void saveRename()}>
              Salva
            </Button>
          </>
        }
      >
        <TextField
          label="Nome visualizzato"
          value={renameValue}
          onChange={(e) => {
            setRenameValue(e.target.value);
          }}
          placeholder="Es. Mario Rossi — ACME S.r.l."
          fullWidth
        />
      </Dialog>
    </div>
  );
}

/* ───────────── ACCOUNT EDITOR (modifica server/credenziali) ───────────── */
function AccountEditor({
  account,
  onSave,
  onCancel,
}: {
  account: MailAccount;
  onSave: (patch: Partial<MailAccount>) => Promise<void>;
  onCancel: () => void;
}) {
  const [displayName, setDisplayName] = useState(account.displayName);
  const [imapHost, setImapHost] = useState(account.imap.host);
  const [imapPort, setImapPort] = useState(String(account.imap.port));
  const [imapUser, setImapUser] = useState(account.imap.username);
  const [imapPassword, setImapPassword] = useState(account.imap.password);
  const [smtpHost, setSmtpHost] = useState(account.smtp.host);
  const [smtpPort, setSmtpPort] = useState(String(account.smtp.port));
  const [smtpUser, setSmtpUser] = useState(account.smtp.username);
  const [smtpPassword, setSmtpPassword] = useState(account.smtp.password);
  const [smtpImplicitTls, setSmtpImplicitTls] = useState(account.smtp.implicitTls ?? false);
  const [showImapPwd, setShowImapPwd] = useState(false);
  const [showSmtpPwd, setShowSmtpPwd] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState<null | 'imap' | 'smtp' | 'save'>(null);

  function buildPatch(): Partial<MailAccount> {
    return {
      displayName: displayName.trim(),
      imap: {
        ...account.imap,
        host: imapHost.trim(),
        port: Number.parseInt(imapPort, 10) || 993,
        username: imapUser.trim(),
        password: imapPassword,
      },
      smtp: {
        ...account.smtp,
        host: smtpHost.trim(),
        port: Number.parseInt(smtpPort, 10) || 587,
        username: smtpUser.trim(),
        password: smtpPassword,
        implicitTls: smtpImplicitTls,
      },
    };
  }

  async function testImap() {
    setBusy('imap');
    setStatus({ kind: 'info', text: `Test IMAP su ${imapHost}:${imapPort}…` });
    try {
      await mailApi.imap.test({
        host: imapHost.trim(),
        port: Number.parseInt(imapPort, 10) || 993,
        username: imapUser.trim(),
        password: imapPassword,
      });
      setStatus({ kind: 'ok', text: '✓ IMAP OK' });
    } catch (e) {
      setStatus({ kind: 'err', text: `✗ IMAP: ${String(e)}` });
    } finally {
      setBusy(null);
    }
  }

  async function testSmtp() {
    setBusy('smtp');
    setStatus({ kind: 'info', text: `Test SMTP su ${smtpHost}:${smtpPort}…` });
    try {
      await mailApi.smtp.test({
        host: smtpHost.trim(),
        port: Number.parseInt(smtpPort, 10) || 587,
        username: smtpUser.trim(),
        password: smtpPassword,
        implicitTls: smtpImplicitTls,
      });
      setStatus({ kind: 'ok', text: '✓ SMTP OK' });
    } catch (e) {
      setStatus({ kind: 'err', text: `✗ SMTP: ${String(e)}` });
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy('save');
    try {
      await onSave(buildPatch());
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.form}>
      <div className={`${styles.section} ${styles.formWide}`}>
        <div className={styles.accountsHead}>
          <h2 className={styles.sectionTitle}>Modifica account {account.emailAddress}</h2>
          <Button variant="ghost" onClick={onCancel}>
            ← Annulla
          </Button>
        </div>
        <div className={styles.fieldStack}>
          <TextField
            label="Nome visualizzato"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
            }}
            placeholder="Es. Mario Rossi — ACME S.r.l."
            hint="Verrà mostrato come 'Da:' nelle email che invii."
            fullWidth
          />
        </div>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>📥 IMAP (ricezione)</h2>
        <div className={styles.fieldStack}>
          <TextField
            label="Host"
            value={imapHost}
            onChange={(e) => {
              setImapHost(e.target.value);
            }}
            fullWidth
          />
          <TextField
            label="Porta"
            value={imapPort}
            onChange={(e) => {
              setImapPort(e.target.value);
            }}
            inputMode="numeric"
          />
          <TextField
            label="Username"
            value={imapUser}
            onChange={(e) => {
              setImapUser(e.target.value);
            }}
            fullWidth
          />
          <div className={styles.pwdRow}>
            <TextField
              label="Password"
              type={showImapPwd ? 'text' : 'password'}
              value={imapPassword}
              onChange={(e) => {
                setImapPassword(e.target.value);
              }}
              fullWidth
            />
            <button
              type="button"
              className={styles.eyeBtn}
              onClick={() => {
                setShowImapPwd(!showImapPwd);
              }}
              aria-label="Mostra/nascondi"
            >
              {showImapPwd ? '🙈' : '👁'}
            </button>
          </div>
          <Button variant="outline" onClick={() => void testImap()} isLoading={busy === 'imap'}>
            Testa connessione IMAP
          </Button>
        </div>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>📤 SMTP (invio)</h2>
        <div className={styles.fieldStack}>
          <TextField
            label="Host"
            value={smtpHost}
            onChange={(e) => {
              setSmtpHost(e.target.value);
            }}
            fullWidth
          />
          <TextField
            label="Porta"
            value={smtpPort}
            onChange={(e) => {
              setSmtpPort(e.target.value);
            }}
            inputMode="numeric"
          />
          <TextField
            label="Username"
            value={smtpUser}
            onChange={(e) => {
              setSmtpUser(e.target.value);
            }}
            fullWidth
          />
          <div className={styles.pwdRow}>
            <TextField
              label="Password"
              type={showSmtpPwd ? 'text' : 'password'}
              value={smtpPassword}
              onChange={(e) => {
                setSmtpPassword(e.target.value);
              }}
              fullWidth
            />
            <button
              type="button"
              className={styles.eyeBtn}
              onClick={() => {
                setShowSmtpPwd(!showSmtpPwd);
              }}
              aria-label="Mostra/nascondi"
            >
              {showSmtpPwd ? '🙈' : '👁'}
            </button>
          </div>
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={smtpImplicitTls}
              onChange={(e) => {
                setSmtpImplicitTls(e.target.checked);
              }}
            />{' '}
            TLS implicito (porta 465). Disattiva per STARTTLS (587).
          </label>
          <Button variant="outline" onClick={() => void testSmtp()} isLoading={busy === 'smtp'}>
            Testa connessione SMTP
          </Button>
        </div>
      </div>

      {status && (
        <div className={`${styles.formWide} ${styles.testResult}`}>
          <span
            className={
              status.kind === 'ok'
                ? styles.testOk
                : status.kind === 'err'
                  ? styles.testKo
                  : styles.testInfo
            }
          >
            {status.text}
          </span>
        </div>
      )}

      <div className={`${styles.actions} ${styles.formWide}`}>
        <Button variant="ghost" onClick={onCancel}>
          Annulla
        </Button>
        <Button variant="solid" size="lg" onClick={() => void save()} isLoading={busy === 'save'}>
          💾 Salva modifiche
        </Button>
      </div>
    </div>
  );
}

/* ───────────── AI KEYS (BYOK) ───────────── */
function AiKeysTab() {
  const [defaultProvider, setDefaultProvider] = useState<ProviderId>(
    () => (localStorage.getItem(DEFAULT_PROVIDER_KEY) as ProviderId | null) ?? 'liara',
  );
  const [keys, setKeys] = useState<Record<ProviderId, string>>(() => {
    const out: Record<string, string> = {};
    for (const p of PROVIDERS) out[p] = '';
    return out;
  });
  const [showKey, setShowKey] = useState<Record<ProviderId, boolean>>(() => {
    const out: Record<string, boolean> = {};
    for (const p of PROVIDERS) out[p] = false;
    return out;
  });
  const [saved, setSaved] = useState<ProviderId | null>(null);
  const [customBaseUrl, setCustomBaseUrl] = useState(
    () => localStorage.getItem(CUSTOM_BASE_URL_KEY) ?? '',
  );
  const [customModel, setCustomModel] = useState(
    () => localStorage.getItem(CUSTOM_MODEL_KEY) ?? '',
  );

  // Carica le chiavi dal keychain OS (con migrazione dal vecchio localStorage).
  useEffect(() => {
    void (async () => {
      const out: Record<string, string> = {};
      for (const p of PROVIDERS) out[p] = await getApiKey(p);
      setKeys(out);
    })();
  }, []);

  useEffect(() => {
    localStorage.setItem(DEFAULT_PROVIDER_KEY, defaultProvider);
  }, [defaultProvider]);

  async function saveKey(provider: ProviderId) {
    await setApiKey(provider, keys[provider]);
    setSaved(provider);
    setTimeout(() => {
      setSaved(null);
    }, 1200);
  }

  function saveCustomConfig() {
    const url = customBaseUrl.trim();
    const model = customModel.trim();
    if (url) localStorage.setItem(CUSTOM_BASE_URL_KEY, url);
    else localStorage.removeItem(CUSTOM_BASE_URL_KEY);
    if (model) localStorage.setItem(CUSTOM_MODEL_KEY, model);
    else localStorage.removeItem(CUSTOM_MODEL_KEY);
  }

  return (
    <div className={styles.form}>
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>🎯 Provider di default</h2>
        <Select
          label="Modello attivo"
          value={defaultProvider}
          onChange={(e) => {
            setDefaultProvider(e.target.value as ProviderId);
          }}
          items={PROVIDERS.map((p) => ({ value: p, label: providerLong(p) }))}
          fullWidth
        />
        <p className={styles.muted} style={{ marginBlockStart: 'var(--space-2)' }}>
          Modello BYOK (bring-your-own-key): ogni provider usa la TUA chiave. Nessun servizio è
          preconfigurato.
        </p>
        <ClaudeCliStatusRow />
      </div>

      <div className={`${styles.section} ${styles.formWide}`}>
        <h2 className={styles.sectionTitle}>🛠 Endpoint personalizzato (OpenAI-compatibile)</h2>
        <div className={styles.fieldStack}>
          <TextField
            label="Base URL"
            value={customBaseUrl}
            onChange={(e) => {
              setCustomBaseUrl(e.target.value);
            }}
            placeholder="https://miohost.example.com/v1"
            fullWidth
          />
          <TextField
            label="Nome modello"
            value={customModel}
            onChange={(e) => {
              setCustomModel(e.target.value);
            }}
            placeholder="es. nome-modello-servito"
            fullWidth
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              saveCustomConfig();
            }}
          >
            Salva endpoint
          </Button>
        </div>
        <p className={styles.muted} style={{ marginBlockStart: 'var(--space-2)' }}>
          Per vLLM, gateway privati o qualsiasi server che espone
          <code> /chat/completions</code>. La API key (se serve) va inserita qui sotto nella riga
          «Endpoint personalizzato».
        </p>
      </div>

      <div className={`${styles.section} ${styles.formWide}`}>
        <h2 className={styles.sectionTitle}>🔑 API keys</h2>
        <div className={styles.keysList}>
          {PROVIDERS.filter(providerNeedsApiKey).map((p) => (
            <div key={p} className={styles.keyRow}>
              <div className={styles.keyLabel}>{providerLong(p)}</div>
              <div className={styles.keyInputWrap}>
                <input
                  type={showKey[p] ? 'text' : 'password'}
                  value={keys[p]}
                  onChange={(e) => {
                    setKeys({ ...keys, [p]: e.target.value });
                  }}
                  placeholder={`Inserisci la tua API key per ${p}`}
                  autoComplete="off"
                  spellCheck={false}
                  className={styles.keyInput}
                />
                <button
                  type="button"
                  className={styles.eyeBtn}
                  onClick={() => {
                    setShowKey({ ...showKey, [p]: !showKey[p] });
                  }}
                  aria-label={showKey[p] ? 'Nascondi' : 'Mostra'}
                >
                  {showKey[p] ? '🙈' : '👁'}
                </button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void saveKey(p);
                  }}
                >
                  {saved === p ? '✓ Salvata' : 'Salva'}
                </Button>
              </div>
            </div>
          ))}
        </div>
        <p className={styles.muted} style={{ marginBlockStart: 'var(--space-3)' }}>
          Le chiavi sono salvate nel portachiavi di sistema (macOS Keychain / Windows Credential
          Manager / Secret Service), mai in chiaro su disco.
        </p>
      </div>
    </div>
  );
}
