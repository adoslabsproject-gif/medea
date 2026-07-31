import { useEffect, useMemo, useRef, useState } from 'react';

import { mailApi } from '../mail/api';
import type { DbFullMessage } from '../mail/api';
import type { MailAccount } from '../mail/types';
import { Markdown } from '../shared/markdown';

import styles from './AiPanel.module.css';
import { aiApi } from './api';
import { ConsentCard } from './ConsentCard';
import { ConversationsSidebar } from './ConversationsSidebar';
import { sanitizeHtmlForLlm } from './html-sanitizer';
import { getApiKey } from './keys';
import { MemoryDrawer } from './MemoryDrawer';
import { ProposalCard } from './ProposalCard';
import {
  autoTitle,
  createConversation,
  deleteConversation,
  listConversations,
  loadActive,
  migrateLegacyHistory,
  saveActive,
  updateConversation,
} from './store/conversations';
import type { Attachment, ChatMessageEx, ComposeDraftProposal, ComposeHtmlProposal, Conversation, Proposal, ProposalExecution } from './store/conversations';
import {
  addMemory,
  buildMemoryBlock,
  extractMemoriesFromReply,
  stripMemoryMarkers,
} from './store/memory';
import { callTool, consentAction, listTools, toOpenAiTools } from './tools';
import type { ToolCall, ToolCallResult, ToolDescriptor } from './tools';
import { CUSTOM_BASE_URL_KEY, CUSTOM_MODEL_KEY, providerLabel } from './types';
import type { ChatTurn, ProviderId } from './types';

interface Props {
  account: MailAccount;
  activeMessage: DbFullMessage | null;
  onClose: () => void;
}

const DEFAULT_PROVIDER_KEY = 'medea.ai.defaultProvider';
const SIDEBAR_COLLAPSED_KEY = 'medea.ai.sidebarCollapsed';

function defaultProvider(): ProviderId {
  const stored = localStorage.getItem(DEFAULT_PROVIDER_KEY);
  return (stored as ProviderId | null) ?? 'liara';
}

/** Parametri di connessione BYOK per il provider attivo. */
async function providerConnection(provider: ProviderId): Promise<{
  apiKey: string | undefined;
  baseUrl: string | undefined;
  model: string | undefined;
}> {
  const apiKey = (await getApiKey(provider)) || undefined;
  if (provider !== 'custom') return { apiKey, baseUrl: undefined, model: undefined };
  return {
    apiKey,
    baseUrl: localStorage.getItem(CUSTOM_BASE_URL_KEY) ?? undefined,
    model: localStorage.getItem(CUSTOM_MODEL_KEY) ?? undefined,
  };
}

/** Recupera il nome visualizzato dell'utente dal profilo locale.
 *  Ordine di fallback: profile.displayName → account.displayName → "Tu". */
function readUserName(account: MailAccount): string {
  try {
    const raw = localStorage.getItem('medea.profile.v2');
    if (raw) {
      const p = JSON.parse(raw) as { displayName?: string };
      if (p.displayName?.trim()) return p.displayName.trim();
    }
  } catch { /* ignore */ }
  return account.displayName?.trim() || 'Tu';
}

function fmtSize(b: number): string {
  if (b < 1024) return `${b.toString()} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/** MIME types il cui contenuto testuale può essere passato al modello. */
const TEXT_LIKE = /^(text\/|application\/(json|xml|csv|x-yaml))/;
const ATTACH_TEXT_CAP = 20_000;

function decodeBase64Text(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

/** Le immagini viaggiano come data URL nel turno (vision), non come testo. */
function isImage(a: Attachment): boolean {
  return a.type.startsWith('image/');
}

function imageDataUrl(a: Attachment): string {
  return `data:${a.type};base64,${a.base64}`;
}

/** Descrive un allegato per il contesto AI. Il contenuto testuale viene
 *  incluso; le immagini sono passate al modello come parti multimodali
 *  (vedi `images` in ChatTurn), qui se ne cita solo il nome. */
function describeAttachment(a: Attachment): string {
  const head = `- ${a.name} (${a.type}, ${fmtSize(a.size)})`;
  if (isImage(a)) {
    return `${head} — immagine allegata a questo messaggio: la vedi direttamente.`;
  }
  if (TEXT_LIKE.test(a.type)) {
    const text = decodeBase64Text(a.base64).slice(0, ATTACH_TEXT_CAP);
    if (text.trim()) {
      return `${head}\n--- CONTENUTO ${a.name} ---\n${text}\n--- FINE ${a.name} ---`;
    }
  }
  return `${head} — formato binario non testuale: non posso leggerne il contenuto. Dillo all'utente se te lo chiede.`;
}

/** Turno della chat → turno per il modello, con le immagini allegate. */
function toChatTurn(m: ChatMessageEx): ChatTurn {
  const images = (m.attachments ?? []).filter(isImage).map(imageDataUrl);
  return {
    role: m.role,
    content: m.content,
    ...(images.length > 0 ? { images } : {}),
  };
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      // readAsDataURL produce sempre una stringa; l'ArrayBuffer non si presenta.
      const s = typeof r.result === 'string' ? r.result : '';
      const idx = s.indexOf(',');
      resolve(idx >= 0 ? s.slice(idx + 1) : s);
    };
    r.onerror = () => { reject(r.error ?? new Error('FileReader error')); };
    r.readAsDataURL(file);
  });
}

