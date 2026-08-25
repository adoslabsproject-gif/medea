/**
 * `action_email_move` — definizione e regole di configurazione.
 *
 * L'executor vive in `apps/engine` e parla IMAP; qui si prova ciò che decide
 * se una configurazione è sensata **prima** che qualcuno tocchi una casella
 * vera. Su un nodo che sposta posta, un criterio sbagliato non dà un errore:
 * sposta le cose sbagliate, e nessuno se ne accorge fino a che non le cerca.
 */

import { describe, expect, it } from 'vitest';

import { emailMoveNode, emailMoveNodeDef, EmailMoveConfigSchema } from './index.js';

/** Una configurazione valida minima, da cui i test partono. */
const BASE = {
  systemAccountId: 'acc-1',
  sourceMailbox: 'INBOX',
  targetMailbox: 'Archivio',
};

describe('emailMoveNodeDef — contratto col catalogo', () => {
  it('è un nodo azione con l’id atteso', () => {
    expect(emailMoveNodeDef.id).toBe('action_email_move');
    expect(emailMoveNodeDef.type).toBe('action');
  });

  /**
   * L'executor sta in `apps/engine` perché ha bisogno di `imapflow`. Se
   * qualcuno ne aggiungesse uno qui, il pacchetto stdlib si porterebbe dietro
   * una dipendenza pesante e smetterebbe di compilarsi dove oggi compila.
   */
  it('non porta un executor: quello vero è lato server', () => {
    expect(emailMoveNode.executor).toBeUndefined();
  });

  /**
   * La destinazione è obbligatoria solo per chi sposta.
   *
   * Marcarla obbligatoria nella definizione costringerebbe chi vuole soltanto
   * segnare un messaggio come letto a inventarsi una cartella che poi verrebbe
   * ignorata — e un campo che si compila per far tacere un controllo è un campo
   * che qualcuno riempirà a caso. Il vincolo vero sta nello schema, dove può
   * dipendere dall'operazione.
   */
  it('dichiara obbligatoria l’origine, e la destinazione la lega all’operazione', () => {
    const obbligatori = (emailMoveNodeDef.configFields ?? [])
      .filter((f) => f.required)
      .map((f) => f.key);
    expect(obbligatori).toContain('sourceMailbox');
    expect(obbligatori).not.toContain('targetMailbox');

    expect(EmailMoveConfigSchema.safeParse({ ...BASE, targetMailbox: undefined }).success).toBe(
      false,
    );
    expect(
      EmailMoveConfigSchema.safeParse({
        systemAccountId: 'acc-1',
        sourceMailbox: 'INBOX',
        operation: 'mark_seen',
      }).success,
    ).toBe(true);
  });

  /**
   * Il campo che lega il nodo al messaggio del trigger.
   *
   * Senza, dietro a un trigger email il nodo cerca per conto suo e può toccare
   * fino a `maxMessages` messaggi che non c'entrano niente con quello appena
   * arrivato. È il difetto che il wizard ha prodotto il 2026-08-05: «segna come
   * letta l'email ricevuta» era diventato «sposta duecento messaggi qualsiasi».
   */
  it('offre il campo per agire sul messaggio del trigger', () => {
    const uid = (emailMoveNodeDef.configFields ?? []).find((f) => f.key === 'messageUid');
    expect(uid).toBeDefined();
    expect(uid?.help).toContain('$node');
  });

  it('conosce anche le operazioni che segnano soltanto', () => {
    const op = (emailMoveNodeDef.configFields ?? []).find((f) => f.key === 'operation');
    expect(op?.options).toEqual(['move', 'copy', 'mark_seen', 'mark_unseen']);
  });

  /** La prova a vuoto è l'unica difesa prima di un'operazione distruttiva. */
  it('offre la prova senza spostare, spenta per difetto', () => {
    const dryRun = (emailMoveNodeDef.configFields ?? []).find((f) => f.key === 'dryRun');
    expect(dryRun?.type).toBe('boolean');
    expect(dryRun?.defaultValue).toBe('false');
  });
});

