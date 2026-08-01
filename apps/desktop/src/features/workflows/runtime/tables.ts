/**
 * Creare davvero le tabelle che il workflow dà per esistenti.
 *
 * Il piano lo fa `table-plan.ts`; qui si parla col runtime. Le tabelle nascono
 * in un database SQLite suo, dentro i dati del runtime: è un archivio di
 * lavoro delle automazioni, non il database di Medea — che resta intoccabile
 * e non si lascia ombreggiare da una tabella generata.
 */

import { runtimeApi } from './client';
import type { PlannedTable } from './table-plan';

/** Il nome con cui il database di lavoro compare nel runtime. */
const DATABASE_NAME = 'Medea — dati delle automazioni';

interface RuntimeDatabase {
  id: string;
  name: string;
  tables?: { name: string }[];
}

let cachedId: string | null = null;

/**
 * Il database di lavoro, creato la prima volta che serve.
 *
 * Non si crea all'avvio: un utente che non usa nodi di database non deve
 * ritrovarsi un archivio vuoto che non ha chiesto.
 */
export async function workingDatabase(): Promise<string> {
  if (cachedId) return cachedId;

  const { databases } = await runtimeApi.get<{ databases: RuntimeDatabase[] }>('/db/databases');
  const found = databases.find((d) => d.name === DATABASE_NAME);
  if (found) {
    cachedId = found.id;
    return found.id;
  }

  const created = await runtimeApi.post<{ database: RuntimeDatabase }>('/db/databases', {
    name: DATABASE_NAME,
    description: 'Le tabelle create dai workflow di Medea.',
    connection: { engine: 'sqlite', file: 'medea-automazioni.sqlite' },
  });
  cachedId = created.database.id;
  return cachedId;
}

/** Le tabelle che il database contiene già. */
export async function existingTables(databaseId: string): Promise<string[]> {
  const database = await runtimeApi
    .get<{ database: RuntimeDatabase }>(`/db/databases/${databaseId}`)
    .catch(() => null);
  return (database?.database.tables ?? []).map((t) => t.name);
}

/** Una tabella nella forma che DB Studio si aspetta. */
function toMigration(table: PlannedTable) {
  return {
    kind: 'create_table' as const,
    table: {
      id: `medea_${table.name}`,
      name: table.name,
      description: 'Creata da un workflow di Medea.',
      columns: table.columns.map((column) => ({
        id: `${table.name}_${column.name}`,
        name: column.name,
        type: column.type,
        constraints:
          column.name === 'id'
            ? { primaryKey: true, nullable: false, unique: true }
            : { nullable: true },
      })),
      indexes: [],
    },
  };
}

export interface CreateReport {
  created: string[];
  problems: string[];
}

/**
 * Crea le tabelle mancanti.
 *
 * Una tabella che fallisce non ferma le altre: meglio tre create su quattro e
 * un avviso preciso, che un errore unico che non dice quale.
 */
export async function createTables(tables: readonly PlannedTable[]): Promise<CreateReport> {
  const report: CreateReport = { created: [], problems: [] };
  if (tables.length === 0) return report;

  const databaseId = await workingDatabase();

  for (const table of tables) {
    try {
      await runtimeApi.post(`/db/databases/${databaseId}/migrations/apply`, {
        actions: [toMigration(table)],
      });
      report.created.push(table.name);
    } catch (e) {
      report.problems.push(`${table.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return report;
}

/** Dimentica il database ricordato: serve quando il runtime riparte da zero. */
export function forgetWorkingDatabase(): void {
  cachedId = null;
}
