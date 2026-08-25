/**
 * `action_contact_lookup` — cerca un indirizzo nella rubrica di Medea.
 *
 * La rubrica non sta nel database del motore: sta in quello di Medea, popolata
 * dal sync della posta e dalla scheda Persone. Il motore gira come processo
 * figlio dell'app, sulla stessa macchina e con lo stesso utente, e riceve il
 * percorso di quel file all'avvio — così può leggerlo senza che i contatti
 * vengano duplicati altrove e comincino a divergere.
 *
 * **Sola lettura, e non per modo di dire**: la connessione è aperta in
 * `readonly`, quindi nemmeno un errore di programmazione qui dentro può
 * scrivere sulla rubrica di qualcuno.
 *
 * @module executors/contact-lookup
 */

import Database from 'better-sqlite3';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { ContactLookupConfigSchema } from '@medea/engine-nodes-stdlib';

/** Il percorso del database di Medea, passato dall'app all'avvio. */
const DB_ENV = 'MEDEA_APP_DB_PATH';

/** Un contatto come lo legge chi sta a valle. */
interface Contatto {
  email: string;
  name: string | null;
  isClient: boolean;
  isSupplier: boolean;
  organization: string | null;
  messageCount: number;
  lastSeenAt: string | null;
}

/** La riga come esce da SQLite, prima di essere ripulita. */
interface Riga {
  email_address: string;
  display_name: string | null;
  is_client: number;
  is_supplier: number;
  organization: string | null;
  message_count: number;
  last_seen_at: string | null;
}

function daRiga(r: Riga): Contatto {
  return {
    email: r.email_address,
    name: r.display_name,
    isClient: r.is_client === 1,
    isSupplier: r.is_supplier === 1,
    organization: r.organization,
    messageCount: r.message_count,
    lastSeenAt: r.last_seen_at,
  };
}

/**
 * L'indirizzo dentro un mittente scritto per esteso.
 *
 * Un trigger email consegna `from` come lo ha scritto chi manda — «Mario Rossi
 * <m.rossi@acme.it>» — e cercare quella stringa intera in rubrica non trova
 * mai niente. Estrarre la parte fra parentesi angolari è la differenza fra un
 * nodo che funziona e uno che dice sempre «non lo conosco».
 */
export function indirizzoDa(valore: string): string {
  const fra = /<([^>]+)>/.exec(valore);
  return (fra?.[1] ?? valore).trim().toLowerCase();
}

// Non `async`: `better-sqlite3` è sincrono e non c'è niente da attendere. La
// firma vuole una promessa, e si restituisce quella — mettere `async` per
// comodità dichiarerebbe un'attesa che non esiste.
export const contactLookupExecutor: NodeExecutor = (config) => {
  const parsed = ContactLookupConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(
      `action_contact_lookup: configurazione non valida — ${parsed.error.issues
        .map((i: { message: string }) => i.message)
        .join('; ')}`,
    );
  }
  const c = parsed.data;
  const inizio = Date.now();

  const percorso = process.env[DB_ENV];
  if (!percorso) {
    throw new Error(
      `action_contact_lookup: non so dove sia la rubrica (${DB_ENV} non impostata). ` +
        'Questo nodo funziona dentro Medea, che passa il percorso al motore all’avvio.',
    );
  }

  // `readonly` non è una precauzione formale: è ciò che rende impossibile a un
  // workflow sporcare la rubrica, anche sbagliando.
  const db = new Database(percorso, { readonly: true, fileMustExist: true });
  let righe: Riga[] = [];
  try {
    const dove: string[] = [];
    const args: (string | number)[] = [];

    if (c.email) {
      dove.push('LOWER(c.email_address) = ?');
      args.push(indirizzoDa(c.email));
    } else if (c.query) {
      dove.push('(LOWER(c.email_address) LIKE ? OR LOWER(IFNULL(c.display_name, "")) LIKE ?)');
      const like = `%${c.query.toLowerCase()}%`;
      args.push(like, like);
    }
    if (c.onlyClients) dove.push('c.is_client = 1');
    if (c.onlySuppliers) dove.push('c.is_supplier = 1');

    const sql =
      'SELECT c.email_address, c.display_name, c.is_client, c.is_supplier, ' +
      '       o.display_name AS organization, c.message_count, c.last_seen_at ' +
      'FROM contacts c LEFT JOIN organizations o ON o.id = c.organization_id ' +
      `WHERE ${dove.join(' AND ')} ` +
      'ORDER BY c.message_count DESC, c.last_seen_at DESC LIMIT ?';
    args.push(c.email ? 1 : c.limit);

    righe = db.prepare(sql).all(...args) as Riga[];
  } finally {
    db.close();
  }

  const contatti = righe.map(daRiga);
  const trovato = contatti.length > 0;

  if (!trovato && c.requireFound) {
    throw new Error(
      `action_contact_lookup: «${c.email ?? c.query ?? ''}» non è in rubrica, ` +
        'e il nodo è configurato per fermarsi quando non lo trova.',
    );
  }

  return Promise.resolve({
    durationMs: Date.now() - inizio,
    output: {
      /** Il campo su cui si dirama: `logic_if` su questo separa i conosciuti. */
      found: trovato,
      /** Il primo risultato, che con la ricerca per indirizzo è l'unico. */
      contact: contatti[0] ?? null,
      contacts: contatti,
      count: contatti.length,
    },
  });
};