describe('EmailMoveConfigSchema — quello che si rifiuta di fare', () => {
  it('accetta una configurazione minima con account di sistema', () => {
    const r = EmailMoveConfigSchema.safeParse(BASE);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.operation).toBe('move');
      expect(r.data.maxMessages).toBe(200);
      expect(r.data.dryRun).toBe(false);
    }
  });

  it('senza account di sistema pretende host, utente e password', () => {
    const r = EmailMoveConfigSchema.safeParse({
      sourceMailbox: 'INBOX',
      targetMailbox: 'Archivio',
    });
    expect(r.success).toBe(false);
  });

  it('con host, utente e password sta in piedi anche senza account', () => {
    const r = EmailMoveConfigSchema.safeParse({
      sourceMailbox: 'INBOX',
      targetMailbox: 'Archivio',
      host: 'imap.example.com',
      username: 'io@example.com',
      password: 'segreta',
    });
    expect(r.success).toBe(true);
  });

  /**
   * Spostare una cartella dentro sé stessa il server lo esegue volentieri, e
   * non fa quello che si voleva: va fermato qui, dove si può ancora dirlo.
   */
  it('rifiuta origine e destinazione uguali', () => {
    const r = EmailMoveConfigSchema.safeParse({ ...BASE, targetMailbox: 'INBOX' });
    expect(r.success).toBe(false);
  });

  /**
   * «Più vecchi di 10 giorni» e «più recenti di 3» insieme non selezionano
   * niente: il workflow girerebbe per sempre senza spostare nulla, con l'aria
   * di funzionare. Un errore visibile vale più di un silenzio.
   */
  it('rifiuta una finestra temporale vuota', () => {
    const r = EmailMoveConfigSchema.safeParse({
      ...BASE,
      olderThanDays: 10,
      newerThanDays: 3,
    });
    expect(r.success).toBe(false);
  });

  it('accetta una finestra temporale sensata', () => {
    const r = EmailMoveConfigSchema.safeParse({
      ...BASE,
      olderThanDays: 30,
      newerThanDays: 365,
    });
    expect(r.success).toBe(true);
  });

  /** I moduli mandano stringhe: `"false"` deve valere falso, non «stringa
   *  non vuota quindi vero», che è ciò che farebbe `Boolean()`. */
  it('legge le spunte come le manda il modulo', () => {
    const r = EmailMoveConfigSchema.safeParse({
      ...BASE,
      dryRun: 'true',
      createTarget: 'false',
      hasAttachment: '0',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.dryRun).toBe(true);
      expect(r.data.createTarget).toBe(false);
      expect(r.data.hasAttachment).toBe(false);
    }
  });

  it('legge i numeri come li manda il modulo', () => {
    const r = EmailMoveConfigSchema.safeParse({ ...BASE, olderThanDays: '30', maxMessages: '50' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.olderThanDays).toBe(30);
      expect(r.data.maxMessages).toBe(50);
    }
  });

  /** Il tetto esiste per non svuotare una casella per errore: non si toglie. */
  it('non lascia alzare il tetto oltre il limite', () => {
    expect(EmailMoveConfigSchema.safeParse({ ...BASE, maxMessages: 99999 }).success).toBe(false);
  });

  it('conosce solo le quattro operazioni previste', () => {
    expect(EmailMoveConfigSchema.safeParse({ ...BASE, operation: 'delete' }).success).toBe(false);
    for (const op of ['move', 'copy', 'mark_seen', 'mark_unseen']) {
      expect(EmailMoveConfigSchema.safeParse({ ...BASE, operation: op }).success).toBe(true);
    }
  });

  /** Origine e destinazione uguali contano solo per chi sposta davvero. */
  it('non si lamenta della destinazione quando l’operazione non la usa', () => {
    const r = EmailMoveConfigSchema.safeParse({
      ...BASE,
      targetMailbox: 'INBOX',
      operation: 'mark_seen',
    });
    expect(r.success).toBe(true);
  });

  it('accetta l’uid del messaggio come espressione', () => {
    const r = EmailMoveConfigSchema.safeParse({
      ...BASE,
      messageUid: '{{$node.trigger_email.json.uid}}',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.messageUid).toBe('{{$node.trigger_email.json.uid}}');
  });
});
