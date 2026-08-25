/**
 * Scrivere nel database — ma solo dopo che qualcuno ha detto di sì.
 *
 * Gli strumenti di lettura (`tools-db.ts`) hanno tolto al modello il bisogno
 * di indovinare. Questi gli permettono di **fare**: creare una tabella,
 * scriverci dentro. È la differenza fra un assistente che descrive e uno che
 * lavora.
 *
 * ── La conferma non è un dettaglio ──
 *
 * Il progetto lo dice a chiare lettere: «ogni mutation richiede conferma
 * esplicita dell'utente». Vale a maggior ragione qui, dove chi decide è un
 * modello dentro una conversazione: fra il capire male una frase e il
 * cancellare dei dati non ci deve essere niente di automatico.
 *
 * Quindi ogni strumento di questo modulo:
 *
 *  1. **Non parte** se non gli è stato dato un modo per chiedere. Senza la
 *     funzione di conferma restituisce un rifiuto — non un'esecuzione
 *     silenziosa. Un domani qualcuno potrebbe collegarli in un contesto senza
 *     interfaccia, e il valore predefinito deve essere «non fare».
 *  2. **Dice cosa sta per fare** con parole che si possono valutare: il nome
 *     della tabella, le colonne, quante righe. Non «vuoi procedere?».
 *  3. **Riferisce il rifiuto al modello**, così l'assistente lo racconta
 *     invece di riprovare in loop.
 *
 * @module features/workflows/scaffold/tools-db-scrittura
 */

import { runtimeApi } from '../runtime/client';

import type { ToolCallResult, ToolDef } from './tools';

/** Quante righe al massimo si scrivono in una volta. */
const TETTO_RIGHE = 200;

/** I tipi di colonna che DB Studio accetta. */
const TIPI = ['text', 'integer', 'real', 'boolean', 'datetime', 'json'] as const;

/**
 * Come si chiede il permesso.
 *
 * Torna `true` solo se una persona ha detto di sì. Assente = non si scrive.
 */
export type ChiediConferma = (richiesta: {
  titolo: string;
  dettaglio: string;
}) => Promise<boolean>;

/** I nomi degli strumenti che scrivono: servono a chi smista le chiamate. */
export const STRUMENTI_DB_SCRITTURA = new Set(['crea_tabella', 'scrivi_righe']);

export const DB_WRITE_TOOLS: ToolDef[] = [
  {
    name: 'crea_tabella',
    description:
      'Crea una tabella nuova. MODIFICA l’archivio, quindi viene chiesta conferma all’utente ' +
      'prima di procedere: se dice di no, la tabella non nasce e devi dirglielo. ' +
      'Chiama prima `elenca_tabelle`: se esiste già, usala invece di crearne una seconda.',
    parameters: {
      type: 'object',
      properties: {
        databaseId: {
          type: 'string',
          description: 'L’archivio, come lo dà `elenca_tabelle`.',
        },
        name: {
          type: 'string',
          description: 'Nome della tabella: minuscolo, lettere numeri e trattini bassi.',
        },
        columns: {
          type: 'array',
          description: 'Le colonne. Mettine sempre una chiamata `id`, che fa da chiave.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: [...TIPI] },
            },
            required: ['name', 'type'],
            additionalProperties: false,
          },
        },
      },
      required: ['databaseId', 'name', 'columns'],
      additionalProperties: false,
    },
  },
  {
    name: 'scrivi_righe',
    description:
      `Inserisce righe in una tabella esistente (al massimo ${String(TETTO_RIGHE)} per volta). ` +
      'MODIFICA i dati, quindi viene chiesta conferma all’utente prima di procedere. ' +
      'Chiama prima `descrivi_tabella`: i nomi delle colonne si leggono, non si indovinano.',
    parameters: {
      type: 'object',
      properties: {
        databaseId: { type: 'string', description: 'L’archivio, come lo dà `elenca_tabelle`.' },
        table: { type: 'string', description: 'La tabella in cui scrivere.' },
        rows: {
          type: 'array',
          description: 'Le righe, come oggetti con le colonne della tabella.',
          items: { type: 'object', additionalProperties: true },
        },
      },
      required: ['databaseId', 'table', 'rows'],
      additionalProperties: false,
    },
  },
];

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Il rifiuto che si restituisce quando non c'è modo di chiedere. */
const SENZA_CONFERMA: ToolCallResult = {
  data: {
    error:
      'Non posso scrivere: qui non c’è modo di chiedere il permesso all’utente, e senza permesso ' +
      'non si modifica niente. Dì all’utente cosa faresti e lascia che lo faccia lui.',
  },
};

