/**
 * `action_email_move` — sposta o copia messaggi fra cartelle IMAP.
 *
 * È il nodo con cui si archivia la posta, e fino al 2026-08-05 nel catalogo non
 * esisteva: chi chiedeva «archivia le newsletter più vecchie di 30 giorni»
 * otteneva workflow che scrivevano file di testo con dentro date inventate,
 * perché il pezzo giusto non c'era e il modello copriva il buco.
 *
 * Vive qui e non nel pacchetto `stdlib` perché `imapflow` e gli account email
 * del tenant sono già in casa: lo stdlib resta senza dipendenze pesanti e
 * continua a compilarsi ovunque (stesso schema di `action_email_send_tracked`).
 *
 * @module executors/email-move
 */

import { ImapFlow, type SearchObject } from 'imapflow';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { EmailMoveConfigSchema } from '@medea/engine-nodes-stdlib';
import { assertConnectHostAllowed } from '@/lib/connect-host-guard.js';
import { SystemEmailAccountsService } from '@/services/system-email-accounts.service.js';

const systemEmailAccounts = new SystemEmailAccountsService();

/** Un messaggio come lo si racconta a chi legge il risultato. */
interface MessaggioSpostato {
  uid: number;
  subject: string;
  from: string;
  date: string | null;
  hasAttachment: boolean;
}

/** Millisecondi in un giorno, per i criteri di età. */
const GIORNO_MS = 86_400_000;

/**
 * Vero se la struttura del messaggio contiene qualcosa che l'utente
 * chiamerebbe allegato.
 *
 * IMAP non ha un criterio di ricerca per «ha allegati»: va guardata la
 * struttura del corpo. Si escludono le parti `inline` — le immagini incorporate
 * in una firma sono tecnicamente allegati e nessuno le considera tali.
 */
function haAllegati(struttura: unknown): boolean {
  if (!struttura || typeof struttura !== 'object') return false;
  const nodo = struttura as { disposition?: string; childNodes?: unknown[] };
  if (typeof nodo.disposition === 'string' && nodo.disposition.toLowerCase() === 'attachment') {
    return true;
  }
  return Array.isArray(nodo.childNodes) ? nodo.childNodes.some(haAllegati) : false;
}

/**
 * Gli uid indicati dal flusso, letti da un valore che può arrivare in più
 * forme: un numero, una stringa, un elenco separato da virgole.
 *
 * Un'espressione non risolta — `{{...}}` ancora intera — non è un uid: vuol
 * dire che il nodo a monte non ha prodotto quel campo, e agire ignorandolo
 * porterebbe a cercare alla cieca proprio quando si voleva essere precisi.
 */
