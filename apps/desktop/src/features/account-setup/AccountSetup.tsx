import { Button, Select, TextField } from '@medea/ui';
import { useState } from 'react';


import { mailApi } from '../mail/api';
import type { MailAccount } from '../mail/types';

import styles from './AccountSetup.module.css';

type Preset = 'gmail' | 'outlook' | 'icloud' | 'yahoo' | 'aruba' | 'libero' | 'custom';

interface PresetConfig {
  label: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  smtpImplicitTls: boolean;
  hint?: string;
}

const PRESETS: Record<Preset, PresetConfig> = {
  gmail: {
    label: 'Gmail / Google Workspace',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    smtpImplicitTls: true,
    hint: 'Richiede una App Password (Account Google → Sicurezza → Verifica in 2 passaggi → Password per le app). Non funziona con la password normale.',
  },
  outlook: {
    label: 'Outlook / Microsoft 365',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    smtpImplicitTls: false,
    hint: 'Outlook spesso richiede OAuth (in arrivo in Fase 4). Per ora alcuni account funzionano con App Password.',
  },
  icloud: {
    label: 'iCloud Mail',
    imapHost: 'imap.mail.me.com',
    imapPort: 993,
    smtpHost: 'smtp.mail.me.com',
    smtpPort: 587,
    smtpImplicitTls: false,
    hint: 'Richiede una password specifica per app generata su appleid.apple.com → Accesso e sicurezza.',
  },
  yahoo: {
    label: 'Yahoo Mail',
    imapHost: 'imap.mail.yahoo.com',
    imapPort: 993,
    smtpHost: 'smtp.mail.yahoo.com',
    smtpPort: 465,
    smtpImplicitTls: true,
    hint: 'Richiede una password app generata nelle impostazioni di sicurezza Yahoo.',
  },
  aruba: {
    label: 'Aruba',
    imapHost: 'imaps.aruba.it',
    imapPort: 993,
    smtpHost: 'smtps.aruba.it',
    smtpPort: 465,
    smtpImplicitTls: true,
  },
  libero: {
    label: 'Libero / Virgilio',
    imapHost: 'imapmail.libero.it',
    imapPort: 993,
    smtpHost: 'smtp.libero.it',
    smtpPort: 465,
    smtpImplicitTls: true,
  },
  custom: {
    label: 'Personalizzato (server tuo / aziendale)',
    imapHost: '',
    imapPort: 993,
    smtpHost: '',
    smtpPort: 587,
    smtpImplicitTls: false,
    hint: "Inserisci host/porta esatti del tuo provider. IMAP standard: 993 (TLS). SMTP standard: 587 (STARTTLS) o 465 (implicit TLS).",
  },
};

interface Props {
  onSaved: (acc: MailAccount) => void;
  /** Se fornito, mostra un bottone «← Indietro» che chiama questa callback. */
  onCancel?: () => void;
}

