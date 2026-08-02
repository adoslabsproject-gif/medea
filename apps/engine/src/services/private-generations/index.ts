/**
 * private-generations — storage privato delle generazioni media (immagini/video)
 * nel DB del tenant via DB Studio, con i byte nel BinaryStore content-addressed.
 *
 * Facade che lega ensure-db + repository, più una factory che cabla i servizi
 * reali (DbStudioService, BinaryStore, createTenantDatabase) per il tenant del
 * container (config.MEDEA_TENANT_ID). Le funzioni pure stanno nei moduli
 * fratelli e sono testate in isolamento.
 *
 * @module services/private-generations
 */
import { DbStudioService } from '@/services/db-studio.service.js';
import { getBinaryStore } from '@/services/binary-store.service.js';
import { createTenantDatabase } from '@/services/db-studio/create-database.js';
import { ensureGenerationsDb } from './ensure-db.js';
import {
  deleteConversation,
  getConversation,
  getGeneration,
  listConversations,
  listGenerations,
  rateGeneration,
  saveGeneration,
  type RepoDeps,
} from './repository.js';
import type { ConversationItem, ConversationSummary } from './types.js';
import type {
  GenerationRecord,
  PrivateGenerationsDeps,
  SaveGenerationInput,
  SaveGenerationResult,
} from './types.js';
import type { Rating } from './schema.js';

export class PrivateGenerationsService {
  constructor(private readonly deps: PrivateGenerationsDeps) {}

  private async repoDeps(): Promise<RepoDeps> {
    const dbId = await ensureGenerationsDb({
      dbStudio: this.deps.dbStudio,
      createEmbeddedDb: this.deps.createEmbeddedDb,
      tenantId: this.deps.tenantId,
    });
    return { dbStudio: this.deps.dbStudio, blobStore: this.deps.blobStore, tenantId: this.deps.tenantId, dbId };
  }

  async save(input: SaveGenerationInput): Promise<SaveGenerationResult> {
    return saveGeneration(await this.repoDeps(), input);
  }

  async rate(id: string, rating: Rating | null): Promise<void> {
    return rateGeneration(await this.repoDeps(), id, rating);
  }

  async list(limit?: number): Promise<GenerationRecord[]> {
    return listGenerations(await this.repoDeps(), limit);
  }

  async conversations(): Promise<ConversationSummary[]> {
    return listConversations(await this.repoDeps());
  }

  async conversation(id: string): Promise<ConversationItem[]> {
    return getConversation(await this.repoDeps(), id);
  }

  async deleteConversation(id: string): Promise<void> {
    return deleteConversation(await this.repoDeps(), id);
  }

  /** Sorgente per l'estensione video: metadati + BYTE del media (dal blob store). */
  async getForExtend(id: string): Promise<{ prompt: string; mime: string; kind: string; params: Record<string, unknown>; bytes: Buffer } | null> {
    const deps = await this.repoDeps();
    const row = await getGeneration(deps, id);
    if (!row) return null;
    const bytes = await this.deps.blobStore.read(row.mediaRef);
    return { prompt: row.prompt, mime: row.mime, kind: row.kind, params: row.params, bytes };
  }
}

/** Cabla i servizi reali per il tenant del container. */
export function createPrivateGenerationsService(): PrivateGenerationsService {
  const dbStudio = new DbStudioService();
  // Tenant del container = source of truth (come middleware/auth.ts). No header esterni.
  const tenantId = process.env.MEDEA_TENANT_ID || 'default';
  return new PrivateGenerationsService({
    dbStudio,
    blobStore: getBinaryStore(),
    tenantId,
    createEmbeddedDb: async (name) => {
      const db = await createTenantDatabase({ tenantId, name, engine: 'sqlite', managed: false, dbStudio });
      return { id: db.id, name: db.name };
    },
  });
}

export type { GenerationRecord, SaveGenerationInput, SaveGenerationResult } from './types.js';
export { GENERATIONS_DB_NAME, GENERATIONS_TABLE } from './schema.js';
