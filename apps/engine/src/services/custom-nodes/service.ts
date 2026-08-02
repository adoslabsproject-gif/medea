/**
 * Custom Node Editor — CRUD service (Cappella Sistina Fase 1).
 *
 * Responsabilità:
 *  - Create / Read / Update / Archive di un custom node nel tenant.
 *  - Snapshot append-only ad ogni save (custom_node_versions).
 *  - Bump semver automatico (patch/minor/major) o esplicito.
 *  - Rollback ad una versione precedente (carica snapshot + bump patch).
 *  - Counter quota (collabora con plan-gating.ts).
 *
 * Tenant isolation: tutti i metodi accettano `workspaceId` come param esplicito
 * (filtro WHERE) anche se il container è single-tenant — defensive coding +
 * test isolation friendly.
 *
 * @module services/custom-nodes/service
 */

import { randomUUID } from 'node:crypto';
import { eq, and, desc, ne } from 'drizzle-orm';
import { getDatabase } from '@/storage/db.js';
import { customNodes, customNodeVersions } from '@/storage/schema.js';
// NOTE: usiamo raw `stmt.get()` di better-sqlite3 che restituisce SNAKE_CASE.
// Il mapping snake→camel e\` fatto a mano in `rowToDomain`/`rowToSummary`/etc.
// (Drizzle query builder farebbe il mapping ma userebbe un secondo path di
// connessione, qui restiamo con il `handle.sqlite` per consistenza con il
// resto del runtime.)
interface RawSqliteRow {
  id: string;
  workspace_id: string;
  owner_user_id: string;
  slug: string;
  display_name: string;
  description: string | null;
  icon_svg: string | null;
  category: string | null;
  semver: string;
  status: string;
  source_executor: string;
  source_definition: string;
  source_schema: string;
  compiled_executor: string | null;
  compile_warnings: string | null;
  compile_at: string | null;
  test_runs: string | null;
  marketplace_submission_id: string | null;
  marketplace_submitted_at: string | null;
  marketplace_published_at: string | null;
  paypal_node_id: string | null;
  created_at: string;
  updated_at: string;
}
interface RawVersionRow {
  id: string;
  custom_node_id: string;
  semver: string;
  source_executor: string;
  source_definition: string;
  source_schema: string;
  compiled_executor: string | null;
  changelog: string | null;
  created_by: string;
  created_at: string;
}
import {
  CustomNodeNotFoundError,
  CustomNodeConflictError,
  CustomNodeValidationError,
} from './errors.js';
import {
  CustomNodeCreateInputSchema,
  CustomNodeUpdateInputSchema,
  CustomNodeListFilterSchema,
  TEST_RUNS_RING_SIZE,
  type CustomNode,
  type CustomNodeCreateInput,
  type CustomNodeUpdateInput,
  type CustomNodeListFilter,
  type CustomNodeSummary,
  type CompileDiagnostic,
  type TestRunRecord,
  type CustomNodeVersion,
} from './types.js';
import { assertCanCreateMoreCustomNodes } from './plan-gating.js';
import { invalidateCustomNode, emitCustomNodeUpdate, setCustomNodeCache } from './cache.js';
import { AuditLogService } from '@/services/audit.service.js';
import { makePackageIntegrity } from '@/lib/custom-node-integrity.js';
import { registrySecret } from '@/lib/registry-secret.js';

/**
 * Audit helper — best-effort. Una failure di scrittura audit NON deve
 * mai bloccare l'azione utente (ma logghiamo via logger). Mai throw upward.
 */
async function auditAction(opts: {
  workspaceId: string;
  actorUserId: string;
  action: string;
  customNodeId: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    const audit = new AuditLogService();
    await audit.append({
      tenantId: opts.workspaceId,
      actorId: opts.actorUserId,
      action: opts.action,
      resourceType: 'custom_node',
      resourceId: opts.customNodeId,
      ...(opts.meta ? { metadata: opts.meta } : {}),
    });
  } catch {
    // Audit DB unreachable / test-mock-only: non blocca l'azione user-facing
  }
}

