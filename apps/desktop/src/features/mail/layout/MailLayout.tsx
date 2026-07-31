import { Button, TextField } from '@medea/ui';
import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AiPanel } from '../../ai/AiPanel';
import { mailApi } from '../api';
import type { DbFullMessage, DbListedMessage, DbSearchHit, SyncProgress } from '../api';
import { Composer } from '../composer/Composer';
import type { ComposerPrefill } from '../composer/Composer';
import { folderLabel } from '../folders/folder-label';
import { FolderTree } from '../folders/FolderTree';
import { MessageList } from '../message-list/MessageList';
import { MessageReader } from '../message-reader/MessageReader';
import type { FolderInfo, MailAccount } from '../types';

import styles from './MailLayout.module.css';

interface Props {
  account: MailAccount;
  onSwitchAccount: () => void;
}

function classifyFolderType(f: FolderInfo): string {
  const attrs = f.attributes.join(' ').toLowerCase();
  const name = f.name.toLowerCase();
  if (attrs.includes('\\inbox') || name === 'inbox') return 'inbox';
  if (attrs.includes('\\sent') || /sent|inviat/.test(name)) return 'sent';
  if (attrs.includes('\\drafts') || /draft|bozz/.test(name)) return 'drafts';
  if (attrs.includes('\\junk') || /spam|junk/.test(name)) return 'spam';
  if (attrs.includes('\\trash') || /trash|cestin|deleted/.test(name)) return 'trash';
  if (attrs.includes('\\archive') || /archive|archivi/.test(name)) return 'archive';
  return 'custom';
}

