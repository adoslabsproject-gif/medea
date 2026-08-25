/**
 * `action_email_move` — NodeDef metadata.
 *
 * PERCHÉ ESISTE (2026-08-05): prima di questo nodo il catalogo non aveva NESSUN modo di
 * spostare un messaggio fra cartelle. Chi chiedeva di archiviare la posta otteneva
 * workflow che scrivevano file di testo con dentro date inventate: il pezzo giusto non
 * era disponibile e il modello copriva il buco con della finzione.
 *
 * La nota sta QUI e non nella `description`: quel campo finisce nell'interfaccia utente e
 * nel catalogo dei nodi (~920 KB, già un budget critico per il contesto del modello). Chi
 * legge la scheda del nodo deve capire cosa fa, non la cronaca di come è nato.
 *
 * @module actions/email_move/definition
 */

import type { NodeDef } from '@medea/engine-core-schema';

export const emailMoveNodeDef: NodeDef = {
  id: 'action_email_move',
  type: 'action',
  label: 'Email: sposta, archivia, segna',
  icon: 'archive',
  color: '#3b82f6',
  description:
    'Sposta, copia, o segna come letti/da leggere i messaggi di una cartella IMAP, scegliendoli per età, ' +
    'mittente, oggetto, stato di lettura e presenza di allegati — oppure agendo sul singolo messaggio che un ' +
    'trigger email ha appena fatto arrivare, indicandone l’uid. È il nodo con cui si archivia: «le newsletter più vecchie di 30 giorni ' +
    'nella cartella Archivio», «le fatture del fornitore X in Contabilità», «tutto il letto di più di un anno ' +
    'in Storico». Restituisce in `affected` quanti messaggi ha toccato e in `messages` quali, così il conteggio ' +
    'è disponibile ai nodi successivi senza doverlo ricavare altrove. ' +
    'Operazione DISTRUTTIVA sulla casella (move rimuove dalla cartella di origine): `dryRun` conta senza toccare ' +
    'niente ed è il modo giusto di provare un criterio prima di applicarlo. ' +
    'Idempotenza: un messaggio già spostato non viene più trovato dal criterio sulla cartella di origine, quindi ' +
    'una seconda esecuzione non lo tocca — un cron che gira ogni notte non accumula danni. ' +
    'Use case: archiviazione periodica per tenere la posta in arrivo leggibile, smistamento per mittente dopo un ' +
    'triage AI, svuotamento programmato di cartelle di servizio, preparazione di un archivio prima di una ' +
    'indicizzazione RAG.',

  configFields: [
    {
      key: 'systemAccountId',
      label: 'Account email di sistema',
      type: 'email-account-picker',
      required: false,
      help:
        'Scegli un account configurato in Impostazioni → Account email. Se lasciato vuoto puoi indicare ' +
        'host/porta/utente/password qui sotto, ma è sconsigliato: gli account di sistema gestiscono il ' +
        'rinnovo OAuth e tengono la password cifrata a riposo.',
    },
    {
      key: 'host',
      label: 'Host IMAP',
      type: 'text',
      required: false,
      help: 'Solo se non usi un account di sistema. Esempio: `imap.gmail.com`.',
    },
    {
      key: 'port',
      label: 'Porta',
      type: 'number',
      required: false,
      defaultValue: '993',
      help: 'La 993 è IMAP su TLS implicito, ed è quella giusta quasi sempre.',
    },
    {
      key: 'username',
      label: 'Utente',
      type: 'text',
      required: false,
    },
    {
      key: 'password',
      label: 'Password',
      type: 'secret',
      required: false,
      help: 'Su Gmail serve una password per app, non quella dell’account.',
    },
    {
      key: 'sourceMailbox',
      label: 'Cartella di origine',
      type: 'text',
      required: true,
      defaultValue: 'INBOX',
      help: 'Dove cercare i messaggi. `INBOX` è la posta in arrivo.',
    },
    {
      key: 'targetMailbox',
      label: 'Cartella di destinazione',
      type: 'text',
      required: false,
      help:
        'Dove spostarli. Obbligatoria per «sposta» e «copia», ignorata per le operazioni che segnano ' +
        'soltanto. Il nome è quello che vede il server: su Gmail le cartelle annidate si scrivono ' +
        '`Genitore/Figlia`. Se non esiste viene creata, salvo che tu lo vieti qui sotto.',
    },
    {
      key: 'operation',
      label: 'Operazione',
      type: 'select',
      required: false,
      defaultValue: 'move',
      options: ['move', 'copy', 'mark_seen', 'mark_unseen'],
      help:
        'Sposta è quello che serve per archiviare; copia lascia il messaggio anche dov’era. ' +
        '«mark_seen» lo segna come letto e «mark_unseen» come da leggere, senza toccarne la posizione.',
    },
    {
      key: 'messageUid',
      label: 'Messaggio da elaborare',
      type: 'text',
      required: false,
      help:
        'L’uid del messaggio su cui agire, di solito preso dal nodo che l’ha fatto arrivare: ' +
        '`{{$node.<id_del_trigger>.json.uid}}`. Se lo valorizzi, i criteri di ricerca qui sotto ' +
        'vengono ignorati e si agisce SOLO su quel messaggio. ' +
        'È il modo giusto di collegare questo nodo a un trigger email: senza, il nodo cerca per ' +
        'conto suo e può toccare messaggi che non c’entrano niente con quello appena arrivato.',
    },
    {
      key: 'olderThanDays',
      label: 'Più vecchi di (giorni)',
      type: 'number',
      required: false,
      help:
        'Prende solo i messaggi ricevuti da più di questo numero di giorni. Vuoto o 0 = nessun limite di età. ' +
        'È il criterio con cui si dice «archivia quello vecchio».',
    },
    {
      key: 'newerThanDays',
      label: 'Più recenti di (giorni)',
      type: 'number',
      required: false,
      help: 'Il criterio opposto, per smistare solo quello appena arrivato. Si può usare insieme al precedente.',
    },
    {
      key: 'filterFrom',
      label: 'Mittente contiene',
      type: 'text',
      required: false,
      help: 'Confronto sul mittente, senza distinzione fra maiuscole e minuscole. Esempio: `newsletter@`.',
    },
    {
      key: 'filterSubject',
      label: 'Oggetto contiene',
      type: 'text',
      required: false,
      help: 'Confronto sull’oggetto, senza distinzione fra maiuscole e minuscole.',
    },
    {
      key: 'readState',
      label: 'Stato di lettura',
      type: 'select',
      required: false,
      defaultValue: 'any',
      options: ['any', 'seen', 'unseen'],
      help: 'Archiviare solo il già letto è la scelta prudente: non fa sparire niente di non visto.',
    },
    {
      key: 'hasAttachment',
      label: 'Solo con allegati',
      type: 'boolean',
      required: false,
      defaultValue: 'false',
    },
    {
      key: 'maxMessages',
      label: 'Massimo messaggi per esecuzione',
      type: 'number',
      required: false,
      defaultValue: '200',
      help:
        'Un tetto di sicurezza: se il criterio è più largo del previsto, si ferma qui invece di svuotare una ' +
        'casella. La prossima esecuzione riprende da dove ha lasciato.',
    },
    {
      key: 'createTarget',
      label: 'Crea la cartella se non esiste',
      type: 'boolean',
      required: false,
      defaultValue: 'true',
      help: 'Spento, una destinazione inesistente fa fallire il nodo invece di crearla.',
    },
    {
      key: 'dryRun',
      label: 'Prova senza spostare',
      type: 'boolean',
      required: false,
      defaultValue: 'false',
      help:
        'Conta e ti dice quali messaggi corrisponderebbero, senza toccarli. È il modo di provare un criterio ' +
        'prima di applicarlo a una casella vera.',
    },
    {
      key: 'timeoutMs',
      label: 'Tempo massimo (ms)',
      type: 'number',
      required: false,
      defaultValue: '60000',
    },
  ],

  /**
   * ⚠️ Per un nodo NON-branching `outputs` sono i CAMPI del risultato, non le porte:
   * `scripts/extract-flowforge-nodes.mjs` li riversa in `outputFields` del catalogo
   * (le porte finiscono in `outputPorts`, e solo se `branching` è vero).
   *
   * Dichiarare `['default']` — com'era fino al 2026-08-05 — faceva risultare a catalogo
   * un nodo che produce un unico campo chiamato «default»: chi costruiva un workflow,
   * persona o modello, non poteva sapere di poter leggere `{{$node.<id>.json.affected}}`.
   * Lo stesso meccanismo per cui questo nodo è nato: ciò che non è dichiarato viene
   * rimpiazzato dall'invenzione.
   *
   * L'elenco DEVE restare allineato all'`output` di apps/engine/src/executors/email-move.ts.
   */
  outputs: [
    'affected',
    'found',
    'wouldAffect',
    'messages',
    'sourceMailbox',
    'targetMailbox',
    'operation',
    'dryRun',
    'truncated',
  ],
  outputContract: {
    notes: 'In prova (`dryRun`) NON tocca niente: `affected` resta 0 e il numero da guardare e` `wouldAffect`. `truncated` a vero significa che il tetto di messaggi ha fermato l\'operazione a meta`: ne restano altri da spostare.',
    fields: [
      { name: 'affected', type: 'number', desc: 'Quanti messaggi ha davvero spostato o segnato. Zero in prova.' },
      { name: 'found', type: 'number', desc: 'Quanti messaggi corrispondevano ai criteri.' },
      { name: 'wouldAffect', type: 'number', desc: 'Quanti ne avrebbe toccati: e` il numero utile in prova.' },
      { name: 'messages', type: 'array', desc: 'I messaggi interessati, con UID, oggetto e mittente.' },
      { name: 'sourceMailbox', type: 'string', desc: 'La cartella di partenza.' },
      { name: 'targetMailbox', type: 'string', desc: 'La cartella di arrivo. Vuota per le sole operazioni di lettura.' },
      { name: 'operation', type: 'string', desc: 'Cosa ha fatto: move, copy, mark_seen o mark_unseen.' },
      { name: 'dryRun', type: 'boolean', desc: 'Vero se era una prova e non ha modificato niente.' },
      { name: 'truncated', type: 'boolean', desc: 'Vero se il tetto di messaggi ha interrotto l\'operazione: ne restano fuori.' },
    ],
  },
  vendor: 'flowforge',
  version: '1.0.0',
};