/**
 * Convenzione defId per i custom node: prefisso `custom_` + slug. Il
 * resolver runtime (registry.ts) usa il prefisso per dispatchare al
 * customNodeExecutor invece che a stdlib/community-node.
 */
export function customNodeDefId(slug: string): string {
  return `custom_${slug}`;
}

const nowIso = (): string => new Date().toISOString();

/** Patch-merge: `provided` se fornito (≠ undefined), altrimenti `current`. A
 *  differenza di `??` PRESERVA un `null` esplicito (azzeramento campo). `if` di
 *  proposito (non ternario) per non incrociare prefer-nullish-coalescing. */
function pickProvided<T>(provided: T | undefined, current: T): T {
  if (provided === undefined) return current;
  return provided;
}

function parseJsonArray<T>(s: string | null): T[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Mappa una riga DB snake_case → dominio CustomNode camelCase. */
function rowToDomain(row: RawSqliteRow): CustomNode {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    slug: row.slug,
    displayName: row.display_name,
    description: row.description,
    iconSvg: row.icon_svg,
    category: row.category,
    semver: row.semver,
    status: row.status as CustomNode['status'],
    sourceExecutor: row.source_executor,
    sourceDefinition: row.source_definition,
    sourceSchema: row.source_schema,
    compiledExecutor: row.compiled_executor,
    compileWarnings: parseJsonArray<CompileDiagnostic>(row.compile_warnings),
    compileAt: row.compile_at,
    testRuns: parseJsonArray<TestRunRecord>(row.test_runs),
    marketplaceSubmissionId: row.marketplace_submission_id,
    marketplaceSubmittedAt: row.marketplace_submitted_at,
    marketplacePublishedAt: row.marketplace_published_at,
    paypalNodeId: row.paypal_node_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSummary(row: RawSqliteRow): CustomNodeSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    slug: row.slug,
    displayName: row.display_name,
    description: row.description,
    iconSvg: row.icon_svg,
    category: row.category,
    semver: row.semver,
    status: row.status as CustomNode['status'],
    compileAt: row.compile_at,
    marketplaceSubmittedAt: row.marketplace_submitted_at,
    marketplacePublishedAt: row.marketplace_published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Mappa una riga custom_node_versions snake → camel. */
function versionRowToDomain(row: RawVersionRow): CustomNodeVersion {
  return {
    id: row.id,
    customNodeId: row.custom_node_id,
    semver: row.semver,
    sourceExecutor: row.source_executor,
    sourceDefinition: row.source_definition,
    sourceSchema: row.source_schema,
    compiledExecutor: row.compiled_executor,
    changelog: row.changelog,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/**
 * Bump semver string. Throws on malformed input (already validated by Zod
 * at the boundary, ma defensive).
 */
export function bumpSemver(current: string, bump: 'patch' | 'minor' | 'major'): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) throw new CustomNodeValidationError(`Malformed semver "${current}"`);
  const major = parseInt(match[1]!, 10);
  const minor = parseInt(match[2]!, 10);
  const patch = parseInt(match[3]!, 10);
  switch (bump) {
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'major':
      return `${major + 1}.0.0`;
  }
}

/**
 * Crea un nuovo custom node (status=draft, semver=0.1.0).
 * Plan quota enforced PRIMA dell'INSERT — throws QuotaExceeded.
 * Slug duplicato per tenant → ConflictError.
 */
export async function createCustomNode(opts: {
  workspaceId: string;
  ownerUserId: string;
  input: CustomNodeCreateInput;
}): Promise<CustomNode> {
  const input = CustomNodeCreateInputSchema.parse(opts.input);
  await assertCanCreateMoreCustomNodes(opts.workspaceId);

  const handle = getDatabase();
  const id = randomUUID();
  const at = nowIso();
  const versionId = randomUUID();
  const semver = '0.1.0';

  // Check slug unique per tenant (CHECK SQL fa fallback, ma error message friendly)
  const existing = handle.sqlite
    .prepare(
      `SELECT id FROM custom_nodes WHERE workspace_id = ? AND slug = ? AND status != 'archived' LIMIT 1`,
    )
    .get(opts.workspaceId, input.slug) as { id: string } | undefined;
  if (existing) {
    throw new CustomNodeConflictError(`Slug "${input.slug}" already exists in this workspace`, {
      slug: input.slug,
      existingId: existing.id,
    });
  }

  // Insert custom_nodes + custom_node_versions in transazione atomica
  const tx = handle.sqlite.transaction(() => {
    handle.sqlite
      .prepare(
        `INSERT INTO custom_nodes (
        id, workspace_id, owner_user_id, slug, display_name, description,
        icon_svg, category, semver, status,
        source_executor, source_definition, source_schema,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.workspaceId,
        opts.ownerUserId,
        input.slug,
        input.displayName,
        input.description ?? null,
        input.iconSvg ?? null,
        input.category ?? null,
        semver,
        input.sourceExecutor,
        input.sourceDefinition,
        input.sourceSchema,
        at,
        at,
      );
    handle.sqlite
      .prepare(
        `INSERT INTO custom_node_versions (
        id, custom_node_id, semver, source_executor, source_definition, source_schema,
        changelog, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        versionId,
        id,
        semver,
        input.sourceExecutor,
        input.sourceDefinition,
        input.sourceSchema,
        'Initial draft',
        opts.ownerUserId,
        at,
      );
  });
  tx();

  return (await getCustomNode({ workspaceId: opts.workspaceId, id }))!;
}

export function getCustomNode(opts: {
  workspaceId: string;
  id: string;
}): Promise<CustomNode | null> {
  const handle = getDatabase();
  const row = handle.sqlite
    .prepare(`SELECT * FROM custom_nodes WHERE id = ? AND workspace_id = ? LIMIT 1`)
    .get(opts.id, opts.workspaceId) as RawSqliteRow | undefined;
  return Promise.resolve(row ? rowToDomain(row) : null);
}

export function getCustomNodeBySlug(opts: {
  workspaceId: string;
  slug: string;
}): Promise<CustomNode | null> {
  const handle = getDatabase();
  const row = handle.sqlite
    .prepare(
      `SELECT * FROM custom_nodes WHERE workspace_id = ? AND slug = ? AND status != 'archived' LIMIT 1`,
    )
    .get(opts.workspaceId, opts.slug) as RawSqliteRow | undefined;
  return Promise.resolve(row ? rowToDomain(row) : null);
}

export function listCustomNodes(opts: {
  workspaceId: string;
  filter?: Partial<CustomNodeListFilter>;
}): Promise<{ items: CustomNodeSummary[]; total: number }> {
  const filter = CustomNodeListFilterSchema.parse(opts.filter ?? {});
  const handle = getDatabase();
  const where: string[] = ['workspace_id = ?'];
  const params: unknown[] = [opts.workspaceId];
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  } else where.push("status != 'archived'");
  if (filter.category) {
    where.push('category = ?');
    params.push(filter.category);
  }
  if (filter.ownerUserId) {
    where.push('owner_user_id = ?');
    params.push(filter.ownerUserId);
  }

  const whereSql = where.join(' AND ');
  const total = (
    handle.sqlite
      .prepare(`SELECT COUNT(*) AS cnt FROM custom_nodes WHERE ${whereSql}`)
      .get(...params) as { cnt: number }
  ).cnt;

  const rows = handle.sqlite
    .prepare(
      `SELECT * FROM custom_nodes WHERE ${whereSql}
       ORDER BY updated_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, filter.limit, filter.offset) as RawSqliteRow[];

  return Promise.resolve({ items: rows.map(rowToSummary), total });
}

/** Entry del catalogo custom-node per l'editor: metadata UI + sourceDefinition. */
export interface CustomNodeDefinitionEntry {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  iconSvg: string | null;
  semver: string;
  status: string;
  /** Il SOLO sorgente esposto (NodeDef metadata, ~12KB). MAI l'executor. */
  sourceDefinition: string;
}

/** Status che abilitano l'esecuzione → mostrabili nel canvas/drawer dell'editor. */
const CATALOG_RUNNABLE_STATUSES = [
  'published_priv',
  'marketplace_published',
  'marketplace_pending',
] as const;

/**
 * Definizioni dei custom node RUNNABLE del workspace per il catalogo editor.
 *
 * Leggero DI PROPOSITO: seleziona `source_definition` (~12KB, i configFields per
 * la UI) ma NON `source_executor`/`source_schema` (150KB+ ciascuno). Così il
 * pannello mostra i parametri senza scaricare il codice eseguibile. Read-only,
 * niente PII/segreti (la definizione è metadata UI), perciò esponibile a
 * QUALSIASI membro del workspace (la route NON è sotto il guard owner).
 */
export function listCustomNodeDefinitions(workspaceId: string): CustomNodeDefinitionEntry[] {
  const handle = getDatabase();
  const placeholders = CATALOG_RUNNABLE_STATUSES.map(() => '?').join(', ');
  const rows = handle.sqlite
    .prepare(
      `SELECT id, slug, display_name, description, icon_svg, semver, status, source_definition
       FROM custom_nodes
      WHERE workspace_id = ? AND status IN (${placeholders})
      ORDER BY updated_at DESC`,
    )
    .all(workspaceId, ...CATALOG_RUNNABLE_STATUSES) as {
    id: string;
    slug: string;
    display_name: string;
    description: string | null;
    icon_svg: string | null;
    semver: string;
    status: string;
    source_definition: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    description: r.description,
    iconSvg: r.icon_svg,
    semver: r.semver,
    status: r.status,
    sourceDefinition: r.source_definition,
  }));
}

/**
 * Update con snapshot version: bump semver (auto patch default) + save snapshot
 * + UPDATE custom_nodes.
 * Tutto in transazione atomica.
 */
export async function updateCustomNode(opts: {
  workspaceId: string;
  id: string;
  actorUserId: string;
  input: CustomNodeUpdateInput;
}): Promise<CustomNode> {
  const input = CustomNodeUpdateInputSchema.parse(opts.input);
  const current = await getCustomNode({ workspaceId: opts.workspaceId, id: opts.id });
  if (!current) throw new CustomNodeNotFoundError(opts.id);
  if (current.status === 'archived') {
    throw new CustomNodeValidationError('Cannot update archived custom node');
  }

  const handle = getDatabase();
  // Source touched? Solo allora bump version + snapshot.
  const sourceTouched =
    (input.sourceExecutor !== undefined && input.sourceExecutor !== current.sourceExecutor) ||
    (input.sourceDefinition !== undefined && input.sourceDefinition !== current.sourceDefinition) ||
    (input.sourceSchema !== undefined && input.sourceSchema !== current.sourceSchema);

  const newSemver = sourceTouched
    ? bumpSemver(current.semver, input.semverBump ?? 'patch')
    : current.semver;

  const at = nowIso();
  const newExecutor = input.sourceExecutor ?? current.sourceExecutor;
  const newDefinition = input.sourceDefinition ?? current.sourceDefinition;
  const newSchema = input.sourceSchema ?? current.sourceSchema;

  // Resolve final values server-side (no COALESCE — fragile con null literali)
  const newDisplayName = input.displayName ?? current.displayName;
  const newDescription = pickProvided(input.description, current.description);
  const newIconSvg = pickProvided(input.iconSvg, current.iconSvg);
  const newCategory = pickProvided(input.category, current.category);
  const newCompiledExecutor = sourceTouched ? null : current.compiledExecutor;
  const newCompileWarnings = sourceTouched
    ? null
    : current.compileWarnings.length > 0
      ? JSON.stringify(current.compileWarnings)
      : null;
  const newCompileAt = sourceTouched ? null : current.compileAt;

  const tx = handle.sqlite.transaction(() => {
    handle.sqlite
      .prepare(
        `UPDATE custom_nodes SET
        display_name = ?,
        description = ?,
        icon_svg = ?,
        category = ?,
        source_executor = ?,
        source_definition = ?,
        source_schema = ?,
        semver = ?,
        updated_at = ?,
        compiled_executor = ?,
        compile_warnings = ?,
        compile_at = ?
       WHERE id = ? AND workspace_id = ?`,
      )
      .run(
        newDisplayName,
        newDescription,
        newIconSvg,
        newCategory,
        newExecutor,
        newDefinition,
        newSchema,
        newSemver,
        at,
        newCompiledExecutor,
        newCompileWarnings,
        newCompileAt,
        opts.id,
        opts.workspaceId,
      );

    // Snapshot append-only solo se source toccato
    if (sourceTouched) {
      handle.sqlite
        .prepare(
          `INSERT INTO custom_node_versions (
          id, custom_node_id, semver, source_executor, source_definition, source_schema,
          changelog, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          opts.id,
          newSemver,
          newExecutor,
          newDefinition,
          newSchema,
          input.changelog ?? null,
          opts.actorUserId,
          at,
        );
    }
  });
  tx();

  const updated = (await getCustomNode({ workspaceId: opts.workspaceId, id: opts.id }))!;
  // Hot-reload: invalida la cache compiled del runtime per il defId.
  // Il prossimo run del workflow ricaricara\` dal DB. Emit event per UI SSE.
  invalidateCustomNode(opts.workspaceId, customNodeDefId(updated.slug));
  emitCustomNodeUpdate({
    workspaceId: opts.workspaceId,
    defId: customNodeDefId(updated.slug),
    semver: updated.semver,
    status: updated.status,
    kind: 'updated',
  });
  return updated;
}

