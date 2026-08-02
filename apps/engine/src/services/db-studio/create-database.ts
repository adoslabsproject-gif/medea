/**
 * createTenantDatabase — UNICA logica di creazione di un database del workspace,
 * condivisa tra la route REST (`POST /db/databases`) e il tool del DB-agent
 * (`create_database`). Niente duplicazione del flusso "managed = provisiona il
 * sidecar nel tenant + salva la connessione risolta".
 *
 * Due percorsi:
 *  • MANAGED   → l'engine (postgres/mongodb/…) viene installato come sidecar nel
 *    tenant (provisionManagedDb → portal). I dati consumano la quota del piano.
 *  • EMBEDDED  → sqlite/duckdb/vector-embedded girano nel runtime, zero-config.
 *
 * Gli engine server SENZA managed richiedono credenziali esterne → quel percorso
 * resta nella route REST (form UI), non qui: il tool LLM non inventa credenziali.
 *
 * @module services/db-studio/create-database
 */
import type { Database, DatabaseEngine } from '@medea/engine-db-studio-core';
import type { DbStudioService } from '@/services/db-studio.service.js';
import { provisionManagedDb, isManagedEngine } from './managed-db-client.js';

/** Engine che girano DENTRO il runtime (nessun server esterno, nessuna credenziale). */
const EMBEDDED_ENGINES = new Set(['sqlite', 'duckdb', 'vector-embedded']);
export function isEmbeddedEngine(engine: string): boolean {
  return EMBEDDED_ENGINES.has(engine);
}

export class CreateDatabaseError extends Error {
  constructor(
    readonly code: 'ENGINE_NOT_MANAGEABLE' | 'ENGINE_NEEDS_CONNECTION',
    message: string,
  ) {
    super(message);
    this.name = 'CreateDatabaseError';
  }
}

export interface CreateTenantDatabaseInput {
  tenantId: string;
  name: string;
  description?: string;
  /** Engine richiesto. Default a monte = 'sqlite'. */
  engine: DatabaseEngine;
  /** true = installa il sidecar nel tenant; false = embedded. */
  managed: boolean;
  dbStudio: DbStudioService;
}

/**
 * Crea il database e (se managed) provisiona il sidecar.
 * @throws CreateDatabaseError  engine non installabile / che richiede connessione esterna
 * @throws ManagedDbError       provisioning del sidecar non riuscito (propagato)
 */
export async function createTenantDatabase(input: CreateTenantDatabaseInput): Promise<Database> {
  const { tenantId, name, engine, dbStudio } = input;
  const description = input.description ?? 'Database creato da Liara (DB-agent)';

  if (input.managed) {
    if (!isManagedEngine(engine)) {
      throw new CreateDatabaseError(
        'ENGINE_NOT_MANAGEABLE',
        `L'engine "${engine}" non può essere installato nel tenant (usa una connessione esterna).`,
      );
    }
    const p = await provisionManagedDb(tenantId, engine); // può lanciare ManagedDbError
    return dbStudio.create({
      tenantId,
      name,
      description,
      connection: {
        engine,
        embedded: false,
        managed: true,
        provisionStatus: 'ready',
        hostname: p.host,
        port: p.port,
        database: p.database,
        username: p.username,
        passwordSecretRef: p.password, // credenziale letterale (sqlite tenant isolato)
        sslMode: 'disable', // sidecar su rete docker interna, no TLS
      },
      tables: [],
      relations: [],
    });
  }

  if (!isEmbeddedEngine(engine)) {
    throw new CreateDatabaseError(
      'ENGINE_NEEDS_CONNECTION',
      `L'engine "${engine}" richiede una connessione esterna o l'installazione nel tenant (managed=true).`,
    );
  }
  return dbStudio.create({
    tenantId,
    name,
    description,
    connection: { engine, embedded: true },
    tables: [],
    relations: [],
  });
}
