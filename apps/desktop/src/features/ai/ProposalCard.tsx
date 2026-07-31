import { useEffect, useRef, useState } from 'react';

import { saveDraftSmart, sendAndArchive } from '../mail/send';
import type { MailAccount } from '../mail/types';

import styles from './ProposalCard.module.css';
import type { Proposal, ProposalExecution } from './store/conversations';

interface Props {
  proposal: Proposal;
  account: MailAccount;
  /** Esito già registrato — se presente, la card mostra direttamente la
   *  conferma e non il form. */
  execution?: ProposalExecution;
  /** Callback per persistere l'esito dell'azione nella conversation. */
  onExecuted?: (execution: ProposalExecution) => void;
}

export function ProposalCard({ proposal, account, execution, onExecuted }: Props) {
  if (proposal.type === 'compose_draft') {
    return (
      <ComposeDraftCard
        proposal={proposal}
        account={account}
        {...(execution ? { execution } : {})}
        {...(onExecuted ? { onExecuted } : {})}
      />
    );
  }
  if (proposal.type === 'compose_html') {
    return <HtmlDocCard proposal={proposal} account={account} />;
  }
  return null;
}

interface HtmlProps {
  proposal: Extract<Proposal, { type: 'compose_html' }>;
  account: MailAccount;
}

const DOC_KIND_LABEL: Record<string, string> = {
  quote: '💬 Offerta',
  order_confirm: "✅ Conferma d'ordine",
  letter: '✉️ Lettera',
  report: '📊 Report',
  communication: '📨 Comunicazione',
  other: '📄 Documento',
};

/** Cap conservativo lato render: il WebKit di Tauri può crashare quando l'iframe
 *  srcDoc è troppo grande. Se più grande, mostriamo un placeholder testuale
 *  con bottoni Salva/Apri esterno, niente iframe attivo. */
const IFRAME_RENDER_CAP = 80_000;

function HtmlDocCard({ proposal, account: _account }: HtmlProps) {
  const d = proposal.document;
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [composing, setComposing] = useState<{ subject: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFullPreview, setShowFullPreview] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const htmlSize = d.html.length;
  const tooBig = htmlSize > IFRAME_RENDER_CAP;

  /** Salva l'HTML su disco e lo apre nel browser di sistema (Safari/Chrome/Edge/Firefox),
   *  dove la stampa in PDF funziona nativamente con il dialog OS. Cross-platform. */
  async function handlePrint() {
    try {
      setError(null);
      const { downloadDir, join } = await import('@tauri-apps/api/path');
      const { invoke } = await import('@tauri-apps/api/core');
      const path = await join(await downloadDir(), 'Medea', 'documents', d.suggestedFilename);
      const written = await invoke<string>('save_text_file', { destPath: path, content: d.html });
      await invoke('open_path_in_default_app', { path: written });
      setSavedTo(written);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleSaveHtml() {
    try {
      const { downloadDir, join } = await import('@tauri-apps/api/path');
      const { invoke } = await import('@tauri-apps/api/core');
      const path = await join(await downloadDir(), 'Medea', 'documents', d.suggestedFilename);
      const written = await invoke<string>('save_text_file', { destPath: path, content: d.html });
      setSavedTo(written);
    } catch (e) {
      setError(String(e));
    }
  }

  function handleAttachToEmail() {
    // Estrae una versione plain-text approssimativa dal body (per client che non
    // supportano HTML — fallback raro nel 2026 ma rispetta MIME multipart/alternative).
    const plain = d.html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    setComposing({
      subject: d.title,
      body: plain.slice(0, 4000),
    });
  }

  return (
    <div className={`${styles.card} ${styles.docCard}`}>
      <div className={styles.headRow}>
        <span className={styles.icon}>{DOC_KIND_LABEL[d.docKind]?.split(' ')[0] ?? '📄'}</span>
        <div className={styles.title}>{d.title}</div>
        <span className={styles.docKindBadge}>{DOC_KIND_LABEL[d.docKind] ?? d.docKind}</span>
      </div>

      {tooBig && !showFullPreview ? (
        <div className={styles.bigPreviewWarn}>
          <p>
            📦 Documento HTML di <strong>{(htmlSize / 1024).toFixed(0)} KB</strong> — anteprima
            inline disattivata per evitare freeze del WebView.
          </p>
          <div className={styles.bigPreviewActions}>
            <button
              type="button"
              className={styles.btnGhost}
              onClick={() => {
                setShowFullPreview(true);
              }}
            >
              ⚠️ Mostra comunque (può rallentare l'app)
            </button>
            <span style={{ flex: 1 }} />
            <span className={styles.muted}>
              Consiglio: 💾 Salva HTML, poi apri in browser esterno per stampa/PDF
            </span>
          </div>
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          title={d.title}
          srcDoc={d.html}
          sandbox="allow-same-origin allow-modals"
          className={styles.docPreview}
        />
      )}

      {error && <div className={styles.error}>❌ {error}</div>}
      {savedTo && (
        <div className={styles.successLine}>
          <div style={{ marginBottom: 6 }}>
            ✓ File salvato: <strong>{savedTo.split('/').pop()}</strong>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() =>
                void (async () => {
                  try {
                    const { invoke } = await import('@tauri-apps/api/core');
                    await invoke('reveal_in_file_manager', { path: savedTo });
                  } catch (e) {
                    setError(`Apri Finder fallito: ${String(e)}`);
                  }
                })()
              }
            >
              📁 Mostra nel Finder
            </button>
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() =>
                void (async () => {
                  try {
                    const { invoke } = await import('@tauri-apps/api/core');
                    await invoke('open_path_in_default_app', { path: savedTo });
                  } catch (e) {
                    setError(`Apri nel browser fallito: ${String(e)}`);
                  }
                })()
              }
            >
              🌐 Apri nel browser
            </button>
          </div>
          <div
            style={{
              fontSize: 10.5,
              opacity: 0.7,
              marginTop: 6,
              fontFamily: 'ui-monospace, monospace',
              wordBreak: 'break-all',
            }}
          >
            {savedTo}
          </div>
        </div>
      )}

      <div className={styles.actions}>
        <button type="button" className={styles.btnGhost} onClick={handlePrint}>
          🖨 Stampa / Esporta PDF
        </button>
        <button type="button" className={styles.btnGhost} onClick={() => void handleSaveHtml()}>
          💾 Salva HTML
        </button>
        <button type="button" className={styles.btnPrimary} onClick={handleAttachToEmail}>
          📎 Allega a nuova email
        </button>
      </div>

      <div className={styles.disclaimer}>
        Stampa → seleziona «Salva come PDF» nel dialog di stampa nativo (macOS: «PDF ▸ Salva come
        PDF»; Windows: «Microsoft Print to PDF»). Il file HTML è self-contained: niente CDN, niente
        JavaScript — può essere aperto da qualsiasi browser.
      </div>

      {composing && (
        <div style={{ marginTop: 12 }}>
          <div className={styles.attachedComposeNote}>
            📨 Componi l'email col documento <strong>inline nel corpo</strong> (HTML renderizzato
            dal client del destinatario, non come allegato):
          </div>
          <ComposeDraftCard
            account={_account}
            proposal={{
              type: 'compose_draft',
              summary: `Documento "${d.title}" inline come corpo email`,
              draft: {
                to: [],
                cc: [],
                subject: composing.subject,
                bodyText: composing.body,
                bodyHtml: d.html,
                inReplyTo: null,
              },
            }}
          />
        </div>
      )}
    </div>
  );
}