/**
 * Lista versioni (snapshot history) per UI Diff Viewer + Rollback.
 */
export async function listVersions(opts: {
  workspaceId: string;
  customNodeId: string;
  limit?: number;
}): Promise<CustomNodeVersion[]> {
  const node = await getCustomNode({ workspaceId: opts.workspaceId, id: opts.customNodeId });
  if (!node) throw new CustomNodeNotFoundError(opts.customNodeId);
  const handle = getDatabase();
  const limit = opts.limit ?? 50;
  const rows = handle.sqlite
    .prepare(
      `SELECT * FROM custom_node_versions
      WHERE custom_node_id = ?
      ORDER BY created_at DESC
      LIMIT ?`,
    )
    .all(opts.customNodeId, limit) as RawVersionRow[];
  return rows.map(versionRowToDomain);
}

/**
 * Rollback alla versione `semverTarget`. Carica il snapshot + UPDATE sources
 * + bump patch (es. rollback da 1.2.5 a 1.0.0 → nuova semver 1.0.1 visibile
 * come current). La storia non viene riscritta.
 */
export async function rollbackToVersion(opts: {
  workspaceId: string;
  customNodeId: string;
  actorUserId: string;
  semverTarget: string;
}): Promise<CustomNode> {
  const node = await getCustomNode({ workspaceId: opts.workspaceId, id: opts.customNodeId });
  if (!node) throw new CustomNodeNotFoundError(opts.customNodeId);
  const handle = getDatabase();
  const targetRow = handle.sqlite
    .prepare(`SELECT * FROM custom_node_versions WHERE custom_node_id = ? AND semver = ? LIMIT 1`)
    .get(opts.customNodeId, opts.semverTarget) as RawVersionRow | undefined;
  const target = targetRow ? versionRowToDomain(targetRow) : undefined;
  if (!target) {
    throw new CustomNodeNotFoundError(`Version ${opts.semverTarget} of ${opts.customNodeId}`);
  }

  return await updateCustomNode({
    workspaceId: opts.workspaceId,
    id: opts.customNodeId,
    actorUserId: opts.actorUserId,
    input: {
      sourceExecutor: target.sourceExecutor,
      sourceDefinition: target.sourceDefinition,
      sourceSchema: target.sourceSchema,
      semverBump: 'patch',
      changelog: `Rollback to v${opts.semverTarget}`,
    },
  });
}

