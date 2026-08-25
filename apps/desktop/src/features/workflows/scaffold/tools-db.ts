/**
 * Guardare nel database, invece di indovinare cosa c'è dentro.
 *
 * Il 2026-08-07, alla richiesta «leggi gli articoli della tabella magazzino»,
 * il modello ha risposto:
 *
 *     [TOOL_CALLS]read_table{"table_path": "/Users/tu/Documenti/magazzino.csv"}
 *
 * Non stava impazzendo. Fra i dieci strumenti che gli davamo — tutti per
 * costruire workflow: `add_node`, `connect`, `set_config` — non ce n'era
 * **nessuno** per guardare i dati. Ha cercato quello che gli serviva, non l'ha
 * trovato, e se l'è inventato: prima `fs_read`, poi `read_table`, sempre
 * puntati a un file sul disco dell'utente che non esiste.
 *
 * `magazzino` infatti non c'è: le tabelle sono `inbox` e `ordini`. Se avesse
 * potuto GUARDARE, avrebbe risposto «magazzino non esiste, hai inbox e ordini
 * — vuoi che la crei?». Chiedeva una cosa ragionevole a cui nessuno poteva
 * rispondere.
 *
 * ── Solo lettura, per adesso ──
 *
 * Questi tre strumenti guardano e basta. Scrivere è un'altra cosa e viene
 * dopo, con la conferma esplicita: il progetto lo dice a chiare lettere —
 * «ogni mutation richiede conferma esplicita dell'utente» — e vale a maggior
 * ragione per un modello che modifica dati da una conversazione.
 *
 * @module features/workflows/scaffold/tools-db
 */

import { runtimeApi } from '../runtime/client';

import type { ToolCallResult, ToolDef } from './tools';

/** Quante righe al massimo può leggere in un colpo. */
const TETTO_RIGHE = 50;

/** Quanti caratteri di un valore si mostrano prima di troncare. */
const TETTO_VALORE = 300;

interface ArchivioGrezzo {
  id: string;
  name: string;
  tables?: { name: string; columns?: { name: string; type?: string }[] }[];
}

/** I nomi degli strumenti definiti qui: serve a chi smista le chiamate. */
export const STRUMENTI_DB = new Set(['elenca_tabelle', 'descrivi_tabella', 'leggi_righe']);

export const DB_READ_TOOLS: ToolDef[] = [
  {
    name: 'elenca_tabelle',
    description:
      'Quali archivi esistono e quali tabelle contengono. CHIAMALO PRIMA di dare per esistente ' +
      'una tabella che l’utente ha nominato: se non c’è, dirglielo — e proporre di crearla — ' +
      'vale più che inventarsi da dove leggere. Non modifica niente.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'descrivi_tabella',
    description:
      'Le colonne di una tabella, coi loro tipi. Serve prima di scrivere un filtro o una riga: ' +
      'i nomi delle colonne si leggono, non si indovinano. Non modifica niente.',
    parameters: {
      type: 'object',
      properties: {
        databaseId: { type: 'string', description: 'L’archivio, come lo dà `elenca_tabelle`.' },
        table: { type: 'string', description: 'Il nome esatto della tabella.' },
      },
      required: ['databaseId', 'table'],
      additionalProperties: false,
    },
  },
  {
    name: 'leggi_righe',
    description:
      `Le prime righe di una tabella (al massimo ${String(TETTO_RIGHE)}), per vedere che forma ` +
      'hanno i dati veri. Serve a capire com’è fatto un valore prima di filtrarci sopra. ' +
      'Non modifica niente.',
    parameters: {
      type: 'object',
      properties: {
        databaseId: { type: 'string', description: 'L’archivio, come lo dà `elenca_tabelle`.' },
        table: { type: 'string', description: 'Il nome esatto della tabella.' },
        limit: {
          type: 'number',
          description: `Quante righe leggere. Massimo ${String(TETTO_RIGHE)}.`,
        },
      },
      required: ['databaseId', 'table'],
      additionalProperties: false,
    },
  },
];

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Un valore lungo si tronca: il modello non deve annegare in un campo solo. */
function corto(valore: unknown): unknown {
  if (typeof valore !== 'string' || valore.length <= TETTO_VALORE) return valore;
  return `${valore.slice(0, TETTO_VALORE)}… (troncato)`;
}