export function AccountSetup({ onSaved, onCancel }: Props) {
  const [preset, setPreset] = useState<Preset>('gmail');
  const [displayName, setDisplayName] = useState('');
  const [emailAddress, setEmailAddress] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [imapHost, setImapHost] = useState(PRESETS.gmail.imapHost);
  const [imapPort, setImapPort] = useState(String(PRESETS.gmail.imapPort));
  const [smtpHost, setSmtpHost] = useState(PRESETS.gmail.smtpHost);
  const [smtpPort, setSmtpPort] = useState(String(PRESETS.gmail.smtpPort));
  const [smtpImplicitTls, setSmtpImplicitTls] = useState(PRESETS.gmail.smtpImplicitTls);
  const [acceptInvalidCerts, setAcceptInvalidCerts] = useState(false);
  const [busy, setBusy] = useState<null | 'testing-imap' | 'testing-smtp' | 'saving'>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);

  function applyPreset(p: Preset) {
    setPreset(p);
    const c = PRESETS[p];
    setImapHost(c.imapHost);
    setImapPort(String(c.imapPort));
    setSmtpHost(c.smtpHost);
    setSmtpPort(String(c.smtpPort));
    setSmtpImplicitTls(c.smtpImplicitTls);
  }

  function buildAccount(): MailAccount {
    const loginName = username.trim() || emailAddress.trim();
    return {
      id: `acc-${Date.now().toString(36)}`,
      displayName: displayName.trim() || emailAddress,
      emailAddress: emailAddress.trim(),
      imap: {
        host: imapHost.trim(),
        port: Number.parseInt(imapPort, 10) || 993,
        username: loginName,
        password,
        secure: true,
        acceptInvalidCerts,
      },
      smtp: {
        host: smtpHost.trim(),
        port: Number.parseInt(smtpPort, 10) || 587,
        username: loginName,
        password,
        implicitTls: smtpImplicitTls,
        acceptInvalidCerts,
      },
      defaultFolder: 'INBOX',
      createdAt: new Date().toISOString(),
    };
  }

  function validate(): string | null {
    if (!emailAddress.includes('@')) return "Inserisci un indirizzo email valido.";
    if (password.length === 0) return 'Inserisci la password.';
    if (imapHost.trim().length === 0) return "Manca l'host IMAP.";
    if (smtpHost.trim().length === 0) return "Manca l'host SMTP.";
    if (!Number.isInteger(Number.parseInt(imapPort, 10))) return 'Porta IMAP non valida.';
    if (!Number.isInteger(Number.parseInt(smtpPort, 10))) return 'Porta SMTP non valida.';
    return null;
  }

  async function testImap() {
    const v = validate();
    if (v) { setStatus({ kind: 'err', text: v }); return; }
    setBusy('testing-imap');
    const acc = buildAccount();
    setStatus({
      kind: 'info',
      text: `Connessione IMAP a ${acc.imap.host}:${String(acc.imap.port)} come ${acc.imap.username}…`,
    });
    try {
      await mailApi.imap.test(acc.imap);
      setStatus({ kind: 'ok', text: `IMAP OK su ${acc.imap.host}:${String(acc.imap.port)}.` });
    } catch (e) {
      setStatus({ kind: 'err', text: `IMAP fallito: ${String(e)}` });
    } finally {
      setBusy(null);
    }
  }

  async function testSmtp() {
    const v = validate();
    if (v) { setStatus({ kind: 'err', text: v }); return; }
    setBusy('testing-smtp');
    const acc = buildAccount();
    setStatus({
      kind: 'info',
      text: `Connessione SMTP a ${acc.smtp.host}:${String(acc.smtp.port)} come ${acc.smtp.username}…`,
    });
    try {
      await mailApi.smtp.test(acc.smtp);
      setStatus({ kind: 'ok', text: `SMTP OK su ${acc.smtp.host}:${String(acc.smtp.port)}.` });
    } catch (e) {
      setStatus({ kind: 'err', text: `SMTP fallito: ${String(e)}` });
    } finally {
      setBusy(null);
    }
  }

  async function saveAndContinue() {
    setBusy('saving');
    setStatus({ kind: 'info', text: 'Verifica IMAP prima di salvare…' });
    try {
      const acc = buildAccount();
      await mailApi.imap.test(acc.imap);
      setStatus({ kind: 'ok', text: 'Account salvato. Apro la posta…' });
      onSaved(acc);
    } catch (e) {
      setStatus({ kind: 'err', text: `IMAP fallito, account NON salvato: ${String(e)}` });
    } finally {
      setBusy(null);
    }
  }

  const presetHint = PRESETS[preset].hint;
  const canSave =
    emailAddress.includes('@') && password.length > 0 && imapHost.length > 0 && smtpHost.length > 0;

  return (
    <main className={styles.shell}>
      <section className={styles.card} aria-labelledby="setup-title">
        <header className={styles.header}>
          <span className={styles.glyph} aria-hidden>
            M
          </span>
          <div style={{ flex: 1 }}>
            <h1 id="setup-title" className={styles.title}>
              Aggiungi il tuo account email
            </h1>
            <p className={styles.subtitle}>
              IMAP è strettamente <strong>read-only</strong>: Medea non cancellerà mai nessun
              messaggio dal server.
            </p>
          </div>
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              ← Indietro
            </Button>
          )}
        </header>

        <div className={styles.grid}>
          <Select
            label="Provider"
            value={preset}
            onChange={(e) => { applyPreset(e.target.value as Preset); }}
            items={(Object.keys(PRESETS) as Preset[]).map((k) => ({
              value: k,
              label: PRESETS[k].label,
            }))}
            fullWidth
          />

          {presetHint && <p className={styles.hint}>{presetHint}</p>}

          <TextField
            label="Nome visualizzato"
            placeholder="Es. Mario Rossi — ACME S.r.l."
            value={displayName}
            onChange={(e) => { setDisplayName(e.target.value); }}
            fullWidth
          />

          <TextField
            label="Indirizzo email"
            type="email"
            placeholder="nome.cognome@dominio.it"
            value={emailAddress}
            onChange={(e) => { setEmailAddress(e.target.value); }}
            autoComplete="email"
            hint="È l'indirizzo che apparirà come 'Da:' nelle email che invii."
            fullWidth
          />

          <TextField
            label="Username (se diverso dall'email)"
            placeholder="Lascia vuoto se l'username è l'email stessa"
            value={username}
            onChange={(e) => { setUsername(e.target.value); }}
            autoComplete="username"
            hint="Alcuni provider aziendali / Exchange / hosting richiedono uno username diverso dall'indirizzo email (es. 'n.cucurachi' invece di 'n.cucurachi@dominio.it'). Lascia vuoto se non sei sicuro — verrà usata l'email."
            fullWidth
          />

          <TextField
            label="Password"
            type="password"
            placeholder="Password account (o App Password)"
            value={password}
            onChange={(e) => { setPassword(e.target.value); }}
            autoComplete="current-password"
            hint="Cifrata localmente (AES-GCM) prima di essere salvata. Mai inviata altrove."
            fullWidth
          />

          <div className={styles.subtitleBar}>Server IMAP (lettura)</div>
          <div className={styles.row}>
            <TextField
              label="Host IMAP"
              value={imapHost}
              onChange={(e) => { setImapHost(e.target.value); }}
              fullWidth
            />
            <TextField
              label="Porta"
              value={imapPort}
              onChange={(e) => { setImapPort(e.target.value); }}
              inputMode="numeric"
            />
          </div>

          <div className={styles.subtitleBar}>Server SMTP (invio)</div>
          <div className={styles.row}>
            <TextField
              label="Host SMTP"
              value={smtpHost}
              onChange={(e) => { setSmtpHost(e.target.value); }}
              fullWidth
            />
            <TextField
              label="Porta"
              value={smtpPort}
              onChange={(e) => { setSmtpPort(e.target.value); }}
              inputMode="numeric"
            />
          </div>

          <div className={styles.row}>
            <label className={styles.checkLabel}>
              <input
                type="checkbox"
                checked={smtpImplicitTls}
                onChange={(e) => { setSmtpImplicitTls(e.target.checked); }}
              />{' '}
              SMTP usa TLS implicito (porta 465). Lascia disattivato per STARTTLS (587).
            </label>
          </div>

          <div className={styles.row}>
            <label className={styles.checkLabel}>
              <input
                type="checkbox"
                checked={acceptInvalidCerts}
                onChange={(e) => { setAcceptInvalidCerts(e.target.checked); }}
              />{' '}
              Accetta certificati self-signed (solo server interni, sconsigliato).
            </label>
          </div>
        </div>

        {status && (
          <div
            className={`${styles.status} ${
              status.kind === 'ok' ? styles.ok : status.kind === 'err' ? styles.err : styles.info
            }`}
            role="status"
          >
            {status.text}
          </div>
        )}

        <div className={styles.actions}>
          <Button variant="outline" onClick={testImap} isLoading={busy === 'testing-imap'}>
            Testa IMAP
          </Button>
          <Button variant="outline" onClick={testSmtp} isLoading={busy === 'testing-smtp'}>
            Testa SMTP
          </Button>
          <Button
            variant="solid"
            onClick={saveAndContinue}
            isDisabled={!canSave}
            isLoading={busy === 'saving'}
          >
            Salva e apri la posta
          </Button>
        </div>
      </section>
    </main>
  );
}