/**
 * Soft-delete (status = 'archived'). Preservato in DB per audit + restore.
 * Hard-delete fa DELETE CASCADE su custom_node_versions ma è chiamata separata
 * via routes admin (super_admin) — qui solo archive.
 */
export async function archiveCustomNode(opts: {
  workspaceId: string;
  id: string;
  actorUserId?: string;
}): Promise<void> {
  // Recupero slug PRIMA del cambio status per chiave invalidate
  const node = await getCustomNode(opts);
  if (!node) throw new CustomNodeNotFoundError(opts.id);
  const handle = getDatabase();
  const result = handle.sqlite
    .prepare(
      `UPDATE custom_nodes SET status = 'archived', updated_at = ?
      WHERE id = ? AND workspace_id = ? AND status != 'archived'`,
    )
    .run(nowIso(), opts.id, opts.workspaceId);
  if (result.changes === 0) {
    // gia\` archived → no-op idempotent
    return;
  }
  const defId = customNodeDefId(node.slug);
  invalidateCustomNode(opts.workspaceId, defId);
  emitCustomNodeUpdate({
    workspaceId: opts.workspaceId,
    defId,
    semver: node.semver,
    status: 'archived',
    kind: 'archived',
  });
  await auditAction({
    workspaceId: opts.workspaceId,
    actorUserId: opts.actorUserId ?? 'owner',
    action: 'custom_node.archive',
    customNodeId: opts.id,
    meta: { defId, semver: node.semver, slug: node.slug, previousStatus: node.status },
  });
}