async function elencaTabelle(): Promise<ToolCallResult> {
  const risposta = await runtimeApi
    .get<{ databases: ArchivioGrezzo[] }>('/db/databases')
    .catch(() => null);
  if (!risposta) {
    return {
      data: { error: 'Non riesco a parlare con l’archivio: il motore non risponde.' },
    };
  }

  const archivi = await Promise.all(
    risposta.databases.map(async (d) => {
      const dettaglio = await runtimeApi
        .get<{ database: ArchivioGrezzo }>(`/db/databases/${d.id}`)
        .catch(() => null);
      return {
        databaseId: d.id,
        nome: d.name,
        tabelle: (dettaglio?.database.tables ?? []).map((t) => t.name),
      };
    }),
  );

  const quante = archivi.reduce((n, a) => n + a.tabelle.length, 0);
  return {
    data: {
      archivi,
      // Detto esplicitamente, perché è la conclusione che conta: se la tabella
      // che l'utente ha nominato non è in questo elenco, NON esiste.
      nota:
        quante === 0
          ? 'Non c’è ancora nessuna tabella. Se ne serve una, proponi di crearla.'
          : 'Se la tabella che ti hanno nominato non è in questo elenco, non esiste: dillo e proponi di crearla, invece di leggerla da un’altra parte.',
    },
  };
}

async function descriviTabella(args: Record<string, unknown>): Promise<ToolCallResult> {
  const databaseId = str(args.databaseId);
  const table = str(args.table);
  if (!databaseId || !table) {
    return { data: { error: 'Servono `databaseId` e `table`. Prendili da `elenca_tabelle`.' } };
  }

  const dettaglio = await runtimeApi
    .get<{ database: ArchivioGrezzo }>(`/db/databases/${databaseId}`)
    .catch(() => null);
  if (!dettaglio) return { data: { error: `L’archivio «${databaseId}» non risponde.` } };

  const trovata = (dettaglio.database.tables ?? []).find(
    (t) => t.name.toLowerCase() === table.toLowerCase(),
  );
  if (!trovata) {
    const disponibili = (dettaglio.database.tables ?? []).map((t) => t.name);
    return {
      data: {
        error: `La tabella «${table}» non esiste.`,
        tabelleDisponibili: disponibili,
        nota: 'Non leggerla da un’altra parte: dillo a chi te l’ha chiesta e proponi di crearla.',
      },
    };
  }

  return {
    data: {
      databaseId,
      tabella: trovata.name,
      colonne: (trovata.columns ?? []).map((c) => ({ nome: c.name, tipo: c.type ?? 'text' })),
    },
  };
}

async function leggiRighe(args: Record<string, unknown>): Promise<ToolCallResult> {
  const databaseId = str(args.databaseId);
  const table = str(args.table);
  if (!databaseId || !table) {
    return { data: { error: 'Servono `databaseId` e `table`. Prendili da `elenca_tabelle`.' } };
  }
  const chieste = typeof args.limit === 'number' ? args.limit : TETTO_RIGHE;
  const limit = Math.max(1, Math.min(Math.floor(chieste), TETTO_RIGHE));

  const risposta = await runtimeApi
    .post<{ rows?: Record<string, unknown>[]; rowCount?: number }>(
      `/db/databases/${databaseId}/query`,
      { table, filters: [], orderBy: [], limit },
    )
    .catch((e: unknown) => ({ errore: e instanceof Error ? e.message : String(e) }) as never);

  if ('errore' in risposta) {
    return { data: { error: `Non ho potuto leggere «${table}»: ${String(risposta.errore)}` } };
  }

  const righe = (risposta.rows ?? []).map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, corto(v)])),
  );
  return {
    data: {
      tabella: table,
      righe,
      quante: righe.length,
      ...(righe.length === limit ? { nota: `Fermato a ${String(limit)} righe.` } : {}),
    },
  };
}

/** Esegue uno degli strumenti di lettura. Nessuno di questi modifica niente. */
export async function eseguiStrumentoDb(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  switch (name) {
    case 'elenca_tabelle':
      return elencaTabelle();
    case 'descrivi_tabella':
      return descriviTabella(args);
    case 'leggi_righe':
      return leggiRighe(args);
    default:
      return { data: { error: `Strumento sconosciuto: ${name}` } };
  }
}