interface ComposeProps {
  proposal: Extract<Proposal, { type: 'compose_draft' }>;
  account: MailAccount;
  execution?: ProposalExecution;
  onExecuted?: (execution: ProposalExecution) => void;
}

function ComposeDraftCard({ proposal, account, execution, onExecuted }: ComposeProps) {
  const d = proposal.draft;
  const [to, setTo] = useState(d.to.join(', '));
  const [cc, setCc] = useState((d.cc ?? []).join(', '));
  const [subject, setSubject] = useState(d.subject);
  const [body, setBody] = useState(d.bodyText);
  const [busy, setBusy] = useState(false);
  // Stato iniziale: se c'è già un'execution salvata, ripristiniamo il tipo.
  const [status, setStatus] = useState<'pending' | 'draft_saved' | 'sent' | null>(() =>
    execution?.outcome === 'sent'
      ? 'sent'
      : execution?.outcome === 'draft_saved'
        ? 'draft_saved'
        : null,
  );
  const [archiveStatus, setArchiveStatus] = useState<{
    ok: boolean;
    folder: string | null;
    available: string[];
    error: string | null;
  } | null>(() => execution?.archive ?? null);
  const [error, setError] = useState<string | null>(null);
  const [showHtml, setShowHtml] = useState(false);

  // Sincronizza lo state locale con la prop `execution` ogni volta che cambia.
  // Risolve il bug per cui dopo refresh / re-render Liara mostrava ancora il form.
  useEffect(() => {
    if (execution?.outcome === 'sent') {
      setStatus('sent');
      if (execution.archive) setArchiveStatus(execution.archive);
    } else if (execution?.outcome === 'draft_saved') {
      setStatus('draft_saved');
    }
  }, [execution]);

  function parseList(s: string): string[] {
    return s
      .split(/[;,]/)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  function buildOutgoing() {
    return {
      fromName: account.displayName || null,
      fromAddress: account.emailAddress,
      to: parseList(to),
      cc: parseList(cc),
      bcc: [] as string[],
      subject: subject || '(senza oggetto)',
      bodyText: body,
      bodyHtml: d.bodyHtml ?? null,
      inReplyTo: d.inReplyTo ?? null,
      references: [] as string[],
    };
  }

  async function handleSaveDraft() {
    setBusy(true);
    setError(null);
    try {
      const msg = buildOutgoing();
      const savedFolder = await saveDraftSmart(account, msg);
      setStatus('draft_saved');
      onExecuted?.({
        proposalIndex: 0,
        type: 'compose_draft',
        outcome: 'draft_saved',
        at: new Date().toISOString(),
        to: parseList(to),
        subject,
        draftFolder: savedFolder,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleSendNow() {
    setBusy(true);
    setError(null);
    try {
      const msg = buildOutgoing();
      const finalArchive = await sendAndArchive(account, msg);
      setArchiveStatus(finalArchive);
      setStatus('sent');
      onExecuted?.({
        proposalIndex: 0,
        type: 'compose_draft',
        outcome: 'sent',
        at: new Date().toISOString(),
        to: parseList(to),
        subject,
        archive: finalArchive,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (status === 'sent') {
    const archiveOk = archiveStatus?.ok === true;
    return (
      <div className={`${styles.card} ${archiveOk ? styles.cardOk : styles.cardWarn}`}>
        <div className={styles.headRow}>
          <span className={styles.icon}>{archiveOk ? '📤' : '⚠️'}</span>
          <div className={styles.title}>
            {archiveOk
              ? 'Email inviata e archiviata'
              : 'Email inviata · ma copia in Inviati NON archiviata'}
          </div>
        </div>
        <div className={styles.detail}>
          ✓ Inviata a <code>{to}</code>
          {subject ? ` · «${subject}»` : ''}.
          {archiveOk && archiveStatus?.folder && (
            <> Copia in IMAP «{archiveStatus.folder}» — visibile da tutti i client.</>
          )}
        </div>
        {!archiveOk && archiveStatus && (
          <div
            className={styles.detail}
            style={{ color: 'var(--color-warning-text, var(--color-text-primary))' }}
          >
            ⚠️ <strong>Archive Sent fallita.</strong> Cartelle disponibili sul tuo server IMAP:
            <code
              style={{ display: 'block', margin: '6px 0', fontSize: 11, whiteSpace: 'pre-wrap' }}
            >
              {archiveStatus.available.length > 0
                ? archiveStatus.available.join(' · ')
                : '(lista non disponibile)'}
            </code>
            Errore IMAP: <code style={{ fontSize: 11 }}>{archiveStatus.error}</code>
            <br />
            <em style={{ fontSize: 11, opacity: 0.85 }}>
              Dimmi il nome esatto della tua cartella «Posta inviata» sul server{' '}
              <code>{account.imap.host}</code> e la imposto come default per il tuo account.
            </em>
          </div>
        )}
      </div>
    );
  }
  if (status === 'draft_saved') {
    return (
      <div className={`${styles.card} ${styles.cardOk}`}>
        <div className={styles.headRow}>
          <span className={styles.icon}>💾</span>
          <div className={styles.title}>Bozza salvata in IMAP Drafts</div>
        </div>
        <div className={styles.detail}>
          Visibile da qualsiasi client mail. Puoi rifinirla là o tornare qui per inviarla.
        </div>
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <div className={styles.headRow}>
        <span className={styles.icon}>✉️</span>
        <div className={styles.title}>Proposta: invia / salva bozza</div>
      </div>

      <div className={styles.summary}>{proposal.summary}</div>

      <div className={styles.formGrid}>
        <Field label="A">
          <input
            className={styles.input}
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
            }}
          />
        </Field>
        <Field label="Cc">
          <input
            className={styles.input}
            value={cc}
            onChange={(e) => {
              setCc(e.target.value);
            }}
          />
        </Field>
        <Field label="Oggetto">
          <input
            className={styles.input}
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
            }}
          />
        </Field>
        <Field label="Corpo">
          <textarea
            className={`${styles.input} ${styles.textarea}`}
            rows={6}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
            }}
          />
        </Field>
        {d.bodyHtml && (
          <div className={styles.htmlWrap}>
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => {
                setShowHtml(!showHtml);
              }}
            >
              {showHtml ? '▾ Nascondi anteprima HTML' : '▸ Mostra anteprima HTML'}
            </button>
            {showHtml && (
              <iframe
                title="HTML preview"
                srcDoc={d.bodyHtml}
                sandbox=""
                className={styles.htmlIframe}
              />
            )}
          </div>
        )}
      </div>

      {error && <div className={styles.error}>❌ {error}</div>}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.btnGhost}
          onClick={() => void handleSaveDraft()}
          disabled={busy}
        >
          💾 Salva in Bozze IMAP
        </button>
        <button
          type="button"
          className={styles.btnPrimary}
          onClick={() => void handleSendNow()}
          disabled={busy}
        >
          📤 Invia ora
        </button>
      </div>
      <div className={styles.disclaimer}>
        L'invio è una tua azione: io ho solo preparato la bozza. Cliccando «Invia ora» parte SMTP
        reale e la copia finisce in IMAP «Inviati».
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      {children}
    </label>
  );
}