export function MailLayout({ account, onSwitchAccount }: Props) {
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [folderPath, setFolderPath] = useState<string>(account.defaultFolder ?? 'INBOX');
  const [folderId, setFolderId] = useState<number | null>(null);
  const [messages, setMessages] = useState<DbListedMessage[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [activeMsg, setActiveMsg] = useState<DbFullMessage | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composePrefill, setComposePrefill] = useState<ComposerPrefill | null>(null);

  const [loadingFolders, setLoadingFolders] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchScope, setSearchScope] = useState<'folder' | 'all'>('folder');
  const [searchResults, setSearchResults] = useState<DbSearchHit[] | null>(null);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);

  const folderAttributes = useMemo(() => {
    return folders.find((f) => f.name === folderPath)?.attributes ?? [];
  }, [folders, folderPath]);

  // Folder per cui abbiamo già fatto auto-sync (evita loop).
  const autoSyncedRef = useRef<Set<string>>(new Set());
  const bootSyncedRef = useRef(false);
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncAllProgress, setSyncAllProgress] = useState<{
    current: number;
    total: number;
    folder: string;
  } | null>(null);

  /* ── Listener globale eventi sync ────────────────────────────────── */
  useEffect(() => {
    const unlistens: (() => void)[] = [];
    void listen<SyncProgress>('mail:sync:progress', (e) => {
      setSyncProgress(e.payload);
    }).then((u) => unlistens.push(u));
    return () => {
      unlistens.forEach((u) => {
        u();
      });
    };
  }, []);

  /* ── Carica folder list (via IMAP, una volta) ────────────────────── */
  const loadFolders = useCallback(async () => {
    setLoadingFolders(true);
    setError(null);
    try {
      const list = await mailApi.imap.listFolders(account.imap);
      setFolders(list);
    } catch (e) {
      setError(`Folder list fallita: ${String(e)}`);
    } finally {
      setLoadingFolders(false);
    }
  }, [account.imap]);

  /* ── Ensure folder in DB e carica messaggi dal DB ─────────────────── */
  const loadFromDb = useCallback(
    async (path: string) => {
      setLoadingMessages(true);
      setError(null);
      try {
        const type = classifyFolderType(
          folders.find((f) => f.name === path) ?? {
            name: path,
            delimiter: null,
            attributes: [],
          },
        );
        const fid = await mailApi.db.ensureFolder(account.id, path, path, type);
        setFolderId(fid);
        const list = await mailApi.db.listMessages(account.id, fid, 5000, 0);
        setMessages(list);
      } catch (e) {
        setError(`DB load fallito: ${String(e)}`);
        setMessages([]);
      } finally {
        setLoadingMessages(false);
      }
    },
    [account.id, folders],
  );

  /* ── Sync TUTTE le folder principali (Invia/Ricevi) ───────────────── */
  const syncAll = useCallback(async () => {
    if (folders.length === 0) return;
    setSyncingAll(true);
    setError(null);
    // Ordine: INBOX prima, poi Sent, poi le altre principali.
    const sortable = folders
      .filter((f) => !f.attributes.some((a) => a.toLowerCase().includes('noselect')))
      .map((f) => ({ f, type: classifyFolderType(f) }));
    const order = ['inbox', 'sent', 'drafts', 'archive', 'spam', 'trash', 'custom'];
    sortable.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));

    for (let i = 0; i < sortable.length; i++) {
      const { f, type } = sortable[i]!;
      setSyncAllProgress({ current: i + 1, total: sortable.length, folder: f.name });
      try {
        await mailApi.db.ensureFolder(account.id, f.name, f.name, type);
        await mailApi.sync.folder(account.id, account.imap, f.name, type);
      } catch (e) {
        console.warn(`Sync folder ${f.name} failed:`, e);
      }
    }
    setSyncAllProgress(null);
    setSyncingAll(false);

    // Ricarica la folder corrente
    if (folderId !== null) {
      try {
        const list = await mailApi.db.listMessages(account.id, folderId, 5000, 0);
        setMessages(list);
      } catch (e) {
        console.warn('Refresh DB list after syncAll:', e);
      }
    }
  }, [account.id, account.imap, folders, folderId]);

  /* ── Sync: scarica nuovi messaggi dal server, salva in DB ─────────── */
  const syncCurrent = useCallback(async () => {
    if (!folderId) return;
    setSyncing(true);
    setError(null);
    setSyncProgress(null);
    try {
      const type = classifyFolderType(
        folders.find((f) => f.name === folderPath) ?? {
          name: folderPath,
          delimiter: null,
          attributes: [],
        },
      );
      const result = await mailApi.sync.folder(account.id, account.imap, folderPath, type);
      // Ricarica la lista locale dopo sync
      const list = await mailApi.db.listMessages(account.id, folderId, 5000, 0);
      setMessages(list);
      setSyncProgress({
        accountId: account.id,
        folderPath,
        fetched: result.fetched,
        total: result.fetched,
        stored: result.stored,
        message: `Fatto: ${String(result.stored)} salvati, ${String(result.alreadyInDb)} già presenti (${String(Math.round(result.elapsedMs / 100) / 10)}s)`,
      });
    } catch (e) {
      setError(`Sync fallito: ${String(e)}`);
    } finally {
      setSyncing(false);
    }
  }, [account.id, account.imap, folderId, folderPath, folders]);

  const loadFullMessage = useCallback(async (id: number) => {
    setLoadingMessage(true);
    setError(null);
    try {
      const m = await mailApi.db.getMessage(id);
      setActiveMsg(m);
      // Aprire un messaggio lo segna come letto (comportamento standard dei
      // client email). Solo stato locale: nessuna scrittura sul server IMAP.
      if (m && !m.isSeen) {
        await mailApi.db.markSeen(id, true);
        setActiveMsg({ ...m, isSeen: true });
        setMessages((prev) => prev.map((x) => (x.id === id ? { ...x, isSeen: true } : x)));
      }
    } catch (e) {
      setError(`Load messaggio fallito: ${String(e)}`);
      setActiveMsg(null);
    } finally {
      setLoadingMessage(false);
    }
  }, []);

  /* ── Ricerca FTS5 ─────────────────────────────────────────────────── */
  async function runSearch() {
    const q = searchQuery.trim();
    if (q.length === 0) {
      setSearchResults(null);
      return;
    }
    try {
      const hits = await mailApi.db.search(account.id, q, 100);
      setSearchResults(hits);
    } catch (e) {
      setError(`Search fallita: ${String(e)}`);
    }
  }

  /* ── Effetti ──────────────────────────────────────────────────────── */
  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);
  /* Refresh lista dopo che AI invia/archivia. */
  useEffect(() => {
    function onMailboxChanged() {
      void loadFromDb(folderPath);
    }
    window.addEventListener('medea:mailbox-changed', onMailboxChanged);
    return () => {
      window.removeEventListener('medea:mailbox-changed', onMailboxChanged);
    };
  }, [folderPath, loadFromDb]);
  useEffect(() => {
    if (folders.length === 0) return;
    void loadFromDb(folderPath);
    setActiveId(null);
    setActiveMsg(null);
  }, [folderPath, folders, loadFromDb]);
  useEffect(() => {
    if (activeId !== null) void loadFullMessage(activeId);
  }, [activeId, loadFullMessage]);

  // Auto-seleziona: prima prova a ripristinare l'ultimo messaggio aperto
  // (persistito in localStorage per account+folder), altrimenti il primo.
  useEffect(() => {
    if (messages.length === 0) return;
    if (activeId !== null && messages.some((m) => m.id === activeId)) return;
    const key = `medea.lastViewed.${account.id}.${folderPath}`;
    const saved = localStorage.getItem(key);
    const savedId = saved ? Number.parseInt(saved, 10) : NaN;
    const matchSaved = Number.isFinite(savedId) && messages.some((m) => m.id === savedId);
    setActiveId(matchSaved ? savedId : (messages[0]?.id ?? null));
  }, [messages, activeId, account.id, folderPath]);

  // Persisti il messaggio attivo per account+folder
  useEffect(() => {
    if (activeId === null) return;
    const key = `medea.lastViewed.${account.id}.${folderPath}`;
    localStorage.setItem(key, String(activeId));
  }, [activeId, account.id, folderPath]);

  // Auto-sync per-folder: se entri in una folder vuota nel DB → sync.
  useEffect(() => {
    if (loadingMessages || syncing || syncingAll) return;
    if (folderId === null) return;
    if (messages.length > 0) return;
    const key = `${account.id}:${folderPath}`;
    if (autoSyncedRef.current.has(key)) return;
    autoSyncedRef.current.add(key);
    void syncCurrent();
  }, [
    folderId,
    messages.length,
    loadingMessages,
    syncing,
    syncingAll,
    account.id,
    folderPath,
    syncCurrent,
  ]);

  // Auto-sync ALL all'avvio: appena l'utente apre Medea e le folder sono note,
  // scarica TUTTE le cartelle principali in serie. Una volta per sessione.
  useEffect(() => {
    if (folders.length === 0) return;
    if (bootSyncedRef.current) return;
    bootSyncedRef.current = true;
    void syncAll();
  }, [folders, syncAll]);

  function buildQuoted(m: DbFullMessage): string {
    return `\n\n--- Messaggio originale ---\nDa: ${m.fromName ?? ''} <${
      m.fromAddress ?? ''
    }>\nData: ${m.internalDate ?? ''}\nOggetto: ${m.subject ?? ''}\n\n${m.bodyText ?? ''}`;
  }

  function startReply(all: boolean) {
    if (!activeMsg) return;
    const myEmail = account.emailAddress.toLowerCase();
    const cc = all
      ? [...activeMsg.to, ...activeMsg.cc]
          .filter(
            (e) =>
              e.toLowerCase() !== myEmail &&
              e.toLowerCase() !== (activeMsg.fromAddress ?? '').toLowerCase(),
          )
          .join(', ')
      : '';
    setComposePrefill({
      mode: all ? 'replyAll' : 'reply',
      to: activeMsg.fromAddress ?? '',
      cc,
      subject: activeMsg.subject?.startsWith('Re:')
        ? activeMsg.subject
        : `Re: ${activeMsg.subject ?? ''}`,
      body: buildQuoted(activeMsg),
      inReplyTo: activeMsg.messageId,
      references: [...activeMsg.references, activeMsg.messageId].filter(
        (x): x is string => x !== null,
      ),
    });
    setComposeOpen(true);
  }

  function startForward() {
    if (!activeMsg) return;
    setComposePrefill({
      mode: 'forward',
      to: '',
      cc: '',
      subject:
        activeMsg.subject?.toLowerCase().startsWith('fw') ||
        activeMsg.subject?.toLowerCase().startsWith('i:')
          ? (activeMsg.subject ?? '')
          : `Fw: ${activeMsg.subject ?? ''}`,
      body: buildQuoted(activeMsg),
      inReplyTo: null,
      references: [],
    });
    setComposeOpen(true);
  }

  function startNew() {
    setComposePrefill(null);
    setComposeOpen(true);
  }

  async function handleReaderAction(
    action: 'reply' | 'replyAll' | 'forward' | 'flag' | 'unread' | 'delete',
  ) {
    if (!activeMsg) return;
    try {
      switch (action) {
        case 'reply':
          startReply(false);
          return;
        case 'replyAll':
          startReply(true);
          return;
        case 'forward':
          startForward();
          return;
        case 'flag':
          await mailApi.db.setFlag(activeMsg.id, !activeMsg.isFlagged);
          break;
        case 'unread':
          await mailApi.db.markSeen(activeMsg.id, !activeMsg.isSeen);
          break;
        case 'delete':
          await mailApi.db.localDelete(activeMsg.id);
          setActiveId(null);
          setActiveMsg(null);
          break;
      }
      // Ricarica la lista locale per riflettere lo stato aggiornato
      if (folderId !== null) {
        const list = await mailApi.db.listMessages(account.id, folderId, 5000, 0);
        setMessages(list);
      }
      // Ricarica messaggio attivo se ancora valido
      if (activeMsg.id) {
        const updated = await mailApi.db.getMessage(activeMsg.id);
        if (updated) setActiveMsg(updated);
      }
    } catch (e) {
      setError(`Azione fallita: ${String(e)}`);
    }
  }

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <header className={styles.sidebarHead}>
          <img src="/icon.png" alt="Medea" className={styles.glyphImg} width={32} height={32} />
          <div className={styles.accountInfo}>
            <div className={styles.accountName}>{account.displayName}</div>
            <div className={styles.accountEmail}>{account.emailAddress}</div>
          </div>
        </header>

        <div className={styles.sidebarActions}>
          <Button variant="solid" size="sm" onClick={startNew} fullWidth>
            Scrivi
          </Button>
        </div>

        <FolderTree
          folders={folders}
          loading={loadingFolders}
          active={folderPath}
          onSelect={(p) => {
            setFolderPath(p);
            setSearchResults(null);
            setSearchQuery('');
          }}
        />

        <footer className={styles.sidebarFoot}>
          <Button variant="ghost" size="sm" onClick={onSwitchAccount} fullWidth>
            Cambia account
          </Button>
        </footer>
      </aside>

      <div className={styles.workspace}>
        <div className={styles.topBar}>
          <div className={styles.searchGroup}>
            <select
              className={styles.scopeSelect}
              value={searchScope}
              onChange={(e) => {
                setSearchScope(e.target.value as 'folder' | 'all');
              }}
              aria-label="Ambito di ricerca"
            >
              <option value="folder">In questa cartella</option>
              <option value="all">In tutte le email</option>
            </select>
            <TextField
              placeholder={
                searchScope === 'all'
                  ? 'Cerca in tutte le email (FTS5)…'
                  : 'Filtra in questa cartella…'
              }
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && searchScope === 'all') void runSearch();
                if (e.key === 'Escape') {
                  setSearchQuery('');
                  setSearchResults(null);
                }
              }}
              size="sm"
              fullWidth
            />
            {searchScope === 'all' && (
              <Button variant="outline" size="sm" onClick={() => void runSearch()}>
                Cerca
              </Button>
            )}
          </div>
          <div className={styles.topBarActions}>
            <Button
              variant="solid"
              size="sm"
              onClick={() => void syncAll()}
              isLoading={syncingAll}
              isDisabled={folders.length === 0}
            >
              ↻ Invia/Ricevi
            </Button>
            <Button
              variant={aiPanelOpen ? 'solid' : 'outline'}
              size="sm"
              onClick={() => {
                setAiPanelOpen(!aiPanelOpen);
              }}
              title="AI Assistente"
            >
              ✨ AI
            </Button>
          </div>
        </div>

        {(syncing || syncingAll) && (syncProgress ?? syncAllProgress) && (
          <div className={styles.syncBar} role="status">
            <span>
              {syncAllProgress
                ? `Invia/Ricevi: ${folderLabel(syncAllProgress.folder)} (${syncAllProgress.current}/${syncAllProgress.total})`
                : (syncProgress?.message ?? '')}
            </span>
            {syncProgress && syncProgress.total > 0 && (
              <progress max={syncProgress.total} value={syncProgress.fetched} />
            )}
          </div>
        )}

        <section className={styles.listPane}>
          {searchResults ? (
            <SearchResults
              results={searchResults}
              activeId={activeId}
              onSelect={(id) => {
                setActiveId(id);
              }}
              onClear={() => {
                setSearchResults(null);
                setSearchQuery('');
              }}
            />
          ) : (
            <MessageList
              folder={folderPath}
              folderAttributes={folderAttributes}
              messages={messages}
              loading={loadingMessages}
              activeId={activeId}
              filterText={searchScope === 'folder' ? searchQuery : ''}
              onSelect={(id) => {
                setActiveId(id);
              }}
            />
          )}
        </section>

        <div className={styles.divider} aria-hidden />

        <section className={styles.readerPane}>
          <MessageReader
            message={activeMsg}
            loading={loadingMessage}
            onAction={(a) => {
              void handleReaderAction(a);
            }}
          />
        </section>
      </div>

      {error && (
        <div className={styles.errorToast} role="alert">
          {error}
          <button
            type="button"
            onClick={() => {
              setError(null);
            }}
            aria-label="Chiudi"
          >
            ✕
          </button>
        </div>
      )}

      {composeOpen && (
        <Composer
          account={account}
          prefill={composePrefill}
          onClose={() => {
            setComposeOpen(false);
            setComposePrefill(null);
          }}
        />
      )}

      {aiPanelOpen && (
        <AiPanel
          account={account}
          activeMessage={activeMsg}
          onClose={() => {
            setAiPanelOpen(false);
          }}
        />
      )}
    </div>
  );
}

