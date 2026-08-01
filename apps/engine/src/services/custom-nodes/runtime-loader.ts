/**
 * Custom Node Editor — runtime loader.
 *
 * Risolve un `defId` (formato `custom_<slug>`) per un dato workspace nella
 * sua entry compilata. Strategy: read-through cache (in-memory) con
 * fallback DB lookup; se il nodo non e\` published_priv | marketplace_*
 * → undefined (engine emette skip marker, no throw).
 *
 * Tipico flow:
 *   workflow engine → resolveServerExecutor(defId)
 *     → customNodeExecutor
 *       → loadCustomNodeForRun(defId, workspaceId)
 *         → cache hit? return entry
 *         → cache miss? db lookup → cache fill → return
 *
 * Hot-reload e\` garantito da `invalidateCustomNode()` chiamato da
 * service.ts su update / archive / publish / unpublish.
 *
 * @module services/custom-nodes/runtime-loader
 */

import { getDatabase } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';
import {
  getCustomNodeCache,
  setCustomNodeCache,
  type CompiledCustomNodeEntry,
} from './cache.js';
import { verifyPackageIntegrity, INTEGRITY_ENFORCED_FLAG } from '@/lib/custom-node-integrity.js';
import { registrySecret } from '@/lib/registry-secret.js';

/** Status che abilitano l'esecuzione runtime del nodo. */
const RUNNABLE_STATUSES = new Set([
  'published_priv',
  'marketplace_pending',
  'marketplace_published',
]);

interface DbRow {
  semver: string;
  status: string;
  source_executor: string;
  source_definition: string;
  source_schema: string;
  compiled_executor: string | null;
  slug: string;
  integrity_digest: string | null;
  integrity_signature: string | null;
  integrity_algo: string | null;
}

/**
 * Estrae lo slug dal defId. Se il prefisso non e\` `custom_`, ritorna null
 * (il caller dispatcha altrove). Anti-injection: slug regex stretta.
 */
export function parseCustomDefId(defId: string): string | null {
  if (!defId.startsWith('custom_')) return null;
  const slug = defId.slice('custom_'.length);
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(slug)) return null;
  return slug;
}

/**
 * Restituisce la entry compilata per il defId del workspace, o null se non
 * runnable (archived, draft, candidate, non-esistente, no compile).
 */
export function loadCustomNodeForRun(
  defId: string,
  workspaceId: string,
): CompiledCustomNodeEntry | null {
  // 1. Cache lookup
  const cached = getCustomNodeCache(workspaceId, defId);
  if (cached) {
    if (!RUNNABLE_STATUSES.has(cached.status)) return null;
    if (!cached.compiledExecutor) return null;
    return cached;
  }

  // 2. DB lookup (solo runnable)
  const slug = parseCustomDefId(defId);
  if (!slug) return null;

  const handle = getDatabase();
  const row = handle.sqlite.prepare(
    `SELECT semver, status, source_executor, source_definition, source_schema, compiled_executor, slug,
            integrity_digest, integrity_signature, integrity_algo
       FROM custom_nodes
      WHERE workspace_id = ? AND slug = ?
      LIMIT 1`,
  ).get(workspaceId, slug) as DbRow | undefined;

  if (!row) return null;
  if (!RUNNABLE_STATUSES.has(row.status)) return null;
  if (!row.compiled_executor) {
    logger.warn({ workspaceId, defId, status: row.status }, '[custom-node] runnable but no compiled_executor — re-compile required');
    return null;
  }

  // Registry integrity (cold-load). Tre casi:
  //   1. record presente + secret → verifica COMPLETA (sorgenti + il
  //      compiled_executor che il sandbox esegue). Mismatch → blocco.
  //   2. record presente + secret ASSENTE → FAIL-CLOSED: non possiamo
  //      verificare ⇒ non eseguiamo (un secret sparito dall'env è un'anomalia
  //      operativa, non un via libera). Evita anche il crash di createHmac
  //      con key vuota.
  //   3. record ASSENTE + secret → se il backfill one-time è già passato
  //      (system_flags), OGNI nodo runnable deve avere integrità: assenza =
  //      strip-attack (UPDATE che azzera integrity_* per ricadere nel
  //      percorso legacy) → blocco. Senza flag (pre-backfill) → legacy, ok.
  const secret = registrySecret();
  if (row.integrity_digest) {
    if (!secret) {
      logger.error(
        { workspaceId, defId, semver: row.semver },
        '[custom-node] SECURITY: record di integrità presente ma nessun registry secret nell\'env — impossibile verificare, esecuzione bloccata (fail-closed)',
      );
      return null;
    }
    const verdict = verifyPackageIntegrity(
      {
        slug: row.slug,
        semver: row.semver,
        sourceExecutor: row.source_executor,
        sourceDefinition: row.source_definition,
        sourceSchema: row.source_schema,
        compiledExecutor: row.compiled_executor,
      },
      { algo: row.integrity_algo as never, digest: row.integrity_digest, signature: row.integrity_signature ?? '' },
      secret,
    );
    if (!verdict.valid) {
      // BLOCCO DURO a ogni cold-load: signature_mismatch da solo NON è
      // distinguibile, qui, da un record FORGIATO (un attaccante che scrive
      // sorgenti malevoli + digest ricalcolato + firma qualsiasi). Il digest
      // non basta: l'attaccante lo controlla. La rotazione LEGITTIMA del secret
      // (incidente owner 2026-06-12: registry secret derivava dal token
      // effimero, vedi registry-secret.ts) si risolve col resign-backfill
      // ONE-TIME al boot (migrate.resignCustomNodesWithStableSecret), che è una
      // azione di SISTEMA gated da flag — non un percorso sfruttabile per-run.
      logger.error(
        { workspaceId, defId, semver: row.semver, reason: verdict.reason },
        '[custom-node] SECURITY: integrità pacchetto NON valida — esecuzione bloccata',
      );
      return null;
    }
  } else if (secret) {
    const enforced = handle.sqlite.prepare(
      'SELECT value FROM system_flags WHERE key = ?',
    ).get(INTEGRITY_ENFORCED_FLAG) as { value: string } | undefined;
    if (enforced) {
      logger.error(
        { workspaceId, defId, semver: row.semver, enforcedAt: enforced.value },
        '[custom-node] SECURITY: nodo runnable SENZA record di integrità con enforcement attivo — possibile strip-attack, esecuzione bloccata',
      );
      return null;
    }
  }

  const entry: CompiledCustomNodeEntry = {
    defId,
    workspaceId,
    semver: row.semver,
    compiledExecutor: row.compiled_executor,
    sourceDefinition: row.source_definition,
    sourceSchema: row.source_schema,
    status: row.status,
    cachedAt: Date.now(),
  };
  setCustomNodeCache(entry);
  return entry;
}
