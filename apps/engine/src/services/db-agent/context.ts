/**
 * DbAgentContext — l'UNICO portatore del tenant per il DB-agent di Liara.
 *
 * REGOLA DI SICUREZZA (la più importante di tutto il sottosistema):
 * il `tenantId` entra QUI, una volta sola, derivato server-side da
 * `getTenantId(c)` (JWT firmato, spoof-proof). Da questo punto in poi NESSUN
 * tool legge mai il tenant dagli argomenti del modello: lo prende sempre e
 * solo da `ctx.tenantId`. Il contesto è congelato (`Object.freeze`) così
 * nemmeno un tool bacato può riscriverlo a runtime.
 *
 * Conseguenza: Liara non può, per costruzione, operare su un tenant diverso
 * dal proprio — anche se l'LLM "inventasse" un tenantId negli args, quello
 * verrebbe rifiutato dalla validazione `.strict()` dei tool e comunque ignorato.
 *
 * @module services/db-agent/context
 */
import { DbStudioService } from '@/services/db-studio.service.js';
import { TenantScopeError } from './errors.js';

export interface DbAgentContext {
  /** Tenant effettivo — readonly, derivato dal JWT, mai dagli args del modello. */
  readonly tenantId: string;
  /** Service tenant-scoped. Iniettabile nei test; in prod istanza fresca. */
  readonly dbStudio: DbStudioService;
  /**
   * GATE SCRITTURE (human-in-the-loop). I tool distruttivi (insert/update/delete/
   * schema) vengono eseguiti SOLO se questo è true. Deriva da un consenso ESPLICITO
   * dell'utente per-richiesta (toggle UI), MAI da una decisione dell'LLM → un
   * prompt-injection nei dati del DB non può auto-autorizzare scritture. Default false.
   */
  readonly allowWrites: boolean;
}

/**
 * Crea il contesto DB-agent. `tenantId` DEVE arrivare da `getTenantId(c)`.
 *
 * Accetta `string | null | undefined` di proposito: la factory È la guardia —
 * un chiamante JS che passasse un tenant assente viene RIFIUTATO qui con un
 * errore tipato, non con un TypeError più a valle.
 *
 * `allowWrites` default false: di default Liara è in SOLA LETTURA; le scritture
 * vanno abilitate esplicitamente dall'utente (mai dal modello).
 *
 * @throws TenantScopeError se il tenant è vuoto (mai operare "senza tenant").
 */
export function createDbAgentContext(
  tenantId: string | null | undefined,
  dbStudio?: DbStudioService,
  allowWrites = false,
): DbAgentContext {
  const t = (tenantId ?? '').trim();
  if (!t) {
    throw new TenantScopeError(
      'Contesto DB-agent senza tenant: rifiutato. Il tenant va derivato server-side dalla sessione.',
    );
  }
  return Object.freeze({ tenantId: t, dbStudio: dbStudio ?? new DbStudioService(), allowWrites });
}