interface SearchProps {
  results: DbSearchHit[];
  activeId: number | null;
  onSelect: (id: number) => void;
  onClear: () => void;
}
function SearchResults({ results, activeId, onSelect, onClear }: SearchProps) {
  return (
    <div className={styles.searchResults}>
      <div className={styles.searchHeader}>
        <span>{results.length} risultati</span>
        <button type="button" onClick={onClear} className={styles.clearBtn}>
          Pulisci ricerca
        </button>
      </div>
      <div className={styles.searchBody}>
        {results.map((r) => (
          <button
            key={r.messageId}
            type="button"
            className={`${styles.searchItem} ${r.messageId === activeId ? styles.searchActive : ''}`}
            onClick={() => {
              onSelect(r.messageId);
            }}
          >
            <div className={styles.searchItemTop}>
              <span className={styles.searchFrom}>{r.fromAddress ?? '?'}</span>
              <span className={styles.searchDate}>
                {r.internalDate ? new Date(r.internalDate).toLocaleDateString('it-IT') : ''}
              </span>
            </div>
            <div className={styles.searchSubject}>{r.subject ?? '(senza oggetto)'}</div>
            <div
              className={styles.searchSnippet}
              // sicuro: snippet contiene solo <<...>> di FTS5, no HTML reale
              dangerouslySetInnerHTML={{
                __html: r.snippet
                  .replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')
                  .replace(/&lt;&lt;/g, '<mark>')
                  .replace(/&gt;&gt;/g, '</mark>'),
              }}
            />
          </button>
        ))}
      </div>
    </div>
  );
}
