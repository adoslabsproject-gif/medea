import { Button, Dialog, TextField } from '@medea/ui';
import { useEffect, useState } from 'react';


import { applyTemplate, htmlToText, templateApi, textToHtml } from '../../email-template';
import type { EmailTemplate, SenderInfo } from '../../email-template';
import { sendAndArchive } from '../send';
import type { MailAccount } from '../types';

import styles from './Composer.module.css';

export type ComposerMode = 'new' | 'reply' | 'replyAll' | 'forward';

export interface ComposerPrefill {
  mode: ComposerMode;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  inReplyTo: string | null;
  references: string[];
}

interface Props {
  account: MailAccount;
  prefill: ComposerPrefill | null;
  onClose: () => void;
}

const MODE_TITLES: Record<ComposerMode, string> = {
  new: 'Nuovo messaggio',
  reply: 'Rispondi',
  replyAll: 'Rispondi a tutti',
  forward: 'Inoltra',
};

/** Dati mittente per template e firma (Impostazioni → Profilo). */
function readSender(account: MailAccount): SenderInfo {
  try {
    const raw = localStorage.getItem('medea.profile.v2');
    const p = raw
      ? (JSON.parse(raw) as { displayName?: string; organizationName?: string; emailSignature?: string })
      : {};
    const name = p.displayName?.trim() ?? '';
    return {
      displayName: name.length > 0 ? name : account.displayName,
      organizationName: p.organizationName?.trim() ?? '',
      emailAddress: account.emailAddress,
      signatureHtml: p.emailSignature?.trim() ?? '',
    };
  } catch {
    return {
      displayName: account.displayName,
      organizationName: '',
      emailAddress: account.emailAddress,
      signatureHtml: '',
    };
  }
}

export function Composer({ account, prefill, onClose }: Props) {
  const [to, setTo] = useState(prefill?.to ?? '');
  const [cc, setCc] = useState(prefill?.cc ?? '');
  const [subject, setSubject] = useState(prefill?.subject ?? '');
  const [body, setBody] = useState(prefill?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [template, setTemplate] = useState<EmailTemplate | null>(null);
  const [useTemplate, setUseTemplate] = useState(true);

  useEffect(() => {
    templateApi.getDefault()
      .then(setTemplate)
      .catch((e: unknown) => { console.warn('[Medea] template non caricato:', e); });
  }, []);

  async function send() {
    setBusy(true);
    setStatus(null);
    try {
      const sender = readSender(account);
      const bodyHtml = applyTemplate(useTemplate ? template : null, textToHtml(body), sender);
      // La parte text/plain resta leggibile per i client che non rendono HTML.
      const bodyText = htmlToText(bodyHtml);
      const archive = await sendAndArchive(account, {
        fromName: account.displayName,
        fromAddress: account.emailAddress,
        to: to.split(',').map((s) => s.trim()).filter(Boolean),
        cc: cc.split(',').map((s) => s.trim()).filter(Boolean),
        subject,
        bodyText,
        bodyHtml,
        inReplyTo: prefill?.inReplyTo ?? null,
        references: prefill?.references ?? [],
      });
      setStatus({
        kind: 'ok',
        text: archive.ok
          ? `Email inviata e archiviata in «${archive.folder ?? ''}».`
          : 'Email inviata — copia in Inviati NON archiviata (cartella non trovata).',
      });
      setTimeout(onClose, 900);
    } catch (e) {
      setStatus({ kind: 'err', text: `Invio fallito: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  const canSend = to.includes('@') && subject.length > 0 && body.length > 0;
  const title = MODE_TITLES[prefill?.mode ?? 'new'];

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={`Da: ${account.displayName} <${account.emailAddress}>`}
      size="lg"
      closeOnBackdropClick={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Chiudi
          </Button>
          <Button variant="solid" onClick={send} isDisabled={!canSend} isLoading={busy}>
            Invia
          </Button>
        </>
      }
    >
      <div className={styles.fields}>
        <TextField
          label="A"
          placeholder="destinatario@example.com (più indirizzi separati da virgola)"
          value={to}
          onChange={(e) => { setTo(e.target.value); }}
          fullWidth
        />
        <TextField
          label="Cc"
          placeholder="opzionale, separati da virgola"
          value={cc}
          onChange={(e) => { setCc(e.target.value); }}
          fullWidth
        />
        <TextField
          label="Oggetto"
          value={subject}
          onChange={(e) => { setSubject(e.target.value); }}
          fullWidth
        />
        <label className={styles.bodyLabel}>
          Messaggio
          <textarea
            className={styles.body}
            rows={14}
            value={body}
            onChange={(e) => { setBody(e.target.value); }}
            placeholder="Scrivi qui il testo dell'email…"
          />
        </label>

        {template && (
          <label className={styles.templateToggle}>
            <input
              type="checkbox"
              checked={useTemplate}
              onChange={(e) => { setUseTemplate(e.target.checked); }}
            />{' '}
            Applica la carta intestata «{template.name}»
          </label>
        )}

        {status && (
          <div className={`${styles.status} ${status.kind === 'ok' ? styles.ok : styles.err}`}>
            {status.text}
          </div>
        )}
      </div>
    </Dialog>
  );
}
