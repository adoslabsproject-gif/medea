/**
 * TenantScopedVectorStore — wrapper di isolamento per-tenant su QUALSIASI IVectorAdapter.
 *
 * Rende l'isolamento STRUTTURALMENTE impossibile da violare, non solo "filtrato":
 *  - il `tenantId` arriva dal context fidato (non input utente) ed è validato;
 *  - il nome collection fornito dall'utente è validato a `^[A-Za-z0-9_-]{1,64}$`
 *    → NON può contenere il separatore `::`, quindi un tenant non può forgiare un
 *    nome che ricada nel namespace di un altro tenant;
 *  - ogni operazione opera su `"<tenantId>::<collection>"`; `listCollections`
 *    ritorna SOLO le collection del tenant, con il prefisso rimosso.
 *
 * Vale per pgvector (store centrale condiviso) E per l'embedded (store fisico
 * per-container): nel primo è l'unica barriera cross-tenant; nel secondo è
 * difesa-in-profondità.
 */
import type {
  IVectorAdapter,
  VectorRecord,
  SimilaritySearchQuery,
  SimilaritySearchResult,
  CollectionInfo,
} from './types.js';

const SEPARATOR = '::';
const TENANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const COLLECTION_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class TenantIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantIsolationError';
  }
}

export class TenantScopedVectorStore implements IVectorAdapter {
  readonly engine: IVectorAdapter['engine'];
  private readonly prefix: string;

  constructor(
    private readonly inner: IVectorAdapter,
    tenantId: string,
  ) {
    if (!TENANT_ID_RE.test(tenantId)) {
      throw new TenantIsolationError(`tenantId non valido: "${tenantId}" (atteso ^[A-Za-z0-9_-]{1,64}$)`);
    }
    this.engine = inner.engine;
    this.prefix = `${tenantId}${SEPARATOR}`;
  }

  /** Valida il nome collection utente e lo namespacizza. Forgiare un altro tenant è impossibile. */
  private scope(collection: string): string {
    if (!COLLECTION_RE.test(collection)) {
      throw new TenantIsolationError(
        `nome collection non valido: "${collection}" (atteso ^[A-Za-z0-9_-]{1,64}$, niente "::")`,
      );
    }
    return `${this.prefix}${collection}`;
  }

  // NB: metodi `async` di proposito — così un nome collection invalido produce una
  // PROMISE REJECTED (non un throw sincrono): API async coerente, il chiamante usa
  // sempre .catch()/await-try senza dover gestire eccezioni sincrone.
  async ensureCollection(name: string, dimensions: number, distance: 'cosine' | 'euclidean' | 'dot'): Promise<void> {
    return this.inner.ensureCollection(this.scope(name), dimensions, distance);
  }

  async upsert(collection: string, records: readonly VectorRecord[]): Promise<{ count: number }> {
    return this.inner.upsert(this.scope(collection), records);
  }

  async search(collection: string, query: SimilaritySearchQuery): Promise<SimilaritySearchResult[]> {
    return this.inner.search(this.scope(collection), query);
  }

  async deleteByIds(collection: string, ids: readonly string[]): Promise<{ count: number }> {
    return this.inner.deleteByIds(this.scope(collection), ids);
  }

  async countCollection(name: string): Promise<number> {
    return this.inner.countCollection(this.scope(name));
  }

  async dropCollection(name: string): Promise<void> {
    return this.inner.dropCollection(this.scope(name));
  }

  async existsById(collection: string, id: string): Promise<boolean> {
    if (!this.inner.existsById) return false; // backend senza supporto → net-add conservativo
    return this.inner.existsById(this.scope(collection), id);
  }

  /** SOLO le collection di questo tenant, con il prefisso rimosso. */
  async listCollections(): Promise<CollectionInfo[]> {
    const all = await this.inner.listCollections();
    return all
      .filter((c) => c.name.startsWith(this.prefix))
      .map((c) => ({ ...c, name: c.name.slice(this.prefix.length) }));
  }
}