/**
 * Persist compile result (compiled_executor + warnings) on the custom node row.
 * Chiamato da compile.service.ts post-compilation success.
 */
export async function persistCompileResult(opts: {
  workspaceId: string;
  id: string;
  compiledExecutor: string;
  warnings: CompileDiagnostic[];
}): Promise<void> {
  const handle = getDatabase();

  // Registry integrity: il nodo sta diventando runnable → calcola digest+firma
  // del pacchetto: sorgenti (slug+semver+executor+definition+schema) E il
  // compiledExecutor che sta per essere persistito — è il bundle che il sandbox
  // ESEGUE, lasciarlo fuori dalla firma lo renderebbe manomettibile senza
  // detection. Verificata al cold-load. Secret assente (dev/test) → NULL.
  const pre = await getCustomNode(opts);
  if (!pre) throw new CustomNodeNotFoundError(opts.id);
  const secret = registrySecret();
  const integrity = secret
    ? makePackageIntegrity(
        {
          slug: pre.slug,
          semver: pre.semver,
          sourceExecutor: pre.sourceExecutor,
          sourceDefinition: pre.sourceDefinition,
          sourceSchema: pre.sourceSchema,
          compiledExecutor: opts.compiledExecutor,
        },
        secret,
      )
    : null;

  const result = handle.sqlite
    .prepare(
      `UPDATE custom_nodes SET
       compiled_executor = ?,
       compile_warnings = ?,
       compile_at = ?,
       integrity_digest = ?,
       integrity_signature = ?,
       integrity_algo = ?,
       status = CASE WHEN status = 'draft' THEN 'candidate' ELSE status END,
       updated_at = ?
      WHERE id = ? AND workspace_id = ?`,
    )
    .run(
      opts.compiledExecutor,
      JSON.stringify(opts.warnings),
      nowIso(),
      integrity?.digest ?? null,
      integrity?.signature ?? null,
      integrity?.algo ?? null,
      nowIso(),
      opts.id,
      opts.workspaceId,
    );
  if (result.changes === 0) throw new CustomNodeNotFoundError(opts.id);
  // Cache invalidate: il nuovo compiledExecutor sostituisce quello in cache.
  // Pre-popoliamo l'entry per evitare cache-miss al primo run dopo compile.
  const node = await getCustomNode(opts);
  if (node && node.status !== 'archived') {
    const defId = customNodeDefId(node.slug);
    setCustomNodeCache({
      defId,
      workspaceId: opts.workspaceId,
      semver: node.semver,
      compiledExecutor: opts.compiledExecutor,
      sourceDefinition: node.sourceDefinition,
      sourceSchema: node.sourceSchema,
      status: node.status,
      cachedAt: Date.now(),
    });
    emitCustomNodeUpdate({
      workspaceId: opts.workspaceId,
      defId,
      semver: node.semver,
      status: node.status,
      kind: 'updated',
    });
  }
}

