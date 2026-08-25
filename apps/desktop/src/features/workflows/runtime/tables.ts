/**
 * Creare davvero le tabelle che il workflow dà per esistenti.
 *
 * Il piano lo fa `table-plan.ts`; qui si parla col runtime. Le tabelle nascono
 * in un database SQLite dentro i dati del runtime: è un archivio di lavoro
 * delle automazioni, non il database di Medea — che resta intoccabile e non si
 * lascia ombreggiare da una tabella generata.
 *
 * ── Un archivio per workflow ──
 *
 * Prima ce n'era **uno solo**, condiviso da tutti. Due workflow che nominavano
 * una tabella `inbox` finivano sulla stessa, e due workflow con lo STESSO NOME
 * erano indistinguibili: non si poteva dire di chi fosse una tabella, e quindi
 * non si poteva nemmeno cancellarne una senza rischiare di portarsi via i dati
 * di un altro.
 *
 * Adesso ogni workflow ha il suo, e l'identità è il suo **id** — non il nome,
 * che può ripetersi e cambiare. Il legame sta in un marcatore dentro la
 * descrizione: sopravvive a chi rinomina il workflow, e resta leggibile in DB
 * Studio invece di essere una convenzione nascosta.
 *
 * L'archivio condiviso di prima non si tocca: chi ce l'ha dentro dei dati se
 * li tiene, e nessuna cancellazione di workflow lo sfiora — non ha marcatore,
 * quindi non appartiene a nessuno.
 *
 * @module features/workflows/runtime/tables
 */

import type { QualityDatabase } from '../quality';

import { runtimeApi } from './client';
import type { PlannedTable } from './table-plan';

/** Il nome dell'archivio condiviso nato prima che ce ne fosse uno per workflow. */
const DATABASE_CONDIVISO = 'Medea — dati delle automazioni';

/**
 * Il marcatore che lega un archivio al suo workflow.
 *
 * Sta nella descrizione e non nel nome perché il nome è dell'utente: può
 * rinominare il workflow, e il legame non deve spezzarsi. L'id invece non
 * cambia mai.
 */
export function marcatoreWorkflow(workflowId: string | number): string {
  return `medea:workflow:${String(workflowId)}`;
}

interface RuntimeDatabase {
  id: string;
  name: string;
  description?: string;
  /** Le colonne arrivano solo dal dettaglio di un database, non dall'elenco. */
  tables?: { name: string; columns?: { name: string }[] }[];
}

/**
 * Le ricerche in corso, una per workflow.
 *
 * Ricordare l'**id** non basta: fra il controllo della cache e la creazione c'è
 * un `await`, e due chiamate partite insieme lo superano entrambe, non trovano
 * niente entrambe, e creano un archivio a testa. Non è teoria — il 2026-08-05
 * alle 15:40:45.915 ne sono nati DUE con lo stesso nome, allo stesso
 * millisecondo: `StrictMode` monta gli effetti due volte in sviluppo, e tanto è
 * bastato. Da lì in poi le tabelle stavano in uno e il wizard poteva guardare
 * nell'altro, che risultava vuoto.
 *
 * Ricordare la PROMESSA rende la seconda chiamata un'attesa della prima.
 */
const inCorso = new Map<string, Promise<string>>();

/**
 * Fra più archivi che si somigliano, quello giusto — sempre lo stesso.
 *
 * I doppioni nati dalla corsa restano sul disco di chi li ha già: sceglierne
 * uno a caso significherebbe vedere le proprie tabelle a giorni alterni. Vince
 * quello che ha delle tabelle; a parità, il primo in ordine di id, che è
 * stabile fra un avvio e l'altro.
 */
function sceltaStabile(candidati: readonly RuntimeDatabase[]): RuntimeDatabase | undefined {
  const ordinati = [...candidati].sort((a, b) => {
    const perTabelle = (b.tables?.length ?? 0) - (a.tables?.length ?? 0);
    return perTabelle !== 0 ? perTabelle : a.id.localeCompare(b.id);
  });
  return ordinati[0];
}

/** Il nome mostrato in DB Studio: leggibile, e distinto anche fra omonimi. */
function nomeArchivio(workflowId: string | number, nomeWorkflow: string): string {
  const pulito = nomeWorkflow.trim() || 'senza nome';
  return `${pulito} · #${String(workflowId)}`;
}

/**
 * L'archivio di questo workflow, creato la prima volta che serve.
 *
 * Non si crea all'avvio: un workflow che non usa nodi di database non deve
 * ritrovarsi un archivio vuoto che nessuno ha chiesto.
 */