export function AiPanel({ account, activeMessage, onClose }: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<ProviderId>(() => defaultProvider());
  const [includeMessage, setIncludeMessage] = useState(true);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1',
  );
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [syncingInbox, setSyncingInbox] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [toolRegistry, setToolRegistry] = useState<ToolDescriptor[]>([]);
  const [lastTrace, setLastTrace] = useState<ToolCallResult[]>([]);
  /** Tool sensibile in attesa di conferma: blocca il loop finché l'utente decide. */
  const [pendingConsent, setPendingConsent] = useState<
    { call: ToolCall; action: string; decide: (allow: boolean) => void } | null
  >(null);
  const [userName, setUserName] = useState<string>(() => readUserName(account));
  const [userPhoto] = useState<string | null>(() => localStorage.getItem('medea.profile.photo.v1'));

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const active = useMemo(
    () => (activeId ? conversations.find((c) => c.id === activeId) ?? null : null),
    [activeId, conversations],
  );
  const history: ChatMessageEx[] = active?.messages ?? [];

  function refreshList(selectId?: string | null) {
    const list = listConversations(account.id);
    setConversations(list);
    if (selectId !== undefined) {
      setActiveId(selectId);
      saveActive(account.id, selectId);
    }
  }

  // Mount: migrazione legacy, carico conversazioni, ripristino attiva
  useEffect(() => {
    migrateLegacyHistory(account.id);
    const list = listConversations(account.id);
    setConversations(list);
    const stored = loadActive(account.id);
    const next = stored && list.some((c) => c.id === stored) ? stored : list[0]?.id ?? null;
    setActiveId(next);
    saveActive(account.id, next);
    void runSilentInboxSync();
    void (async () => {
      try { setToolRegistry(await listTools()); }
      catch { /* ignore */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history.length, streaming]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 240).toString()}px`;
  }, [input]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  // Aggiorna il nome quando il profilo cambia (event storage cross-window).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'medea.profile.v2') setUserName(readUserName(account));
    };
    window.addEventListener('storage', onStorage);
    return () => { window.removeEventListener('storage', onStorage); };
  }, [account]);

  // ── Sync silenzioso INBOX (in background, non blocca UI) ────────────────────
  async function runSilentInboxSync() {
    try {
      setSyncingInbox(true);
      await mailApi.sync.folder(account.id, account.imap, 'INBOX', 'inbox', 100);
      setLastSyncAt(new Date().toISOString());
    } catch {
      /* non blocchiamo la chat se il sync fallisce */
    } finally {
      setSyncingInbox(false);
    }
  }

  // ── Gestione conversazioni ──────────────────────────────────────────────────
  function handleNew() {
    const c = createConversation(account.id);
    refreshList(c.id);
  }

  function handleSelect(id: string) {
    setActiveId(id);
    saveActive(account.id, id);
  }

  function handleRename(id: string, title: string) {
    updateConversation(id, { title });
    refreshList();
  }

  function handleDelete(id: string) {
    deleteConversation(id);
    const remaining = listConversations(account.id);
    const next = remaining[0]?.id ?? null;
    setConversations(remaining);
    setActiveId(next);
    saveActive(account.id, next);
  }

  function ensureConversation(): Conversation {
    if (active) return active;
    const c = createConversation(account.id);
    setConversations([c, ...conversations]);
    setActiveId(c.id);
    saveActive(account.id, c.id);
    return c;
  }

  function setActiveMessages(next: ChatMessageEx[]) {
    if (!activeId) return;
    setMessagesForConv(activeId, next);
  }

  /** Registra l'esito di una proposal dentro il messaggio assistant per
   *  renderlo persistente (così la card "Inviata" non si perde al refresh). */
  function recordProposalExecution(messageIdx: number, exec: ProposalExecution) {
    if (!activeId) return;
    const conv = listConversations(account.id).find((c) => c.id === activeId);
    if (!conv) return;
    const msgs = conv.messages.slice();
    const target = msgs[messageIdx];
    if (!target) return;
    const existing = target.proposalExecutions ?? [];
    const without = existing.filter((e) => e.proposalIndex !== exec.proposalIndex);
    msgs[messageIdx] = { ...target, proposalExecutions: [...without, exec] };
    setMessagesForConv(activeId, msgs);
  }

  /** Variante che non dipende dallo state `activeId` (race condition al primo send). */
  function setMessagesForConv(convId: string, next: ChatMessageEx[]) {
    updateConversation(convId, { messages: next });
    setConversations((prev) => {
      const exists = prev.some((c) => c.id === convId);
      if (!exists) {
        // potrebbe essere stata appena creata dentro `ensureConversation` ma
        // non ancora in state — la rileggiamo dallo storage.
        return listConversations(account.id);
      }
      return prev.map((c) => (c.id === convId
        ? { ...c, messages: next, updatedAt: new Date().toISOString() }
        : c));
    });
  }

  // ── Allegati ────────────────────────────────────────────────────────────────
  function pickFiles(accept: string) {
    if (!fileInputRef.current) return;
    fileInputRef.current.accept = accept;
    fileInputRef.current.value = '';
    fileInputRef.current.click();
  }

  async function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const next: Attachment[] = [];
    for (const f of Array.from(files)) {
      try {
        if (f.size > 5 * 1024 * 1024) {
          setError(`${f.name}: troppo grande (max 5 MB per file).`);
          continue;
        }
        const b64 = await fileToBase64(f);
        next.push({ name: f.name, size: f.size, type: f.type || 'application/octet-stream', base64: b64 });
      } catch (err) {
        setError(`Impossibile leggere ${f.name}: ${String(err)}`);
      }
    }
    if (next.length > 0) setPendingAttachments([...pendingAttachments, ...next]);
  }

  function removeAttachment(i: number) {
    setPendingAttachments(pendingAttachments.filter((_, j) => j !== i));
  }

  // ── Costruzione contesto live ───────────────────────────────────────────────
  async function buildLiveContext(): Promise<string> {
    const parts: string[] = [];
    const now = new Date();
    parts.push(`Data/ora corrente: ${now.toLocaleString('it-IT', {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })}`);
    parts.push(`Oggi = ${now.toLocaleDateString('it-IT')}`);
    parts.push(`Account attivo: ${account.displayName} <${account.emailAddress}>`);
    parts.push(`Account ID (per i tool): ${account.id}`);
    if (lastSyncAt) {
      parts.push(`Ultimo sync INBOX: ${new Date(lastSyncAt).toLocaleString('it-IT')}`);
    }

    try {
      const profileRaw = localStorage.getItem('medea.profile.v2');
      if (profileRaw) {
        const p = JSON.parse(profileRaw) as Record<string, string>;
        const lines: string[] = [];
        if (p.displayName) lines.push(`Nome: ${p.displayName}`);
        if (p.role) lines.push(`Ruolo: ${p.role}`);
        if (p.organizationName) lines.push(`Azienda: ${p.organizationName}`);
        if (p.vatNumber) lines.push(`P.IVA: ${p.vatNumber}`);
        if (p.address) lines.push(`Indirizzo: ${p.address}`);
        if (p.phone) lines.push(`Telefono: ${p.phone}`);
        if (p.website) lines.push(`Sito: ${p.website}`);
        if (p.emailSignature) lines.push(`Firma email (HTML):\n${p.emailSignature}`);
        if (p.notes) lines.push(`Note: ${p.notes}`);
        if (lines.length > 0) parts.push(`\n=== PROFILO UTENTE ===\n${lines.join('\n')}`);
      }
    } catch { /* ignore */ }

    const memBlock = await buildMemoryBlock();
    if (memBlock) parts.push('\n' + memBlock);

    if (includeMessage && activeMessage) {
      const subject = activeMessage.subject ?? '(senza oggetto)';
      const from = `${activeMessage.fromName ?? ''} <${activeMessage.fromAddress ?? ''}>`;
      const date = activeMessage.internalDate ?? '';
      const text = (activeMessage.bodyText ?? '').slice(0, 4000);
      const rawHtml = activeMessage.bodyHtml ?? null;
      const html = rawHtml ? sanitizeHtmlForLlm(rawHtml, 5000) : null;
      const sections: string[] = [];
      sections.push(`Da: ${from}`);
      sections.push(`Data: ${date}`);
      sections.push(`Oggetto: ${subject}`);
      if (text) sections.push(`\n--- BODY TEXT ---\n${text}`);
      if (html) sections.push(`\n--- BODY HTML (sanitizzato per analisi struttura) ---\n${html}`);
      parts.push(
        `\n=== EMAIL ATTUALMENTE APERTA NEL READER ===\n${sections.join('\n')}\n=== FINE EMAIL APERTA ===`,
      );
    }

    try {
      const recent = await mailApi.db.recentMessages(account.id, 30);
      if (recent.length > 0) {
        const list = recent.map((m, i) => {
          const d = m.internalDate
            ? new Date(m.internalDate).toLocaleString('it-IT', {
                day: '2-digit', month: '2-digit', year: '2-digit',
                hour: '2-digit', minute: '2-digit',
              })
            : '';
          const from = m.fromName ?? m.fromAddress ?? '?';
          const subj = m.subject ?? '(senza oggetto)';
          const folder = m.folderPath ? ` [${m.folderPath}]` : '';
          const prev = m.preview ? ` — ${m.preview.slice(0, 100).replace(/\s+/g, ' ')}` : '';
          const flags = [m.isSeen ? '' : '🔵', m.isFlagged ? '⭐' : '', m.hasAttachments ? '📎' : '']
            .filter(Boolean).join(' ');
          return `${(i + 1).toString().padStart(2, '0')}. ${d} | ${from}${folder}${flags ? ' ' + flags : ''} | ${subj}${prev}`;
        }).join('\n');
        parts.push(
          `\n=== ULTIME 30 EMAIL DELL'ACCOUNT (snapshot DB ordinato per data DESC — riga 01 = PIÙ RECENTE) ===\nLegenda: 🔵=non letta · ⭐=importante · 📎=allegato\n${list}\n=== FINE LISTA ===`,
        );
      }
    } catch { /* ignore */ }

    return parts.join('\n');
  }

  function buildSystemPrompt(liveContext: string, attachContext: string): string {
    const today = new Date().toLocaleDateString('it-IT');
    return (
      `Sei l'assistente AI di Medea, un client email con anagrafiche, articoli e documenti. USA SEMPRE gli strumenti per agire: quando l'utente chiede un'azione (es. "rispondi", "trova", "fammi un preventivo") **chiama subito il tool giusto**, non chiedere il permesso a parole.\n\n` +
      `**Anti-hallucination**: non dire mai "ho inviato", "ho salvato", "fatto" finché un tool non lo ha confermato. \`email_draft\`, \`email_reply\` ed \`email_send\` NON inviano: preparano la bozza e l'utente preme il bottone. Digli sempre di rivederla e confermare. I tool che modificano i dati chiedono una conferma esplicita all'utente prima di eseguire: se la nega, riportalo con onestà.\n\n` +
      `## Regole sul contesto\n\n` +
      `1. Per qualsiasi domanda su email («ultima», «di oggi», «da X»), usa SOLO il blocco "ULTIME 30 EMAIL" qui sotto. Riga 01 = email più recente.\n` +
      `2. NON ricordare email dai turni precedenti: il DB cambia tra messaggi. Ricontrolla sempre la lista live.\n` +
      `3. "Oggi" = ${today}. Filtra per questa data.\n` +
      `4. Cita data, mittente, oggetto reali dalla lista; mai inventare.\n` +
      `5. Se l'utente dice "ricorda che X" o emerge un fatto durevole (preferenza cliente, accordo, deadline), emetti nel testo finale \`[[MEMORIZZA: <fatto conciso>]]\`. Sarà salvato e disponibile in tutte le chat future.\n` +
      `6. Le memorie persistenti sopra (se presenti) sono fatti già confermati: rispettali.\n` +
      `7. Quando l'email aperta ha sia BODY TEXT sia BODY HTML, preferisci il TEXT per i contenuti; usa l'HTML per riconoscere la struttura (tabelle prezzi, layout newsletter, link-cta, immagini citate).\n\n` +
      `**Stile:** Markdown, italiano, conciso. Bozze: testo finale senza preamboli. Riassunti email: **Mittente** · **Oggetto** · **Sintesi** (bullet) · **Azioni richieste**.\n\n` +
      `## 📄 Generazione documenti (preventivi, lettere, report) — stile 2026\n\n` +
      `Quando l'utente chiede un documento "ufficiale", usa **\`document_compose_html\`**. Devi produrre un PDF-grade document, design ricco ma stampabile A4.\n\n` +
      `### Vincoli tecnici\n` +
      `1. **Self-contained**: HTML completo con \`<style>\` inline. Mai \`<script>\`, mai CDN/Google Fonts, mai immagini esterne. SVG inline ok.\n` +
      `2. **FORMATO FOGLIO A4 OBBLIGATORIO** — il documento deve apparire come una pagina A4 sia in browser sia in stampa. Usa SEMPRE questo boilerplate:\n\n` +
      `   \`\`\`css\n   @page { size: A4; margin: 0; }\n   html, body { margin: 0; padding: 0; }\n   html { -webkit-print-color-adjust: exact; print-color-adjust: exact; background: #e2e8f0; }\n   body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;\n           line-height: 1.55; color: #0f172a; }\n   .page { width: 210mm; min-height: 297mm; box-sizing: border-box;\n           padding: 16mm 18mm; margin: 12px auto; background: white;\n           box-shadow: 0 4px 18px rgba(15,23,42,0.10); }\n   @media print { .page { margin: 0; box-shadow: none; } body { background: white; } }\n   \`\`\`\n\n` +
      `   E tutto il contenuto DEVE stare dentro \`<div class="page">...</div>\` (una o più pagine se serve). Mai larghezza maggiore di 210mm.\n` +
      `3. Font: \`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif\`.\n` +
      `4. **Cap 180KB**: se sfori il tool rifiuta. Sintetizza.\n\n` +
      `### Linee guida grafiche moderne\n\n` +
      `Usa una **palette accent coerente** dichiarata all'inizio del \`<style>\`:\n\n` +
      `   \`\`\`css\n   :root {\n     --accent: #4f46e5;       /* indigo principale */\n     --accent-soft: #eef2ff;  /* background hero */\n     --ink: #0f172a;          /* testo principale */\n     --muted: #64748b;        /* testo secondario */\n     --border: #e2e8f0;\n     --ok: #10b981;\n     --warn: #f59e0b;\n   }\n   \`\`\`\n\n` +
      `**Hero header**: blocco in cima con sfondo accent-soft, titolo grande (28-32px), riga sottotitolo, gradient/border-radius/numero documento ben visibile.\n` +
      `**Cards / sezioni**: \`background:white; border:1px solid var(--border); border-radius:10px; padding:18px; margin:14px 0; box-shadow:0 1px 2px rgba(15,23,42,0.04);\`.\n` +
      `**Titoli sezione** con numerazione (1. 2. 3.) e un sottile bordo accent a sinistra: \`border-left:3px solid var(--accent); padding-left:10px;\`.\n` +
      `**Tabelle prezzi**: header con \`background:var(--accent); color:white; font-weight:600;\`, celle con border-bottom \`var(--border)\`, riga totale grassetto su \`background:var(--accent-soft)\`. Importo allineato destra con \`font-variant-numeric:tabular-nums; font-feature-settings:"tnum";\`.\n` +
      `**Badge/pill**: \`display:inline-block; padding:3px 10px; border-radius:999px; background:var(--accent-soft); color:var(--accent); font-size:11px; font-weight:600;\` per stati/validità/sconti.\n` +
      `**Callout informativi**: box colorati con icona SVG inline a sinistra (info=blu, warning=arancio, ok=verde). Esempio: \`<div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:12px 16px;border-radius:6px;display:flex;gap:10px;"><svg width="20" ...>...</svg><div>Testo del warning…</div></div>\`.\n` +
      `**Grafici/icone**: SVG inline calcolando le coordinate. Bar chart, line chart, pie, donut tutti fattibili senza JS. Per icone usa SVG line minimaliste (Lucide style).\n` +
      `**Footer**: linea sottile separatrice + dati mittente piccoli (P.IVA, indirizzo, contatti) in \`color:var(--muted); font-size:10.5px;\`.\n\n` +
      `### Scheletro completo del documento (parti da qui)\n\n` +
      `\`\`\`html\n<!doctype html><html lang="it"><head><meta charset="UTF-8">\n<title>Titolo documento</title>\n<style>\n  @page { size: A4; margin: 0; }\n  html, body { margin: 0; padding: 0; }\n  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; background: #e2e8f0; }\n  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;\n         line-height: 1.55; color: #0f172a; }\n  .page { width: 210mm; min-height: 297mm; box-sizing: border-box;\n          padding: 16mm 18mm; margin: 12px auto; background: white;\n          box-shadow: 0 4px 18px rgba(15,23,42,0.10); }\n  @media print { .page { margin: 0; box-shadow: none; } body { background: white; } }\n  :root { --accent: #4f46e5; --accent-soft: #eef2ff; --ink: #0f172a; --muted: #64748b; --border: #e2e8f0; }\n  .hero { background: linear-gradient(135deg,var(--accent-soft),#fff); border:1px solid var(--border); border-radius:12px; padding:20px 22px; margin-bottom:18px; display:flex; justify-content:space-between; align-items:flex-start; }\n  .kicker { font-size:11px; font-weight:700; letter-spacing:0.10em; text-transform:uppercase; color:var(--accent); }\n  h1 { font-size:24px; margin:4px 0 2px; color:var(--ink); }\n  h2 { font-size:14px; margin:18px 0 8px; color:var(--ink); border-left:3px solid var(--accent); padding-left:10px; }\n  table { width:100%; border-collapse:collapse; margin:8px 0; }\n  th { background:var(--accent); color:white; padding:8px 10px; font-size:11px; text-align:left; }\n  td { padding:8px 10px; border-bottom:1px solid var(--border); font-size:12px; }\n  tr:nth-child(even) td { background:#fafafa; }\n  .num { text-align:right; font-variant-numeric:tabular-nums; }\n  .total { background:var(--accent-soft); font-weight:700; }\n  .footer { font-size:10.5px; color:var(--muted); margin-top:18px; padding-top:10px; border-top:1px solid var(--border); }\n</style></head>\n<body>\n  <div class="page">\n    <div class="hero">\n      <div>\n        <div class="kicker">Offerta commerciale</div>\n        <h1>N. 2026-XXX · Titolo</h1>\n        <div style="color:var(--muted);">Sottotitolo</div>\n      </div>\n      <div style="background:white;border:1px solid var(--border);border-radius:8px;padding:8px 12px;text-align:right;">\n        <div style="font-size:10px;color:var(--muted);">Data</div>\n        <div style="font-weight:700;">29/05/2026</div>\n      </div>\n    </div>\n    <!-- sezioni qui -->\n    <div class="footer">[Ragione sociale dal PROFILO UTENTE] · P.IVA [dal profilo] · [email account]</div>\n  </div>\n</body></html>\n\`\`\`\n\nNel footer e nell'header usa SEMPRE i dati reali dal blocco PROFILO UTENTE del contesto live (ragione sociale, P.IVA, indirizzo, contatti). Se un dato manca, omettilo — mai inventarlo.\n\n` +
      `### Contenuto preventivi\n` +
      `- Hero con numero/data/validità\n` +
      `- Card "Cliente" con dati anagrafici (da \`customer_get\`)\n` +
      `- Sezioni numerate (Obiettivo, Funzionalità, Tempi, Investimento, Pagamento, Garanzie)\n` +
      `- Tabella prezzi con totale ben visibile (background accent + font-size 18px sul totale finale)\n` +
      `- Pricing: usa SEMPRE \`pricing_resolve\` per ogni articolo. Mai inventare prezzi.\n` +
      `- Footer firma\n\n` +
      `Dopo \`document_compose_html\` l'utente vede l'anteprima e può: 🖨 stampare/PDF, 💾 salvare HTML, 📎 allegare a email.\n\n` +
      `─────────── CONTESTO LIVE (snapshot di QUESTO turno) ───────────\n${liveContext}\n─────────── FINE CONTESTO LIVE ───────────\n${attachContext}`
    );
  }

  /** Chiede conferma all'utente per un tool sensibile. La promise si risolve
   *  solo quando l'utente decide: finché è pendente, il tool non viene eseguito. */
  function askConsent(call: ToolCall, action: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      setPendingConsent({
        call,
        action,
        decide: (allow) => {
          setPendingConsent(null);
          resolve(allow);
        },
      });
    });
  }

  /** Estrae la proposta renderizzabile da un risultato tool, se c'è. */
  function proposalFrom(result: unknown): Proposal | null {
    const rr = result as Record<string, unknown> | null;
    if (rr?.kind !== 'proposal') return null;
    if (rr.proposalType === 'compose_draft' && rr.draft) {
      const d = rr.draft as Record<string, unknown>;
      const proposal: ComposeDraftProposal = {
        type: 'compose_draft',
        summary: (rr.summary as string) || 'Bozza email pronta',
        draft: {
          to: (d.to as string[]) ?? [],
          cc: (d.cc as string[]) ?? [],
          subject: (d.subject as string) ?? '',
          bodyText: (d.bodyText as string) ?? '',
          bodyHtml: (d.bodyHtml as string | null) ?? null,
          inReplyTo: (d.inReplyTo as string | null) ?? null,
        },
      };
      return proposal;
    }
    if (rr.proposalType === 'compose_html' && rr.document) {
      const d = rr.document as Record<string, unknown>;
      const proposal: ComposeHtmlProposal = {
        type: 'compose_html',
        summary: (rr.summary as string) || 'Documento HTML pronto',
        document: {
          title: (d.title as string) ?? 'Documento',
          docKind: (d.docKind as ComposeHtmlProposal['document']['docKind']) ?? 'other',
          html: (d.html as string) ?? '',
          customerId: (d.customerId as number | null) ?? null,
          suggestedFilename: (d.suggestedFilename as string) ?? 'documento.html',
        },
      };
      return proposal;
    }
    return null;
  }

  /** Testo del risultato reinserito nella history del modello. Le proposte
   *  non rientrano col payload completo (l'HTML può essere enorme). */
  function resultForModel(r: ToolCallResult): string {
    if (r.error) return `ERRORE: ${r.error}`;
    const rr = r.result as Record<string, unknown> | null;
    if (rr?.kind === 'proposal') {
      const summary = (rr.summary as string) || 'proposta creata';
      return `${summary}. La card è mostrata all'utente: l'azione NON è ancora avvenuta, deve confermarla lui. Non ripetere il contenuto, è già nell'UI.`;
    }
    // I tool ritornano un campo `text` in italiano (formato Liara): se c'è,
    // è quello che il modello deve leggere.
    if (rr && typeof rr.text === 'string' && rr.text.length > 0) return rr.text;
    let json = JSON.stringify(r.result, null, 2);
    if (json.length > 8000) {
      json = json.slice(0, 8000) + '\n…[troncato]';
    }
    return json;
  }

  /** Loop tool-calling: tool nativi + consent gate sui tool sensibili. */
  async function runWithTools(opts: {
    systemPrompt: string;
    history: ChatTurn[];
  }): Promise<{ finalText: string; trace: ToolCallResult[]; proposals: Proposal[] }> {
    const proposals: Proposal[] = [];
    const MAX_ROUNDS = 5;
    let history = opts.history.slice();
    const trace: ToolCallResult[] = [];
    let lastText = '';
    const conn = await providerConnection(provider);
    const tools = toolRegistry.length > 0 ? toOpenAiTools(toolRegistry) : undefined;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const reply = await aiApi.chat({
        provider,
        systemPrompt: opts.systemPrompt,
        history,
        apiKey: conn.apiKey,
        baseUrl: conn.baseUrl,
        model: conn.model,
        tools,
      });
      lastText = reply.content;
      if (reply.toolCalls.length === 0) break;

      const results: ToolCallResult[] = [];
      for (const c of reply.toolCalls) {
        const call: ToolCall = { id: c.id, name: c.name, args: c.arguments };
        const descriptor = toolRegistry.find((t) => t.name === c.name);
        let r: ToolCallResult;
        if (descriptor?.kind === 'sensitive') {
          const allowed = await askConsent(call, consentAction(call, descriptor));
          r = allowed
            ? await callTool(call)
            : {
                call,
                result: null,
                error: `Permesso negato dall'utente: ${consentAction(call, descriptor)}`,
                startedAt: new Date().toISOString(),
                finishedAt: new Date().toISOString(),
                durationMs: 0,
              };
        } else {
          r = await callTool(call);
        }
        results.push(r);
        trace.push(r);
        const proposal = proposalFrom(r.result);
        if (proposal) proposals.push(proposal);
      }

      history = [
        ...history,
        {
          role: 'assistant',
          content: reply.content,
          toolCalls: reply.toolCalls.map((c) => ({
            id: c.id,
            type: 'function' as const,
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          })),
        },
        ...results.map((r) => ({
          role: 'tool' as const,
          content: resultForModel(r),
          toolCallId: r.call.id,
          name: r.call.name,
        })),
      ];
    }

    let finalText = lastText.trim();
    if (finalText.length === 0) {
      finalText = trace.length > 0
        ? `_(L'assistente ha eseguito ${trace.length.toString()} chiamate tool ma non ha prodotto una risposta finale. Apri il pannello "🔧 tool call eseguite" qui sotto per vedere i dati grezzi.)_`
        : '_(L\'assistente ha risposto con contenuto vuoto. Riprova o cambia provider.)_';
    }
    return { finalText, trace, proposals };
  }

  // ── Send ────────────────────────────────────────────────────────────────────
  async function send() {
    const text = input.trim();
    if ((!text && pendingAttachments.length === 0) || streaming) return;

    const conv = ensureConversation();
    const userMsg: ChatMessageEx = {
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
      ...(pendingAttachments.length > 0 ? { attachments: pendingAttachments } : {}),
    };
    const currentMsgs = conv.messages;
    const nextHistory = [...currentMsgs, userMsg];
    setMessagesForConv(conv.id, nextHistory);

    // Se il titolo è ancora default, generalo dal primo messaggio user
    if (conv.title === 'Nuova conversazione' && nextHistory.filter((m) => m.role === 'user').length === 1) {
      const t = autoTitle(nextHistory);
      updateConversation(conv.id, { title: t });
    }

    setInput('');
    setPendingAttachments([]);
    setError(null);
    setStreaming(true);

    const placeholder: ChatMessageEx = { role: 'assistant', content: '', timestamp: new Date().toISOString() };
    setActiveMessages([...nextHistory, placeholder]);

    try {
      const liveContext = await buildLiveContext();
      const attachContext = pendingAttachments.length > 0
        ? `\n\n=== ALLEGATI UTENTE ===\n${pendingAttachments
            .map((a) => describeAttachment(a))
            .join('\n')}\n=== FINE ALLEGATI ===\n`
        : '';

      const { finalText, trace, proposals } = await runWithTools({
        systemPrompt: buildSystemPrompt(liveContext, attachContext),
        history: nextHistory.map(toChatTurn),
      });
      setLastTrace(trace);

      const extracted = extractMemoriesFromReply(finalText);
      for (const t of extracted) await addMemory(t, 'assistant', 'normal');
      const cleanReply = stripMemoryMarkers(finalText);

      const finalMsgs: ChatMessageEx[] = [
        ...nextHistory,
        {
          role: 'assistant',
          content: cleanReply,
          timestamp: new Date().toISOString(),
          ...(proposals.length > 0 ? { proposals } : {}),
        },
      ];
      setMessagesForConv(conv.id, finalMsgs);
      refreshList();
    } catch (e) {
      setError(String(e));
      setMessagesForConv(conv.id, nextHistory);
    } finally {
      setStreaming(false);
    }
  }

  async function regenerateLast() {
    if (!active || active.messages.length < 2 || streaming) return;
    const base = active.messages.slice(0, -1);
    setActiveMessages(base);
    const placeholder: ChatMessageEx = { role: 'assistant', content: '', timestamp: new Date().toISOString() };
    setActiveMessages([...base, placeholder]);
    setStreaming(true);
    try {
      const liveContext = await buildLiveContext();
      // Stesso percorso di send(): loop tool-calling completo, non chat "nuda"
      // (altrimenti la rigenerazione avrebbe capacità diverse dall'invio).
      const { finalText, trace, proposals } = await runWithTools({
        systemPrompt: buildSystemPrompt(liveContext, ''),
        history: base.map(toChatTurn),
      });
      setLastTrace(trace);
      const clean = stripMemoryMarkers(finalText);
      for (const t of extractMemoriesFromReply(finalText)) await addMemory(t, 'assistant');
      setActiveMessages([...base, {
        role: 'assistant',
        content: clean,
        timestamp: new Date().toISOString(),
        ...(proposals.length > 0 ? { proposals } : {}),
      }]);
    } catch (e) {
      setError(String(e));
      setActiveMessages(base);
    } finally {
      setStreaming(false);
    }
  }

  async function copyToClipboard(text: string, idx: number) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      setTimeout(() => { setCopiedIdx(null); }, 1500);
    } catch { /* ignore */ }
  }

  async function saveAsMemory(text: string) {
    const trimmed = text.trim().slice(0, 600);
    if (!trimmed) return;
    await addMemory(trimmed, 'manual', 'normal');
  }

  const last = history[history.length - 1];
  const isLastPlaceholder = streaming && last?.role === 'assistant' && last.content === '';
  const canSend = (input.trim().length > 0 || pendingAttachments.length > 0) && !streaming;

  return (
    <aside className={styles.panel} aria-label="AI Assistant">
      <ConversationsSidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={handleSelect}
        onNew={handleNew}
        onRename={handleRename}
        onDelete={handleDelete}
        collapsed={sidebarCollapsed}
        onToggle={() => { setSidebarCollapsed(!sidebarCollapsed); }}
      />

      <div className={styles.main}>
        <header className={styles.head}>
          <div className={styles.title}>
            <span className={styles.glyph}>✨</span>
            <span className={styles.titleText}>
              {active?.title ?? 'Assistente AI'}
            </span>
          </div>
          <div className={styles.headActions}>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => void runSilentInboxSync()}
              title={syncingInbox ? 'Sincronizzando…' : 'Aggiorna INBOX'}
              aria-label="Aggiorna INBOX"
              disabled={syncingInbox}
            >
              {syncingInbox ? '⟳' : '↻'}
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => { setMemoryOpen(true); }}
              title="Memorie persistenti"
              aria-label="Memorie persistenti"
            >
              🧠
            </button>
            <select
              className={styles.providerSelect}
              value={provider}
              onChange={(e) => {
                const next = e.target.value as ProviderId;
                setProvider(next);
                localStorage.setItem(DEFAULT_PROVIDER_KEY, next);
              }}
              aria-label="Provider AI"
            >
              <option value="liara">Liara</option>
              <option value="custom">Endpoint personale</option>
              <option value="anthropic">Claude</option>
              <option value="openai">OpenAI</option>
              <option value="gemini">Gemini</option>
              <option value="deepseek">DeepSeek</option>
              <option value="grok">Grok</option>
              <option value="openrouter">OpenRouter</option>
            </select>
            <button type="button" className={styles.iconBtn} onClick={onClose} title="Chiudi" aria-label="Chiudi">✕</button>
          </div>
        </header>

        <div className={styles.body}>
          {history.length === 0 && (
            <div className={styles.empty}>
              <div className={styles.emptyGlyph}>✨</div>
              <h2 className={styles.emptyTitle}>Come posso aiutarti?</h2>
              <p className={styles.emptyText}>
                Posso leggere il DB locale, riassumere, scrivere bozze, estrarre task e ricordare fatti tra le conversazioni.
              </p>
              <div className={styles.suggestionsGrid}>
                {[
                  'Riassumi le email di oggi',
                  'Scrivi una bozza di risposta cortese',
                  'Estrai i task dalla mia INBOX',
                  'Chi non mi ha ancora risposto?',
                ].map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={styles.suggCard}
                    onClick={() => { setInput(s); textareaRef.current?.focus(); }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {history.map((m, i) => {
            const isLast = i === history.length - 1;
            const showThinking = streaming && isLast && m.role === 'assistant' && !m.content;
            const showCopy = m.role === 'assistant' && !showThinking && m.content.length > 0;
            const showRegen = isLast && m.role === 'assistant' && !showThinking && !streaming;
            const showMemorize = m.role === 'assistant' && !showThinking && m.content.length > 0;
            return (
              <article key={i} className={`${styles.turn} ${styles[`turn_${m.role}`] ?? ''}`}>
                <div className={styles.avatar} aria-hidden>
                  {m.role === 'user'
                    ? (userPhoto
                        ? <img src={userPhoto} alt="" style={{ width: '1.5em', height: '1.5em', borderRadius: '50%', objectFit: 'cover' }} />
                        : '👤')
                    : '✨'}
                </div>
                <div className={styles.turnBody}>
                  <div className={styles.turnHead}>
                    <span className={styles.author}>
                      {m.role === 'user' ? userName : providerLabel(provider)}
                    </span>
                    {m.timestamp && (
                      <span className={styles.time}>
                        {new Date(m.timestamp).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </div>
                  <div className={styles.bubble}>
                    {showThinking ? (
                      <div className={styles.thinking} aria-label="Sto pensando">
                        <span className={styles.dot} />
                        <span className={styles.dot} />
                        <span className={styles.dot} />
                      </div>
                    ) : m.role === 'assistant' ? (
                      <Markdown source={m.content} />
                    ) : (
                      <div className={styles.userText}>{m.content || <em className={styles.muted}>(solo allegati)</em>}</div>
                    )}
                    {m.attachments && m.attachments.length > 0 && (
                      <div className={styles.attachList}>
                        {m.attachments.map((a, k) => (
                          <div key={k} className={styles.attachChip}>
                            📎 {a.name} <span className={styles.attachMeta}>· {fmtSize(a.size)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {m.proposals && m.proposals.length > 0 && (
                      <div className={styles.proposalList}>
                        {m.proposals.map((p, k) => {
                          const exec = (m.proposalExecutions ?? []).find((e) => e.proposalIndex === k);
                          return (
                            <ProposalCard
                              key={k}
                              proposal={p}
                              account={account}
                              {...(exec ? { execution: exec } : {})}
                              onExecuted={(ex) => { recordProposalExecution(i, { ...ex, proposalIndex: k }); }}
                            />
                          );
                        })}
                      </div>
                    )}
                  </div>
                  {(showCopy || showRegen || showMemorize) && (
                    <div className={styles.actions}>
                      {showCopy && (
                        <button type="button" className={styles.actionBtn} onClick={() => copyToClipboard(m.content, i)}>
                          {copiedIdx === i ? '✓ Copiato' : '⎘ Copia'}
                        </button>
                      )}
                      {showMemorize && (
                        <button type="button" className={styles.actionBtn} onClick={() => { void saveAsMemory(m.content); }}>
                          🧠 Salva come memoria
                        </button>
                      )}
                      {showRegen && (
                        <button type="button" className={styles.actionBtn} onClick={() => void regenerateLast()}>
                          ↻ Rigenera
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
          {pendingConsent && (
            <ConsentCard
              call={pendingConsent.call}
              action={pendingConsent.action}
              onDecide={pendingConsent.decide}
            />
          )}

          {lastTrace.length > 0 && (
            <details className={styles.toolTrace}>
              <summary>
                🔧 {lastTrace.length} tool call eseguite — clicca per dettagli
                {lastTrace.some((t) => t.error) && <span className={styles.toolTraceError}> · errori presenti</span>}
              </summary>
              <div className={styles.toolTraceList}>
                {lastTrace.map((t, i) => (
                  <div key={i} className={`${styles.toolTraceItem} ${t.error ? styles.toolTraceItemError : ''}`}>
                    <div className={styles.toolTraceHead}>
                      <code>{t.call.name}</code>
                      <span className={styles.toolTraceDur}>{t.durationMs} ms</span>
                    </div>
                    <pre className={styles.toolTraceBody}>
{`args: ${JSON.stringify(t.call.args)}
${t.error ? 'ERROR: ' + t.error : 'result: ' + JSON.stringify(t.result, null, 2).slice(0, 1200) + (JSON.stringify(t.result).length > 1200 ? '…' : '')}`}
                    </pre>
                  </div>
                ))}
              </div>
            </details>
          )}
          <div ref={bottomRef} />
        </div>

        {error && (
          <div className={styles.error} role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => { setError(null); }} aria-label="Chiudi errore">✕</button>
          </div>
        )}

        <footer className={styles.composer}>
          {streaming && (
            <div className={styles.streamingBanner}>
              <span className={styles.streamingDots}>
                <span className={styles.dot} />
                <span className={styles.dot} />
                <span className={styles.dot} />
              </span>
              <span className={styles.streamingText}>
                {providerLabel(provider)} sta lavorando — {lastTrace.length > 0
                  ? `${lastTrace.length.toString()} chiamate tool eseguite`
                  : 'analisi del contesto…'}
              </span>
            </div>
          )}

          {pendingAttachments.length > 0 && (
            <div className={styles.pendingList}>
              {pendingAttachments.map((a, i) => (
                <div key={i} className={styles.pendingChip}>
                  {a.type.startsWith('image/') ? '🖼' : '📎'} {a.name}
                  <span className={styles.attachMeta}> · {fmtSize(a.size)}</span>
                  <button type="button" className={styles.chipRemove} onClick={() => { removeAttachment(i); }} aria-label="Rimuovi">✕</button>
                </div>
              ))}
            </div>
          )}

          {activeMessage && (
            <label className={styles.contextToggle}>
              <input
                type="checkbox"
                checked={includeMessage}
                onChange={(e) => { setIncludeMessage(e.target.checked); }}
              />{' '}
              Includi email aperta nel contesto
              <span className={styles.contextHint}>
                {' '}({activeMessage.subject?.slice(0, 50) ?? 'senza oggetto'}…)
              </span>
            </label>
          )}

          <div className={styles.inputBox}>
            <textarea
              ref={textareaRef}
              className={styles.textarea}
              value={input}
              onChange={(e) => { setInput(e.target.value); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder="Scrivi un messaggio…  (Invio = invia · Shift+Invio = nuova riga)"
              rows={2}
            />
            <div className={styles.inputToolbar}>
              <div className={styles.inputTools}>
                <button type="button" className={styles.toolBtn} onClick={() => { pickFiles('image/*'); }} title="Allega immagine" aria-label="Allega immagine">🖼</button>
                <button type="button" className={styles.toolBtn} onClick={() => { pickFiles('.pdf,.doc,.docx,.txt,.csv,.xlsx,.xls'); }} title="Allega documento" aria-label="Allega documento">📎</button>
                <button type="button" className={styles.toolBtn} onClick={() => { pickFiles('*/*'); }} title="Allega qualsiasi file" aria-label="Allega file">＋</button>
                <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => { void onFileSelected(e); }} />
              </div>
              <button type="button" className={styles.sendBtn} onClick={() => void send()} disabled={!canSend} title="Invia (Invio)" aria-label="Invia">
                {streaming && !isLastPlaceholder ? '…' : '▶'}
              </button>
            </div>
          </div>

          <div className={styles.hint}>
            Provider: <strong>{providerLabel(provider)}</strong>
            <span> · BYOK — configura in Impostazioni → Modelli AI</span>
            {lastSyncAt && <span> · INBOX agg. {new Date(lastSyncAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</span>}
          </div>
        </footer>
      </div>

      <MemoryDrawer open={memoryOpen} onClose={() => { setMemoryOpen(false); }} />
    </aside>
  );
}