/**
 * Publish privato (status → 'published_priv'). Richiede che il nodo abbia
 * gia\` un compiledExecutor (= almeno una compile success); altrimenti throws.
 * Idempotente: re-publish lascia lo stato invariato. Emit event + populate
 * cache pre-emptivamente cosi\` il primo run e\` immediato.
 */
export async function publishCustomNodePrivate(opts: {
  workspaceId: string;
  id: string;
  actorUserId?: string;
}): Promise<CustomNode> {
  const node = await getCustomNode(opts);
  if (!node) throw new CustomNodeNotFoundError(opts.id);
  if (!node.compiledExecutor) {
    throw new Error('Compile required before publish (no compiledExecutor on node)');
  }
  if (node.status === 'archived') {
    throw new Error('Cannot publish archived node — restore first');
  }
  const handle = getDatabase();
  handle.sqlite
    .prepare(
      `UPDATE custom_nodes SET status = 'published_priv', updated_at = ?
      WHERE id = ? AND workspace_id = ?`,
    )
    .run(nowIso(), opts.id, opts.workspaceId);
  const published = (await getCustomNode(opts))!;
  const defId = customNodeDefId(published.slug);
  setCustomNodeCache({
    defId,
    workspaceId: opts.workspaceId,
    semver: published.semver,
    compiledExecutor: published.compiledExecutor ?? '',
    sourceDefinition: published.sourceDefinition,
    sourceSchema: published.sourceSchema,
    status: published.status,
    cachedAt: Date.now(),
  });
  emitCustomNodeUpdate({
    workspaceId: opts.workspaceId,
    defId,
    semver: published.semver,
    status: published.status,
    kind: 'published',
  });
  await auditAction({
    workspaceId: opts.workspaceId,
    actorUserId: opts.actorUserId ?? 'owner',
    action: 'custom_node.publish_private',
    customNodeId: opts.id,
    meta: { defId, semver: published.semver, slug: published.slug },
  });
  return published;
}

