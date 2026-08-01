/**
 * Tipi + porte (interfacce minime) del modulo private-generations.
 *
 * Le porte catturano SOLO i metodi usati di DbStudioService e BinaryStore →
 * mockabili nei test senza tirarsi dietro l'intera implementazione, e i tipi
 * reali le soddisfano strutturalmente.
 *
 * @module services/private-generations/types
 */
import type { Rating } from './schema.js';

/** Database DB Studio (forma minima che ci serve). */
export interface DbRef {
  id: string;
  name: string;
}

/** Porta su DbStudioService — solo i metodi usati qui. */
export interface DbStudioPort {
  list(tenantId?: string): DbRef[];
  insert(id: string, table: string, row: Record<string, unknown>, tenantId?: string): Promise<unknown>;
  updateRow(id: string, table: string, where: Record<string, unknown>, patch: Record<string, unknown>, tenantId?: string): Promise<unknown>;
  query(id: string, spec: unknown, tenantId?: string): Promise<unknown>;
  executeRaw(id: string, sql: string, opts: { dryRun?: boolean; rowLimit?: number }, tenantId?: string): Promise<unknown>;
}

/** Porta su BinaryStore — solo write/read. */
export interface BlobStorePort {
  writeBuffer(data: Buffer): Promise<{ ref: string; size: number }>;
  read(ref: string): Promise<Buffer>;
}

/** Funzione che crea un DB embedded sqlite del tenant (wrap di createTenantDatabase). */
export type CreateEmbeddedDb = (name: string) => Promise<DbRef>;

/** Dipendenze iniettate nel servizio (DI puro → testabile). */
export interface PrivateGenerationsDeps {
  dbStudio: DbStudioPort;
  blobStore: BlobStorePort;
  createEmbeddedDb: CreateEmbeddedDb;
  tenantId: string;
}

/** Input di salvataggio di una generazione. */
export interface SaveGenerationInput {
  kind: 'image' | 'video';
  prompt: string;
  negative?: string | undefined;
  params?: Record<string, unknown> | undefined;
  seed?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  checkpoint?: string | undefined;
  mime: string;
  /** Byte del media (da gen-studio, dopo la generazione ComfyUI). */
  bytes: Buffer;
  /** Conversazione di appartenenza (per salvare/riprendere le sessioni). */
  conversationId?: string | undefined;
}

/** Riepilogo di una conversazione (per la lista laterale). */
export interface ConversationSummary {
  id: string;
  count: number;
  lastAt: string;
  title: string;
}

/** Un elemento di una conversazione caricata (per ri-renderizzarla). */
export interface ConversationItem {
  id: string;
  created_at: string;
  kind: string;
  prompt: string;
  media_ref: string;
  mime: string;
  rating: Rating | null;
}

export interface SaveGenerationResult {
  id: string;
  mediaRef: string;
  size: number;
}

export interface GenerationRecord {
  id: string;
  created_at: string;
  kind: string;
  prompt: string;
  negative: string | null;
  seed: number | null;
  rating: Rating | null;
  mime: string;
  media_ref: string;
  size_bytes: number | null;
}