function uidDaConfig(valore: string | undefined): number[] {
  if (!valore || valore.includes('{{')) return [];
  return valore
    .split(/[,;\s]+/)
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Il criterio di ricerca IMAP, per ciò che il server sa filtrare da solo. */
function criterioRicerca(c: {
  olderThanDays?: number | undefined;
  newerThanDays?: number | undefined;
  filterFrom?: string | undefined;
  filterSubject?: string | undefined;
  readState: 'any' | 'seen' | 'unseen';
}): SearchObject {
  const query: SearchObject = {};
  const ora = Date.now();

  // `before` e `since` lavorano sulla data interna del server, che è quella
  // giusta: la data scritta nell'intestazione la decide chi manda, e chi manda
  // spam la sbaglia apposta.
  if (c.olderThanDays !== undefined && c.olderThanDays > 0) {
    query.before = new Date(ora - c.olderThanDays * GIORNO_MS);
  }
  if (c.newerThanDays !== undefined && c.newerThanDays > 0) {
    query.since = new Date(ora - c.newerThanDays * GIORNO_MS);
  }
  if (c.filterFrom) query.from = c.filterFrom;
  if (c.filterSubject) query.subject = c.filterSubject;
  if (c.readState === 'seen') query.seen = true;
  if (c.readState === 'unseen') query.seen = false;

  // Un criterio vuoto prenderebbe tutta la cartella. `all: true` lo rende
  // esplicito invece di lasciarlo implicito in un oggetto senza chiavi.
  if (Object.keys(query).length === 0) query.all = true;
  return query;
}

export const emailMoveExecutor: NodeExecutor = async (config, _input, context) => {
  const parsed = EmailMoveConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(
      `action_email_move: configurazione non valida — ${parsed.error.issues.map((i: { message: string }) => i.message).join('; ')}`,
    );
  }
  const c = parsed.data;
  const sposta = c.operation === 'move' || c.operation === 'copy';
  // Lo schema garantisce che ci sia quando serve; qui si legge senza `!`.
  const destinazione = c.targetMailbox ?? '';

  let host = c.host ?? '';
  let port = c.port;
  let username = c.username ?? '';
  let password = c.password ?? '';

  if (c.systemAccountId) {
    const account = systemEmailAccounts.resolveForExecutor(context.tenantId, c.systemAccountId);
    if (!account) {
      throw new Error(
        `action_email_move: account «${c.systemAccountId}» non trovato per il tenant`,
      );
    }
    if (!account.imap) {
      throw new Error(
        `action_email_move: l'account «${c.systemAccountId}» non ha una configurazione IMAP — ` +
          'ha solo l’invio. Aggiungila in Impostazioni → Account email.',
      );
    }
    host = account.imap.host;
    port = account.imap.port;
    username = account.imap.username;
    password = account.imap.password ?? '';
  }

  if (!host || !username) {
    throw new Error('action_email_move: host e utente sono obbligatori.');
  }
  // L'host arriva dalla configurazione, quindi da dato dell'utente: senza
  // questo controllo un workflow potrebbe farsi aprire una connessione verso
  // la rete interna.
  assertConnectHostAllowed(host, 'IMAP');

  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user: username, pass: password },
    logger: false,
    socketTimeout: c.timeoutMs,
  });

  const spostati: MessaggioSpostato[] = [];
  let trovati = 0;
  const inizio = Date.now();

  await client.connect();
  try {
    // La destinazione va creata **prima** di cercare: scoprire a metà che non
    // esiste lascerebbe metà messaggi spostati e metà no. Le operazioni che
    // segnano soltanto non hanno una destinazione: non c'è niente da creare.
    if (c.createTarget && sposta) {
      try {
        await client.mailboxCreate(destinazione);
      } catch {
        // Esiste già: è il caso normale dopo la prima esecuzione.
      }
    }

    const lock = await client.getMailboxLock(c.sourceMailbox);
    try {
      // Se il flusso dice SU QUALE messaggio agire, non si cerca: si agisce su
      // quello. È la differenza fra «segna come letta l'email appena arrivata»
      // e «segna come lette fino a duecento email che somigliano al criterio» —
      // la seconda, dietro un trigger, tocca messaggi che non c'entrano.
      const uidEsplicito = uidDaConfig(c.messageUid);
      let candidati: number[];
      if (uidEsplicito.length > 0) {
        candidati = uidEsplicito;
      } else {
        // `search` restituisce `false` quando la casella non supporta la
        // ricerca: normalizzarlo a lista vuota evita un `.length` su un booleano.
        const uids = await client.search(criterioRicerca(c), { uid: true });
        candidati = Array.isArray(uids) ? uids : [];
      }
      trovati = candidati.length;
      if (candidati.length === 0) {
        return {
          durationMs: Date.now() - inizio,
          output: {
            affected: 0,
            found: 0,
            wouldAffect: 0,
            messages: [],
            sourceMailbox: c.sourceMailbox,
            targetMailbox: sposta ? destinazione : null,
            operation: c.operation,
            dryRun: c.dryRun,
            truncated: false,
          },
        };
      }

      // Si guardano i candidati uno per uno perché «ha allegati» IMAP non lo sa
      // filtrare, e perché il risultato deve dire *quali* messaggi, non solo
      // quanti: un conteggio senza nomi non si può verificare.
      const daSpostare: number[] = [];
      for await (const messaggio of client.fetch(
        candidati,
        { uid: true, envelope: true, bodyStructure: true },
        { uid: true },
      )) {
        if (daSpostare.length >= c.maxMessages) break;
        const conAllegati = haAllegati(messaggio.bodyStructure);
        if (c.hasAttachment && !conAllegati) continue;
        const mittente = messaggio.envelope?.from?.[0];
        daSpostare.push(messaggio.uid);
        spostati.push({
          uid: messaggio.uid,
          subject: messaggio.envelope?.subject ?? '',
          from: mittente?.address ?? '',
          date: messaggio.envelope?.date?.toISOString() ?? null,
          hasAttachment: conAllegati,
        });
      }

      if (!c.dryRun && daSpostare.length > 0) {
        if (c.operation === 'mark_seen') {
          await client.messageFlagsAdd(daSpostare, ['\\Seen'], { uid: true });
        } else if (c.operation === 'mark_unseen') {
          await client.messageFlagsRemove(daSpostare, ['\\Seen'], { uid: true });
        } else if (c.operation === 'move') {
          await client.messageMove(daSpostare, destinazione, { uid: true });
        } else {
          await client.messageCopy(daSpostare, destinazione, { uid: true });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  return {
    durationMs: Date.now() - inizio,
    output: {
      /**
       * Quanti messaggi ha effettivamente toccato: spostati, copiati o segnati.
       *
       * Si chiama `affected` e non `moved` perché con `mark_seen`/`mark_unseen` non si
       * sposta proprio niente: un workflow che leggesse «moved» per annunciare «archiviati
       * N messaggi» riporterebbe un numero falso, e sarebbe una bugia difficile da notare.
       *
       * Zero quando è una prova: `dryRun` non tocca nulla, e dire il contrario sarebbe la
       * bugia più facile da scrivere qui.
       */
      affected: c.dryRun ? 0 : spostati.length,
      /** Quanti ne corrispondono al criterio, toccati o no. */
      found: trovati,
      /** Quanti ne verrebbero toccati: è il numero utile quando `dryRun` è acceso. */
      wouldAffect: spostati.length,
      messages: spostati,
      sourceMailbox: c.sourceMailbox,
      targetMailbox: sposta ? destinazione : null,
      operation: c.operation,
      dryRun: c.dryRun,
      /** Vero se il tetto ha tagliato: la prossima esecuzione riprende. */
      truncated: trovati > spostati.length,
    },
  };
};