/**
 * Submit del nodo al marketplace globale (review queue platform).
 *
 * State transition: candidate | published_priv → marketplace_pending.
 * Gates obbligatori:
 *   - Plan tier deve permettere il marketplace publish
 *   - Nodo deve avere compiledExecutor (compile OK)
 *   - Zero security violations errori nel compileWarnings
 *
 * Note: il record di submission viene anche notificato al control plane
 * portal (HTTP outbound) per popolare la review queue admin. Questo step
 * e\` opzionale e fail-silent: il nodo cambia status anche se il portal
 * non risponde (la queue puo\` essere riconciliata via cron pull).
 */
export async function submitCustomNodeToMarketplace(opts: {
  workspaceId: string;
  id: string;
  actorUserId?: string;
}): Promise<CustomNode> {
  const node = await getCustomNode(opts);
  if (!node) throw new CustomNodeNotFoundError(opts.id);
  if (node.status === 'archived') {
    throw new Error('Cannot submit archived node — restore first');
  }
  if (node.status === 'marketplace_pending') {
    throw new Error('Node already pending marketplace review');
  }
  if (node.status === 'marketplace_published') {
    throw new Error('Node already published in marketplace');
  }
  if (!node.compiledExecutor) {
    throw new Error('Compile required before marketplace submission');
  }
  // Plan gate
  const { resolveTenantPlan, PLAN_CAPABILITIES } = await import('./plan-gating.js');
  const plan = resolveTenantPlan();
  if (!PLAN_CAPABILITIES[plan].canPublishMarketplace) {
    throw new Error(`Plan "${plan}" non abilitato per il marketplace. Upgrade a Pro o superiore.`);
  }
  // Zero security errors
  const secErrors = (node.compileWarnings ?? []).filter((d) => d.severity === 'error');
  if (secErrors.length > 0) {
    throw new Error(`Nodo ha ${String(secErrors.length)} errori di sicurezza — non submittabile`);
  }

  const handle = getDatabase();
  handle.sqlite
    .prepare(
      `UPDATE custom_nodes SET status = 'marketplace_pending', updated_at = ?
      WHERE id = ? AND workspace_id = ?`,
    )
    .run(nowIso(), opts.id, opts.workspaceId);
  const updated = (await getCustomNode(opts))!;
  await auditAction({
    workspaceId: opts.workspaceId,
    actorUserId: opts.actorUserId ?? 'owner',
    action: 'custom_node.submit_marketplace',
    customNodeId: opts.id,
    meta: { defId: customNodeDefId(updated.slug), semver: updated.semver, slug: updated.slug },
  });
  return updated;
}

