import { Button } from '@medea/ui';
import { useEffect, useState } from 'react';


import { mailApi } from '../api';
import type { DbFullMessage, DbInlinePart } from '../api';
import { AttachmentsPanel } from '../attachments/AttachmentsPanel';

import styles from './MessageReader.module.css';

export type ReaderAction =
  | 'reply'
  | 'replyAll'
  | 'forward'
  | 'flag'
  | 'unread'
  | 'delete';

interface Props {
  message: DbFullMessage | null;
  loading: boolean;
  onAction: (action: ReaderAction) => void;
}

function sanitizeBasic(html: string): string {
  return html
    .replace(/<\s*\/?\s*script\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\bjavascript:\s*[^"'\s>]+/gi, '')
    .replace(/\s+srcset\s*=\s*("[^"]*"|'[^']*')/gi, '');
}

/** GIF trasparente 1×1, usata come fallback quando il cid: non risolve. */
const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

function replaceCidWithData(html: string, parts: DbInlinePart[]): string {
  if (parts.length === 0) {
    // Anche se non abbiamo parti, dobbiamo comunque NEUTRALIZZARE i cid:
    // altrimenti il browser genera "unsupported URL". Sostituiamo tutti con
    // pixel trasparente.
    return neutralizeCidUrls(html, () => TRANSPARENT_PIXEL);
  }
  // Map a 3 chiavi per part: contentId pieno, local-part (prima della @), filename.
  // Outlook usa molto spesso `cid:filename@guid` con Content-ID = solo guid → match per filename salva.
  const byCid = new Map<string, DbInlinePart>();
  const byLocal = new Map<string, DbInlinePart>();
  const byFilename = new Map<string, DbInlinePart>();
  for (const p of parts) {
    const k = p.contentId.toLowerCase().trim();
    if (k) byCid.set(k, p);
    const local = k.split('@')[0];
    if (local) byLocal.set(local, p);
    if (p.filename) byFilename.set(p.filename.toLowerCase().trim(), p);
  }

  function resolve(rawCid: string): string {
    const key = rawCid.trim().toLowerCase();
    let part = byCid.get(key);
    if (!part) {
      const local = key.split('@')[0];
      if (local) part = byLocal.get(local);
    }
    if (!part) {
      // Outlook: `cid:image003.jpg@01DCEDE1...` → tentiamo match per nome file.
      const beforeAt = key.split('@')[0] ?? '';
      part = byFilename.get(beforeAt) ?? byFilename.get(key);
    }
    if (!part) return TRANSPARENT_PIXEL;
    return `data:${part.contentType};base64,${part.base64}`;
  }

  return neutralizeCidUrls(html, resolve);
}

/**
 * Sostituisce TUTTE le occorrenze `cid:...` nell'HTML:
 *  - attributi: `src="cid:..."`, `background="cid:..."`, `data="cid:..."`
 *  - inline CSS:  `style="background:url(cid:...)"` , `style="background-image:url('cid:...')"`
 *  - tag SVG: `xlink:href="cid:..."`
 *
 * Garantisce che il browser non veda mai `cid:` (che produrrebbe "unsupported URL").
 */
function neutralizeCidUrls(html: string, resolve: (cid: string) => string): string {
  // 1) Attributi HTML standard (src/background/data/xlink:href)
  const attrRe = /(\b(?:src|background|data|xlink:href)\s*=\s*)(["'])cid:([^"']+)\2/gi;
  let out = html.replace(attrRe, (_full, prefix: string, q: string, cid: string) =>
    `${prefix}${q}${resolve(cid)}${q}`);
  // 2) CSS url(cid:...) — dentro inline style o tag <style>
  const urlRe = /url\(\s*(['"]?)cid:([^)'"]+)\1\s*\)/gi;
  out = out.replace(urlRe, (_full, q: string, cid: string) =>
    `url(${q}${resolve(cid)}${q})`);
  return out;
}

export function MessageReader({ message, loading, onAction }: Props) {
  const [inlineParts, setInlineParts] = useState<DbInlinePart[]>([]);
  const [srcdoc, setSrcdoc] = useState<string | null>(null);

  useEffect(() => {
    if (!message) {
      setInlineParts([]);
      return;
    }
    void (async () => {
      try {
        const parts = await mailApi.db.getInlineParts(message.id);
        setInlineParts(parts);
      } catch (e) {
        console.warn('getInlineParts failed:', e);
        setInlineParts([]);
      }
    })();
  }, [message]);

  useEffect(() => {
    if (!message?.bodyHtml) {
      setSrcdoc(null);
      return;
    }
    const css = `
      <style>
        :root { color-scheme: light dark; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
               font-size: 14px; line-height: 1.55; padding: 12px; color: #222;
               background: #fff; word-wrap: break-word; }
        img { max-width: 100%; height: auto; }
        a { color: #4f46e5; }
        blockquote { border-left: 3px solid #d4d4d8; margin: 8px 0; padding: 4px 12px;
                     color: #71717a; }
      </style>
    `;
    const withCid = replaceCidWithData(message.bodyHtml, inlineParts);
    const sanitized = sanitizeBasic(withCid);
    setSrcdoc(
      `<!doctype html><html><head><meta charset="utf-8">${css}</head><body>${sanitized}</body></html>`,
    );
  }, [message, inlineParts]);

  if (!message && !loading) {
    return (
      <div className={styles.empty}>
        <span>Seleziona un messaggio dalla lista</span>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={styles.empty}>
        <span className={styles.spinner} aria-hidden />
        Carico messaggio…
      </div>
    );
  }

  if (!message) return null;

  return (
    <div className={styles.root}>
      <header className={styles.head}>
        <div className={styles.toolbar}>
          <Button variant="solid" size="sm" onClick={() => { onAction('reply'); }}>
            ↩ Rispondi
          </Button>
          <Button variant="soft" size="sm" onClick={() => { onAction('replyAll'); }}>
            ↩↩ Rispondi a tutti
          </Button>
          <Button variant="soft" size="sm" onClick={() => { onAction('forward'); }}>
            ↪ Inoltra
          </Button>
          <span className={styles.toolbarSep} />
          <Button
            variant={message.isFlagged ? 'solid' : 'ghost'}
            size="sm"
            onClick={() => { onAction('flag'); }}
            title={message.isFlagged ? 'Rimuovi stella' : 'Aggiungi stella'}
          >
            ★
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { onAction('unread'); }}>
            {message.isSeen ? 'Segna non letto' : 'Segna letto'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { onAction('delete'); }}
            title="Cancellazione SOLO locale — il messaggio resta sul server IMAP"
          >
            🗑 Elimina
          </Button>
        </div>
        <div className={styles.headInfo}>
          <h1 className={styles.subject}>{message.subject ?? '(senza oggetto)'}</h1>
          <dl className={styles.meta}>
            <div>
              <dt>Da</dt>
              <dd>
                {message.fromName ? `${message.fromName} ` : ''}
                {message.fromAddress ? `<${message.fromAddress}>` : ''}
              </dd>
            </div>
            {message.to.length > 0 && (
              <div>
                <dt>A</dt>
                <dd>{message.to.join(', ')}</dd>
              </div>
            )}
            {message.cc.length > 0 && (
              <div>
                <dt>Cc</dt>
                <dd>{message.cc.join(', ')}</dd>
              </div>
            )}
            {message.internalDate && (
              <div>
                <dt>Data</dt>
                <dd>{new Date(message.internalDate).toLocaleString('it-IT')}</dd>
              </div>
            )}
          </dl>
        </div>
      </header>

      <div className={styles.body}>
        {srcdoc ? (
          <iframe
            title={message.subject ?? 'Messaggio'}
            srcDoc={srcdoc}
            // `allow-same-origin` è necessario per caricare risorse remote
            // (immagini, font) — senza questo flag le `<img src="https://…">`
            // restano bianche. Mai `allow-scripts`.
            sandbox="allow-same-origin allow-popups"
            referrerPolicy="no-referrer"
            className={styles.iframe}
          />
        ) : (
          <pre className={styles.bodyText}>{message.bodyText ?? '(corpo vuoto)'}</pre>
        )}
        {message.hasAttachments && <AttachmentsPanel messageId={message.id} />}
      </div>
    </div>
  );
}
