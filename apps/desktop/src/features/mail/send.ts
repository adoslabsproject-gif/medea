/**
 * Invio email con archiviazione in "Inviati" e salvataggio bozze.
 *
 * Logica condivisa tra il Composer e le card AI (ProposalCard):
 * 1. invia UNA volta sola via SMTP;
 * 2. scopre le cartelle reali del server IMAP e ordina i candidati
 *    (pattern-match → hard-coded esistenti → best-effort);
 * 3. APPEND della copia nella prima cartella che accetta;
 * 4. sync della cartella per far comparire subito il messaggio in lista.
 */

import { mailApi } from './api';
import type { MailAccount, OutgoingMessage } from './types';

export interface ArchiveResult {
  ok: boolean;
  folder: string | null;
  available: string[];
  error: string | null;
}

/**
 * Ordina i candidati cartella: prima le cartelle reali che matchano i pattern,
 * poi i candidati hard-coded che esistono sul server (case-insensitive),
 * infine quelli generici dalla lista hard-coded (APPEND può crearle).
 */
export function orderCandidates(real: string[], generic: string[], patterns: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const lc = real.map((r) => ({ raw: r, low: r.toLowerCase() }));

  for (const p of patterns) {
    for (const f of lc) {
      if (f.low.includes(p) && !seen.has(f.raw)) {
        seen.add(f.raw);
        result.push(f.raw);
      }
    }
  }
  for (const g of generic) {
    const match = real.find((r) => r.toLowerCase() === g.toLowerCase());
    if (match && !seen.has(match)) {
      seen.add(match);
      result.push(match);
    }
  }
  for (const g of generic) {
    if (!seen.has(g)) {
      seen.add(g);
      result.push(g);
    }
  }
  return result;
}

function isGmail(email: string): boolean {
  const d = email.toLowerCase().split('@')[1] ?? '';
  return d.endsWith('gmail.com') || d.endsWith('googlemail.com');
}

export function draftsCandidatesFor(email: string): string[] {
  const gmail = ['[Gmail]/Drafts', 'Gmail/Drafts', 'Drafts'];
  const generic = ['Drafts', 'Bozze', 'INBOX/Drafts', 'INBOX.Drafts', 'INBOX/Bozze', 'INBOX.Bozze'];
  return isGmail(email) ? [...gmail, ...generic] : [...generic, ...gmail];
}

export function sentCandidatesFor(email: string): string[] {
  const gmail = ['[Gmail]/Sent Mail', 'Gmail/Sent', 'Sent'];
  const generic = [
    'Sent',
    'Sent Items',
    'Sent Messages',
    'Sent Mail',
    'Inviati',
    'Posta inviata',
    'INBOX/Sent',
    'INBOX.Sent',
    'INBOX/Inviati',
    'INBOX.Inviati',
  ];
  return isGmail(email) ? [...gmail, ...generic] : [...generic, ...gmail];
}

/**
 * Invia via SMTP e archivia la copia in "Inviati". L'invio avvenuto è
 * garantito se la promise risolve; l'esito dell'archiviazione è nel risultato.
 * Dopo l'archiviazione lancia il sync della cartella ed emette
 * `medea:mailbox-changed` (fire-and-forget).
 */
export async function sendAndArchive(
  account: MailAccount,
  msg: OutgoingMessage,
): Promise<ArchiveResult> {
  const smtpStatus = await mailApi.smtp.send(account.smtp, msg);
  console.info('[Medea] SMTP send ok:', smtpStatus);

  const realFolders = await mailApi.imap.listFolders(account.imap).catch(() => []);
  const candidates = orderCandidates(
    realFolders.map((f) => f.name),
    sentCandidatesFor(account.emailAddress),
    ['sent', 'inviat', 'posta inviata'],
  );
  const eml = await mailApi.smtp.buildEml(msg);
  let archivedFolder: string | null = null;
  let lastErr = '';
  for (const folder of candidates) {
    try {
      await mailApi.imap.append(account.imap, folder, eml, ['\\Seen']);
      archivedFolder = folder;
      console.info(`[Medea] copia archiviata in IMAP "${folder}"`);
      break;
    } catch (e) {
      lastErr = String(e);
      console.warn(`[Medea] append a "${folder}" fallito:`, lastErr);
    }
  }

  if (archivedFolder) {
    const folder = archivedFolder;
    void mailApi.sync
      .folder(account.id, account.imap, folder, 'sent', 30)
      .then(() => {
        console.info('[Medea] sync Sent dopo invio: ok');
        window.dispatchEvent(new CustomEvent('medea:mailbox-changed', { detail: { folder } }));
      })
      .catch((e: unknown) => {
        console.warn('[Medea] sync Sent fallito:', e);
      });
  }

  return {
    ok: archivedFolder !== null,
    folder: archivedFolder,
    available: realFolders.map((f) => f.name),
    error: archivedFolder ? null : lastErr,
  };
}

/**
 * Salva una bozza nella cartella Drafts del server. Ritorna il nome della
 * cartella usata; lancia se nessuna cartella accetta la bozza.
 */
export async function saveDraftSmart(account: MailAccount, msg: OutgoingMessage): Promise<string> {
  const realFolders = await mailApi.imap.listFolders(account.imap).catch(() => []);
  const candidates = orderCandidates(
    realFolders.map((f) => f.name),
    draftsCandidatesFor(account.emailAddress),
    ['draft', 'bozz'],
  );
  let lastErr = '';
  for (const folder of candidates) {
    try {
      await mailApi.smtp.saveDraft(account.imap, folder, msg);
      console.info(`[Medea] bozza salvata in IMAP "${folder}"`);
      return folder;
    } catch (e) {
      lastErr = String(e);
      console.warn(`[Medea] save draft a "${folder}" fallito:`, lastErr);
    }
  }
  throw new Error(
    `Cartella Drafts non trovata. Cartelle disponibili sul server: ${realFolders.map((f) => f.name).join(', ') || '(nessuna)'}. Ultimo errore: ${lastErr}`,
  );
}