/**
 * Withdraw da marketplace_pending → torna allo stato precedente
 * (candidate o published_priv a seconda dell'history audit).
 */
export async function withdrawCustomNodeFromMarketplace(opts: {
  workspaceId: string;
  id: string;
  actorUserId?: string;
}): Promise<CustomNode> {
  const node = await getCustomNode(opts);
  if (!node) throw new CustomNodeNotFoundError(opts.id);
  if (node.status !== 'marketplace_pending') {
    throw new Error(`Cannot withdraw — status e\` "${node.status}", non "marketplace_pending"`);
  }
  // Torna a candidate (l'utente potra\` riproomuoverlo a published_priv via Publish Wizard)
  const handle = getDatabase();
  handle.sqlite
    .prepare(
      `UPDATE custom_nodes SET status = 'candidate', updated_at = ?
      WHERE id = ? AND workspace_id = ?`,
    )
    .run(nowIso(), opts.id, opts.workspaceId);
  const updated = (await getCustomNode(opts))!;
  await auditAction({
    workspaceId: opts.workspaceId,
    actorUserId: opts.actorUserId ?? 'owner',
    action: 'custom_node.withdraw_marketplace',
    customNodeId: opts.id,
    meta: { defId: customNodeDefId(updated.slug), semver: updated.semver },
  });
  return updated;
}

/**
 * Unpublish (status → 'draft'). I workflow in esecuzione che usano il defId
 * vedranno il nodo come "non disponibile" al prossimo run.
 */
export async function unpublishCustomNode(opts: {
  workspaceId: string;
  id: string;
  actorUserId?: string;
}): Promise<CustomNode> {
  const node = await getCustomNode(opts);
  if (!node) throw new CustomNodeNotFoundError(opts.id);
  const handle = getDatabase();
  handle.sqlite
    .prepare(
      `UPDATE custom_nodes SET status = 'draft', updated_at = ?
      WHERE id = ? AND workspace_id = ?`,
    )
    .run(nowIso(), opts.id, opts.workspaceId);
  const updated = (await getCustomNode(opts))!;
  const defId = customNodeDefId(updated.slug);
  invalidateCustomNode(opts.workspaceId, defId);
  emitCustomNodeUpdate({
    workspaceId: opts.workspaceId,
    defId,
    semver: updated.semver,
    status: updated.status,
    kind: 'unpublished',
  });
  await auditAction({
    workspaceId: opts.workspaceId,
    actorUserId: opts.actorUserId ?? 'owner',
    action: 'custom_node.unpublish',
    customNodeId: opts.id,
    meta: { defId, semver: updated.semver, slug: updated.slug, previousStatus: node.status },
  });
  return updated;
}

/**
 * Append un test run alla ring buffer (max TEST_RUNS_RING_SIZE).
 * Append-only logica simulata via JSON.parse + slice + JSON.stringify.
 */
export async function appendTestRun(opts: {
  workspaceId: string;
  id: string;
  record: TestRunRecord;
}): Promise<void> {
  const node = await getCustomNode(opts);
  if (!node) throw new CustomNodeNotFoundError(opts.id);
  const next = [opts.record, ...node.testRuns].slice(0, TEST_RUNS_RING_SIZE);
  const handle = getDatabase();
  handle.sqlite
    .prepare(
      `UPDATE custom_nodes SET test_runs = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
    )
    .run(JSON.stringify(next), nowIso(), opts.id, opts.workspaceId);
}

/**
 * Ritorna il ring buffer dei test run (newest-first, max TEST_RUNS_RING_SIZE).
 * FIX A3: prima il buffer veniva SCRITTO (appendTestRun) ma mai esposto.
 */
export async function listTestRuns(opts: {
  workspaceId: string;
  id: string;
}): Promise<TestRunRecord[]> {
  const node = await getCustomNode(opts);
  if (!node) throw new CustomNodeNotFoundError(opts.id);
  return node.testRuns;
}

// Suppress unused imports — they're re-exportable from drizzle namespace for future query needs.
void customNodes;
void customNodeVersions;
void eq;
void and;
void desc;
void ne;