export async function databaseDelWorkflow(
  workflowId: string | number,
  nomeWorkflow: string,
): Promise<string> {
  const chiave = String(workflowId);
  const marcatore = marcatoreWorkflow(chiave);

  let ricerca = inCorso.get(chiave);
  ricerca ??= (async () => {
    const { databases } = await runtimeApi.get<{ databases: RuntimeDatabase[] }>('/db/databases');
    const suoi = databases.filter((d) => (d.description ?? '').includes(marcatore));
    const scelto = sceltaStabile(suoi);
    if (scelto) return scelto.id;

    const created = await runtimeApi.post<{ database: RuntimeDatabase }>('/db/databases', {
      name: nomeArchivio(chiave, nomeWorkflow),
      description: `Tabelle del workflow «${nomeWorkflow}». ${marcatore}`,
      connection: { engine: 'sqlite' },
    });
    return created.database.id;
  })();
  inCorso.set(chiave, ricerca);

  try {
    return await ricerca;
  } catch (e) {
    // Un errore non deve restare appiccicato: la prossima chiamata deve poter
    // riprovare, non ereditare per sempre il fallimento di questa.
    inCorso.delete(chiave);
    throw e;
  }
}

/** Gli archivi che appartengono a questo workflow. Vuoto se non ne ha. */
export async function archiviDelWorkflow(workflowId: string | number): Promise<string[]> {
  const marcatore = marcatoreWorkflow(workflowId);
  const risposta = await runtimeApi
    .get<{ databases: RuntimeDatabase[] }>('/db/databases')
    .catch(() => null);
  return (risposta?.databases ?? [])
    .filter((d) => (d.description ?? '').includes(marcatore))
    .map((d) => d.id);
}

/**
 * Elimina gli archivi di un workflow, con le loro tabelle.
 *
 * Solo i suoi: il filtro è il marcatore, quindi l'archivio condiviso nato
 * prima — che non ne ha — non viene mai toccato, e nemmeno quello di un altro
 * workflow che per caso si chiama uguale.
 */
export async function eliminaArchiviDelWorkflow(
  workflowId: string | number,
): Promise<{ eliminati: number; problemi: string[] }> {
  const ids = await archiviDelWorkflow(workflowId);
  const problemi: string[] = [];
  let eliminati = 0;

  for (const id of ids) {
    try {
      await runtimeApi.delete(`/db/databases/${id}`);
      eliminati += 1;
    } catch (e) {
      problemi.push(e instanceof Error ? e.message : String(e));
    }
  }
  inCorso.delete(String(workflowId));
  return { eliminati, problemi };
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
 * Crea le tabelle mancanti nell'archivio indicato.
 *
 * Una tabella che fallisce non ferma le altre: meglio tre create su quattro e
 * un avviso preciso, che un errore unico che non dice quale.
 */
export async function createTables(
  databaseId: string,
  tables: readonly PlannedTable[],
): Promise<CreateReport> {
  const report: CreateReport = { created: [], problems: [] };

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

/** Dimentica gli archivi ricordati: serve quando il runtime riparte da zero. */
export function forgetWorkingDatabase(): void {
  inCorso.clear();
}

/**
 * I database e le loro tabelle, nella forma che il controllo di qualità legge.
 *
 * Serve al wizard, che finora chiamava `gateWorkflow(workflow, undefined, …)`:
 * senza schemi, le regole `DB_TABLE_NOT_IN_SCHEMA` e `DB_COLUMN_NOT_IN_SCHEMA`
 * non avevano niente da confrontare ed erano **morte**. Il 2026-08-05 sono
 * passati due workflow che interrogavano tabelle inesistenti — `inbox` e
 * `ordini` — senza una segnalazione: le regole per prenderli c'erano già, e
 * nessuno gli dava i dati.
 *
 * Se il motore non risponde si torna un elenco vuoto invece di far fallire la
 * costruzione: un controllo in meno è meglio di un wizard che non parte.
 */
export async function databasesPerQualita(): Promise<QualityDatabase[]> {
  const risposta = await runtimeApi
    .get<{ databases: RuntimeDatabase[] }>('/db/databases')
    .catch(() => null);
  if (!risposta) return [];

  const out: QualityDatabase[] = [];
  for (const d of risposta.databases) {
    const dettaglio = await runtimeApi
      .get<{ database: RuntimeDatabase }>(`/db/databases/${d.id}`)
      .catch(() => null);
    const tables = dettaglio?.database.tables ?? [];
    const columns: Record<string, string[]> = {};
    for (const t of tables) {
      const nomi = (t.columns ?? []).map((c) => c.name);
      if (nomi.length > 0) columns[t.name] = nomi;
    }
    out.push({ id: d.id, tables: tables.map((t) => t.name), columns });
  }
  return out;
}

/** Il nome dell'archivio condiviso storico, per chi deve riconoscerlo. */
export { DATABASE_CONDIVISO };