async function creaTabella(
  args: Record<string, unknown>,
  chiedi: ChiediConferma,
): Promise<ToolCallResult> {
  const databaseId = str(args.databaseId);
  const nome = str(args.name).toLowerCase();
  if (!databaseId || !nome) {
    return { data: { error: 'Servono `databaseId` e `name`. Prendi l’archivio da `elenca_tabelle`.' } };
  }
  if (!/^[a-z][a-z0-9_]*$/.test(nome)) {
    return {
      data: {
        error: `«${nome}» non è un nome valido: minuscolo, deve iniziare con una lettera, e poi lettere, numeri o trattini bassi.`,
      },
    };
  }

  const grezze = Array.isArray(args.columns) ? args.columns : [];
  const colonne = grezze
    .map((c) => {
      if (c === null || typeof c !== 'object') return null;
      const col = c as { name?: unknown; type?: unknown };
      const n = str(col.name).toLowerCase();
      if (!/^[a-z][a-z0-9_]*$/.test(n)) return null;
      const t = str(col.type);
      return { name: n, type: (TIPI as readonly string[]).includes(t) ? t : 'text' };
    })
    .filter((c): c is { name: string; type: string } => c !== null);

  if (colonne.length === 0) {
    return { data: { error: 'Serve almeno una colonna con un nome valido.' } };
  }

  const elenco = colonne.map((c) => `${c.name} (${c.type})`).join(', ');
  const ok = await chiedi({
    titolo: `Creare la tabella «${nome}»?`,
    dettaglio: `Verrà creata con queste colonne: ${elenco}. Modifica il tuo archivio.`,
  });
  if (!ok) {
    return {
      data: {
        rifiutato: true,
        error: `L’utente non ha voluto creare «${nome}». Non insistere: raccontaglielo e chiedi come preferisce procedere.`,
      },
    };
  }

  try {
    await runtimeApi.post(`/db/databases/${databaseId}/migrations/apply`, {
      actions: [
        {
          kind: 'create_table',
          table: {
            id: `assistente_${nome}`,
            name: nome,
            description: 'Creata dall’assistente di Medea, su conferma dell’utente.',
            columns: colonne.map((c) => ({
              id: `${nome}_${c.name}`,
              name: c.name,
              type: c.type,
              constraints:
                c.name === 'id'
                  ? { primaryKey: true, nullable: false, unique: true }
                  : { nullable: true },
            })),
            indexes: [],
          },
        },
      ],
    });
    return { data: { creata: nome, colonne: colonne.map((c) => c.name) } };
  } catch (e) {
    return {
      data: { error: `Non sono riuscito a creare «${nome}»: ${e instanceof Error ? e.message : String(e)}` },
    };
  }
}

async function scriviRighe(
  args: Record<string, unknown>,
  chiedi: ChiediConferma,
): Promise<ToolCallResult> {
  const databaseId = str(args.databaseId);
  const table = str(args.table);
  if (!databaseId || !table) {
    return { data: { error: 'Servono `databaseId` e `table`. Prendili da `elenca_tabelle`.' } };
  }

  const righe = (Array.isArray(args.rows) ? args.rows : []).filter(
    (r): r is Record<string, unknown> => r !== null && typeof r === 'object' && !Array.isArray(r),
  );
  if (righe.length === 0) return { data: { error: 'Non c’è nessuna riga da scrivere.' } };
  if (righe.length > TETTO_RIGHE) {
    return {
      data: {
        error: `Sono ${String(righe.length)} righe: il massimo è ${String(TETTO_RIGHE)} per volta. Falle a scaglioni.`,
      },
    };
  }

  // Le colonne toccate si dicono nella domanda: «scrivo 3 righe» non permette
  // di valutare niente, «3 righe con nome ed email» sì.
  const colonne = [...new Set(righe.flatMap((r) => Object.keys(r)))];
  const ok = await chiedi({
    titolo:
      righe.length === 1
        ? `Scrivere una riga in «${table}»?`
        : `Scrivere ${String(righe.length)} righe in «${table}»?`,
    dettaglio: `Colonne interessate: ${colonne.join(', ')}. Modifica i tuoi dati.`,
  });
  if (!ok) {
    return {
      data: {
        rifiutato: true,
        error: `L’utente non ha voluto scrivere in «${table}». Non insistere: raccontaglielo.`,
      },
    };
  }

  // Una riga che fallisce non ferma le altre: meglio otto scritte su dieci e
  // due errori precisi, che un errore unico che non dice quali.
  const scritte: number[] = [];
  const problemi: string[] = [];
  for (const [i, row] of righe.entries()) {
    try {
      await runtimeApi.post(`/db/databases/${databaseId}/insert`, { table, row });
      scritte.push(i + 1);
    } catch (e) {
      problemi.push(`riga ${String(i + 1)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    data: {
      scritte: scritte.length,
      ...(problemi.length > 0 ? { problemi } : {}),
    },
  };
}

/** Esegue uno degli strumenti che modificano. Senza conferma non fa niente. */
export async function eseguiStrumentoDbScrittura(
  name: string,
  args: Record<string, unknown>,
  chiedi?: ChiediConferma,
): Promise<ToolCallResult> {
  if (!chiedi) return SENZA_CONFERMA;
  switch (name) {
    case 'crea_tabella':
      return creaTabella(args, chiedi);
    case 'scrivi_righe':
      return scriviRighe(args, chiedi);
    default:
      return { data: { error: `Strumento sconosciuto: ${name}` } };
  }
}
