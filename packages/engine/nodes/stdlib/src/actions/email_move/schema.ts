/**
 * `action_email_move` — Zod config schema.
 *
 * @module actions/email_move/schema
 */

import { z } from 'zod';

const trimmed = z.string().trim();

/**
 * Le spunte arrivano dal modulo come stringhe, e `z.coerce.boolean()` è una
 * trappola: usa `Boolean()`, che rende `"false"` → `true`. Qui `"false"`,
 * `"0"`, `"off"` e `"no"` valgono falso davvero.
 */
const booleanish = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (v === '' || v === null || v === undefined) return undefined;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false;
  }
  if (typeof v === 'number') return v !== 0;
  return v;
}, z.boolean());

/**
 * Un intero che può arrivare come stringa dal modulo; vuoto = assente.
 *
 * Fabbrica invece di costante perché `z.preprocess` restituisce un
 * `ZodEffects`, su cui `.int()` e `.max()` non esistono più: i limiti vanno
 * messi dentro, prima dell'involucro.
 */
const intero = (min: number, max: number) =>
  z.preprocess((v) => {
    if (v === '' || v === null || v === undefined) return undefined;
    if (typeof v === 'string') {
      const n = Number(v.trim());
      return Number.isFinite(n) ? n : v;
    }
    return v;
  }, z.number().int().min(min).max(max));

export const EmailMoveConfigSchema = z
  .object({
    systemAccountId: trimmed.optional(),
    host: trimmed.optional(),
    port: intero(1, 65535).default(993),
    username: trimmed.optional(),
    password: z.string().optional(),

    sourceMailbox: trimmed.min(1).default('INBOX'),
    targetMailbox: trimmed.optional(),
    operation: z.enum(['move', 'copy', 'mark_seen', 'mark_unseen']).default('move'),
    /** Uid del messaggio su cui agire; tipicamente un'espressione dal trigger. */
    messageUid: trimmed.optional(),

    olderThanDays: intero(0, 36500).optional(),
    newerThanDays: intero(0, 36500).optional(),
    filterFrom: trimmed.optional(),
    filterSubject: trimmed.optional(),
    readState: z.enum(['any', 'seen', 'unseen']).default('any'),
    hasAttachment: booleanish.default(false),

    maxMessages: intero(1, 5000).default(200),
    createTarget: booleanish.default(true),
    dryRun: booleanish.default(false),
    timeoutMs: intero(1000, 600_000).default(60_000),
  })
  .superRefine((c, ctx) => {
    // Senza account di sistema servono le credenziali: meglio dirlo qui che
    // far fallire la connessione con un errore del server.
    if (!c.systemAccountId && (!c.host || !c.username || !c.password)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Scegli un account email di sistema, oppure indica host, utente e password.',
        path: ['systemAccountId'],
      });
    }
    const sposta = c.operation === 'move' || c.operation === 'copy';

    // Chi sposta deve dire dove. Chi segna soltanto non ha una destinazione, e
    // pretenderla lo costringerebbe a inventarne una che poi verrebbe ignorata.
    if (sposta && !c.targetMailbox) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Per «sposta» e «copia» serve la cartella di destinazione.',
        path: ['targetMailbox'],
      });
    }

    // Spostare una cartella dentro sé stessa non è un errore del server: è un
    // ciclo che il server esegue volentieri e che non fa quello che si voleva.
    if (sposta && c.sourceMailbox === c.targetMailbox) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Origine e destinazione sono la stessa cartella.',
        path: ['targetMailbox'],
      });
    }
    // Con un uid esplicito i criteri di ricerca NON vengono applicati: si agisce su
    // quel messaggio e basta. Accettarli in silenzio è peggio che rifiutarli — il
    // workflow farebbe qualcosa, ma non quello che chi l'ha scritto crede: «sposta il
    // messaggio del trigger, ma solo se più vecchio di 30 giorni» sposterebbe SEMPRE,
    // e il filtro dimenticato si scoprirebbe a danno fatto.
    if (c.messageUid) {
      const criteriIgnorati = (
        [
          ['olderThanDays', c.olderThanDays],
          ['newerThanDays', c.newerThanDays],
          ['filterFrom', c.filterFrom],
          ['filterSubject', c.filterSubject],
          ['hasAttachment', c.hasAttachment === true ? true : undefined],
          ['readState', c.readState !== 'any' ? c.readState : undefined],
        ] as const
      )
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k]) => k);

      if (criteriIgnorati.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Hai indicato un messaggio preciso (messageUid): i criteri di ricerca ` +
            `(${criteriIgnorati.join(', ')}) non verrebbero applicati. Togli l'uid per filtrare ` +
            `una cartella, oppure togli i criteri per agire su quel messaggio.`,
          path: ['messageUid'],
        });
      }
    }

    // Una finestra vuota (più vecchi di 10 giorni E più recenti di 3) non
    // seleziona niente. Meglio un rifiuto che un workflow che non fa mai nulla
    // e sembra funzionare.
    const vecchi = c.olderThanDays;
    const recenti = c.newerThanDays;
    if (vecchi !== undefined && recenti !== undefined && recenti <= vecchi) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          '«Più recenti di» deve essere maggiore di «più vecchi di», altrimenti non resta nessun messaggio.',
        path: ['newerThanDays'],
      });
    }
  });

export type EmailMoveConfig = z.infer<typeof EmailMoveConfigSchema>;
