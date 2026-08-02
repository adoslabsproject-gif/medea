import { nanoid } from 'nanoid';
import { eq, and, desc } from 'drizzle-orm';
import { WorkflowSchema, type Workflow } from '@medea/engine-core-schema';
import { getDatabase } from '@/storage/db.js';
import { workflows, type WorkflowRow, type NewWorkflowRow } from '@/storage/schema.js';
import { AuditLogService } from './audit.service.js';
import { tenantService } from './tenant.service.js';
import { dedupedWarn, errorFingerprint, logger } from '@/lib/logger.js';
import { dedicatedTablesToDrop } from '@/services/workflow-db-tables.js';
import { counterInc } from '@/lib/metrics-store.js';
import { safeParseJson } from '@/lib/safe-parse-json.js';
import {
  normalizeNodesWebhookLinks,
  defaultSameHosts,
  type WebhookOwnerLookup,
  type WebhookLinkTarget,
} from '@/lib/webhook-link-normalizer.js';
import type { IEventBus } from '@/ports/event-bus.js';

const audit = new AuditLogService();

/**
 * Errore di VALIDAZIONE workflow (input cliente invalido) → 400, NON 500.
 * `httpStatus`/`expose` letti dall'app.onError per restituire lo status corretto
 * + il messaggio (safe: descrive il problema strutturale, niente leak schema/SQL).
 * Pre-fix: un workflow con edge orfani dava 500 "Errore interno" — fuorviante
 * (è colpa dell'input, non del server). Ora 400 con il dettaglio.
 */
export class WorkflowValidationError extends Error {
  readonly httpStatus = 400;
  readonly expose = true;
  readonly code = 'WORKFLOW_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowValidationError';
  }
}

/**
 * Security: assicura che ogni nodo trigger_form abbia un publicToken non
 * vuoto. Il token protegge l'URL pubblico del form (/forms/<wfId>/<token>)
 * contro enumeration: senza, chiunque conosca il workflowId potrebbe
 * triggerare il workflow inventando un token qualsiasi.
 *
 * Idempotente: rispetta i token esistenti (i link già condivisi continuano
 * a funzionare), genera solo per i nodi che NON hanno publicToken (nuovi o
 * legacy). Token = nanoid 32 char (~190 bit di entropia, non guessable).
 */
function ensureFormTriggerTokens(nodes: unknown[]): unknown[] {
  return nodes.map((n) => {
    if (!n || typeof n !== 'object') return n;
    const node = n as { defId?: string; config?: Record<string, unknown> };
    if (node.defId !== 'trigger_form') return n;
    const config = node.config ?? {};
    const existingToken = typeof config.publicToken === 'string' ? config.publicToken : '';
    if (existingToken && existingToken.length >= 16) return n;
    return { ...node, config: { ...config, publicToken: nanoid(32) } };
  });
}

/**
 * Estrae il "proprietario webhook" da un workflow per il normalizzatore dei
 * link cablati (lib/webhook-link-normalizer.ts): id + authMode del trigger,
 * defaultato a `none` con la STESSA regola di authorize() in routes/webhooks.ts.
 */
function webhookTargetFromWorkflow(wf: Workflow | null): WebhookLinkTarget | null {
  if (!wf) return null;
  const trigger = wf.nodes.find((n) => n.defId === 'trigger_webhook');
  if (!trigger) return null;
  const authMode =
    typeof trigger.config.authMode === 'string' && trigger.config.authMode !== ''
      ? trigger.config.authMode
      : 'none';
  return { id: wf.id, authMode };
}

/**
 * Lookup del proprietario di un link webhook per il normalizzatore —
 * condiviso tra il path di salvataggio (create/update) e la migrazione al
 * boot. byCustomPath: exact match e SOLO se univoco (0 o >1 → null, mai
 * indovinare).
 */
export function makeWebhookOwnerLookup(service: WorkflowService): WebhookOwnerLookup {
  return {
    byId: async (workflowId: string) =>
      webhookTargetFromWorkflow(await service.getByIdAnyTenant(workflowId)),
    byCustomPath: async (customPath: string) => {
      const matches = await service.listByCustomWebhookPathAnyTenant(customPath);
      return matches.length === 1 ? webhookTargetFromWorkflow(matches[0]!) : null;
    },
  };
}

/**
 * Throwing parser — usato dagli endpoint GET /:id e dai writer (create/update)
 * dove un workflow corrotto DEVE bubblare l'errore al client che ha visibilità
 * sul singolo item. Pattern "fail closed su write/single-read".
 */
function rowToWorkflow(row: WorkflowRow): Workflow {
  return WorkflowSchema.parse(rowToCandidatePayload(row));
}

/**
 * Resilient parser — usato dagli endpoint GET list dove un workflow corrotto
 * NON deve rompere la lista intera. Ritorna null + log dedup-ed warn +
 * counter Prometheus per visibility ops. Pattern "fail open su list-read".
 *
 * Federico-grade reasoning: se 1 workflow ha schema drift (es. dopo
 * migrazione versione, manual SQL fix, AI scaffold imperfetto), gli altri
 * 99 workflow del tenant DEVONO continuare a essere visibili. Crashare
 * tutta la lista è UX disaster + crea un nemico anti-debug ("perché non
 * vedo NIENTE?").
 */
function safeRowToWorkflow(row: WorkflowRow): Workflow | null {
  const parsed = WorkflowSchema.safeParse(rowToCandidatePayload(row));
  if (parsed.success) return parsed.data;
  // Dedup log: stesso (workflowId, errorFingerprint) emette 1 log/60s
  // invece di N log a ogni list refresh (poll 10s = 360 log/h altrimenti).
  dedupedWarn(
    errorFingerprint(parsed.error, `wf-schema-drift:${row.id}`),
    {
      workflowId: row.id,
      tenantId: row.tenantId ?? 'default',
      workflowName: row.name,
      issueCount: parsed.error.issues.length,
      firstIssues: parsed.error.issues.slice(0, 3).map((i) => ({
        path: i.path.join('.'),
        code: i.code,
        message: i.message,
      })),
    },
    'Workflow schema drift — skipped from list (visibile in /admin/workflows/health)',
  );
  // Counter Prometheus per dashboard ops "quanti workflow corrotti per tenant?"
  counterInc({
    name: 'flowforge_workflow_schema_invalid_total',
    help: 'Workflow rows che falliscono WorkflowSchema.parse() durante list() — skip silenzioso, visibile in /admin/workflows/health',
    tags: { tenant: row.tenantId ?? 'default' },
  });
  return null;
}

function rowToCandidatePayload(row: WorkflowRow): unknown {
  return {
    schemaVersion: row.schemaVersion,
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    enabled: row.enabled,
    // safeParseJson guard contro DB corruption / migration old shape — invece
    // di throw (500) ritorniamo null/origine cosi\` lo Zod schema downstream
    // ritorna 422 validation error con field path leggibile.
    nodes: safeParseJson(row.nodesJson),
    edges: safeParseJson(row.edgesJson),
    nodeDefs: safeParseJson(row.nodeDefsJson),
    breakpoints: row.breakpointsJson ? safeParseJson(row.breakpointsJson) : undefined,
    tags: row.tagsJson ? safeParseJson(row.tagsJson) : undefined,
    folderId: row.folderId ?? undefined,
    onError: row.onErrorJson ? safeParseJson(row.onErrorJson) : undefined,
    concurrencyLimit: row.concurrencyLimit ?? undefined,
    ephemeralRuns: row.ephemeralRuns === true ? true : undefined,
    runVerbosity:
      row.runVerbosity === 'silent' || row.runVerbosity === 'summary' || row.runVerbosity === 'full'
        ? row.runVerbosity
        : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy ?? undefined,
    ownerId: row.ownerId ?? undefined,
    tenantId: row.tenantId ?? undefined,
  };
}

/**
 * Public health-check helper — usato dall'endpoint /admin/workflows/health
 * per esporre quali workflow per quale tenant hanno schema drift, in modo
 * che superadmin/owner possano correggere via DB Studio o re-import.
 */
export function diagnoseWorkflowRow(row: WorkflowRow): {
  ok: boolean;
  issues?: { path: string; code: string; message: string }[];
} {
  const parsed = WorkflowSchema.safeParse(rowToCandidatePayload(row));
  if (parsed.success) return { ok: true };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => ({
      path: i.path.join('.'),
      code: i.code,
      message: i.message,
    })),
  };
}

export interface CreateWorkflowInput {
  name: string;
  description?: string;
  enabled?: boolean;
  nodes?: unknown[];
  edges?: unknown[];
  nodeDefs?: unknown[];
  tags?: string[];
  folderId?: string | null;
  onError?: { webhookUrl?: string | undefined; emailTo?: string | undefined };
  /** E4 (2026-06-06): workflow fan-out triggerato su run.status='error'. */
  errorWorkflowId?: string | null;
  concurrencyLimit?: number;
  /** @deprecated 2026-06-07 sera — usa runVerbosity. */
  ephemeralRuns?: boolean;
  /** 2026-06-07 sera (tier-aware logging): 'silent' | 'summary' | 'full'. */
  runVerbosity?: 'silent' | 'summary' | 'full';
  tenantId?: string;
  createdBy?: string;
}

export interface UpdateWorkflowInput {
  name?: string;
  description?: string;
  enabled?: boolean;
  nodes?: unknown[];
  edges?: unknown[];
  nodeDefs?: unknown[];
  breakpoints?: unknown[];
  tags?: string[];
  folderId?: string | null;
  onError?: { webhookUrl?: string | undefined; emailTo?: string | undefined } | null;
  /** E4 (2026-06-06): null per rimuovere il binding, string per settarlo. */
  errorWorkflowId?: string | null;
  concurrencyLimit?: number | null;
  /** @deprecated 2026-06-07 sera — usa runVerbosity. */
  ephemeralRuns?: boolean;
  /** 2026-06-07 sera (tier-aware logging): tri-state per WorkflowMetaModal. */
  runVerbosity?: 'silent' | 'summary' | 'full' | null;
  actorId?: string;
}

export class WorkflowService {
  constructor(private readonly eventBus: IEventBus) {}

  async list(tenantId = 'default'): Promise<Workflow[]> {
    const { db } = getDatabase();
    const rows = await db
      .select()
      .from(workflows)
      .where(eq(workflows.tenantId, tenantId))
      .orderBy(desc(workflows.updatedAt));
    // Resilient: skip workflow corrotti + log dedup-ed warn invece di throw
    // a metà map. 1 record bad NON deve rompere la lista degli altri 99.
    const out: Workflow[] = [];
    for (const row of rows) {
      const wf = safeRowToWorkflow(row);
      if (wf) out.push(wf);
    }
    return out;
  }

  /**
   * Raw rows — usato dall'endpoint admin /workflows/health per diagnostica
   * di tutti i workflow del tenant, INCLUSI quelli corrotti (con .ok=false
   * + lista issues). NON usato dalla UI normale.
   */
  async listRowsForHealth(tenantId = 'default'): Promise<WorkflowRow[]> {
    const { db } = getDatabase();
    return db
      .select()
      .from(workflows)
      .where(eq(workflows.tenantId, tenantId))
      .orderBy(desc(workflows.updatedAt));
  }

  /**
   * AUDIT FIX WE-9 (2026-06-09 HIGH): lista SOLO workflow esposti a MCP.
   *
   * Pre-fix MCP /tools/list ritornava TUTTI i workflow enabled del tenant
   * a qualsiasi user autenticato → ACL bypass (un editor poteva chiamare
   * workflow admin "destroy all customers").
   *
   * Post-fix: filtra per mcp_exposed=1 (default 0 → opt-in esplicito da
   * editor). Ritorna shape minimale `{id, name, description, enabled}` —
   * MCP non ha bisogno del workflow.nodes (e tutto il resto del schema
   * Zod), solo del name e descrizione per il tool registry.
   */
  listMcpExposed(
    tenantId = 'default',
  ): Promise<{ id: string; name: string; description: string | null }[]> {
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare(
        `
      SELECT id, name, description FROM workflows
      WHERE tenant_id = ? AND enabled = 1 AND mcp_exposed = 1
      ORDER BY updated_at DESC
    `,
      )
      .all(tenantId) as { id: string; name: string; description: string | null }[];
    return Promise.resolve(rows);
  }

  /**
   * Verifica che un workflow specifico sia esposto a MCP per il tenant.
   * Usato da /tools/call prima dell'invocazione.
   */
  isMcpExposed(workflowId: string, tenantId = 'default'): Promise<boolean> {
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare(
        `
      SELECT 1 FROM workflows
      WHERE id = ? AND tenant_id = ? AND enabled = 1 AND mcp_exposed = 1
    `,
      )
      .get(workflowId, tenantId);
    return Promise.resolve(row !== undefined);
  }

  async get(id: string, tenantId = 'default'): Promise<Workflow | null> {
    const { db } = getDatabase();
    const [row] = await db
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, id), eq(workflows.tenantId, tenantId)))
      .limit(1);
    return row ? rowToWorkflow(row) : null;
  }

  /**
   * E4 (2026-06-06): minimal column lookup per il fan-out error workflow
   * dal run.service. Evita di parseare il WorkflowSchema completo per ottenere
   * un singolo metadata field. Ritorna null se workflow assente o errorWorkflowId
   * non set. Tenant-scoped — no leak cross-tenant del fan-out.
   */
  async getErrorWorkflowId(workflowId: string, tenantId = 'default'): Promise<string | null> {
    const { db } = getDatabase();
    const [row] = await db
      .select({ errorWorkflowId: workflows.errorWorkflowId })
      .from(workflows)
      .where(and(eq(workflows.id, workflowId), eq(workflows.tenantId, tenantId)))
      .limit(1);
    return row?.errorWorkflowId ?? null;
  }

  /**
   * Look up a workflow WITHOUT tenant scoping. Used ONLY by public-facing
   * endpoints (webhooks, forms, signed URLs) where the caller has no JWT
   * but the workflowId+token pair is enough to authenticate. The returned
   * workflow exposes `tenantId` — pass it forward as the audit-attached
   * tenant. Never use this from a logged-in route: use get(id, tenantId).
   */
  async getByIdAnyTenant(id: string): Promise<Workflow | null> {
    const { db } = getDatabase();
    const [row] = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
    return row ? rowToWorkflow(row) : null;
  }

  /**
   * Cross-tenant variant of listByCustomWebhookPath — for the public
   * /webhooks/c/<customPath>/<token> route. Returns matches across ALL
   * tenants since the caller has no JWT to scope by.
   */
  /**
   * List EVERY workflow across ALL tenants. Used exclusively by long-running
   * background services that must operate cross-tenant (TriggerWatchers,
   * SchedulerService) — these services receive the tenantId from the
   * workflow row itself, not from a request header.
   *
   * NOT a tenant-isolation hole: this method is internal-only and never
   * exposed via HTTP. Routes still use `list(tenantId)` which respects
   * the per-tenant scope.
   */
  /**
   * Count workflow `enabled = 1` per il container corrente. Usato dal portal
   * lifecycle sweeper (probe HTTP `/api/v1/internal/workflows-enabled-count`)
   * per skip-pause quando il workspace ha workflow attivi: l'utente non
   * deve vedere 404 al ritorno sulla tab solo perche\` il container era
   * andato in sleep mentre era idle.
   *
   * Container-mode: 1 solo tenant → count semplice senza tenant filter.
   */
  async countEnabled(): Promise<number> {
    const { db } = getDatabase();
    const rows = await db.select().from(workflows);
    let count = 0;
    for (const row of rows) {
      const wf = safeRowToWorkflow(row);
      if (wf?.enabled) count++;
    }
    return count;
  }

  async listAllAcrossTenants(): Promise<Workflow[]> {
    const { db } = getDatabase();
    const rows = await db.select().from(workflows);
    // Resilient: skip workflow corrotti. Background services (Trigger
    // Watchers, Scheduler) NON devono crashare per 1 schema drift su
    // 10k workflow — pattern "best-effort cross-tenant scan".
    const out: Workflow[] = [];
    for (const row of rows) {
      const wf = safeRowToWorkflow(row);
      if (wf) out.push(wf);
    }
    return out;
  }

  async listByCustomWebhookPathAnyTenant(customPath: string): Promise<Workflow[]> {
    if (!customPath) return [];
    const { db } = getDatabase();
    const rows = await db.select().from(workflows);
    const matches: Workflow[] = [];
    for (const row of rows) {
      const wf = safeRowToWorkflow(row);
      if (!wf?.enabled) continue;
      for (const node of wf.nodes) {
        if (node.defId !== 'trigger_webhook') continue;
        const cp = typeof node.config.customPath === 'string' ? node.config.customPath : '';
        if (cp === customPath) {
          matches.push(wf);
          break;
        }
      }
    }
    return matches;
  }

  /**
   * List workflows that contain a trigger_webhook node with the given
   * customPath config. Used by the webhook router to resolve the
   * `/webhooks/c/<customPath>/:token` route shape.
   *
   * Scans only enabled workflows in the tenant — disabled ones never serve
   * traffic. Substring-free comparison on the customPath field (exact match)
   * to avoid path-confusion (e.g., "orders" should NOT match "orders/v2").
   */
  async listByCustomWebhookPath(tenantId: string, customPath: string): Promise<Workflow[]> {
    if (!customPath) return [];
    const all = await this.list(tenantId);
    const matches: Workflow[] = [];
    for (const wf of all) {
      if (!wf.enabled) continue;
      for (const node of wf.nodes) {
        if (node.defId !== 'trigger_webhook') continue;
        const cp = typeof node.config.customPath === 'string' ? node.config.customPath : '';
        if (cp === customPath) {
          matches.push(wf);
          break;
        }
      }
    }
    return matches;
  }

  /**
   * GUARDIA del contract indirection (post-mortem Streammy): i link webhook
   * cablati col token dentro vengono convertiti in `ref://` PRIMA di toccare
   * il disco — il token derivato non è mai persistito e la rotazione del
   * secret non rompe più nulla. Conversioni e skip sono sempre loggati.
   */
  private async normalizeWebhookLinks(nodes: unknown[]): Promise<unknown[]> {
    const {
      nodes: out,
      converted,
      skipped,
    } = await normalizeNodesWebhookLinks(nodes, makeWebhookOwnerLookup(this), {
      sameHosts: defaultSameHosts(),
    });
    if (converted > 0) {
      logger.info(
        { converted, skipped },
        'Link webhook cablati convertiti in ref:// al salvataggio (indirection)',
      );
    } else if (skipped.length > 0) {
      logger.warn(
        { skipped },
        "Link webhook cablati trovati ma NON convertibili al salvataggio — restano com'erano",
      );
    }
    return out;
  }

  async create(input: CreateWorkflowInput): Promise<Workflow> {
    const { db } = getDatabase();
    const now = new Date().toISOString();
    const id = nanoid();
    const tenantId = input.tenantId ?? 'default';

    // ── Quota enforcement single-source-of-truth (2026-06-06) ─────────
    // Vedi commento esteso nel metodo `update()`. La quota scatta SOLO
    // quando si crea direttamente un workflow ENABLED (workflow disabled
    // non consumano slot).
    if (input.enabled === true) {
      tenantService.checkQuota(tenantId, 'workflows');
    }

    // Security: auto-genera publicToken per trigger_form senza token
    // configurato. Senza questo, l'URL /forms/<wfId>/<token> sarebbe
    // accessibile a chiunque conosca il workflowId (vedi forms.ts auth).
    // Poi: CONTRACT indirection — un workflow salvato non contiene MAI un
    // token webhook cablato (convertito in ref://, vedi normalizzatore).
    const normalizedNodes = await this.normalizeWebhookLinks(
      ensureFormTriggerTokens(input.nodes ?? []),
    );

    const insertValues: NewWorkflowRow = {
      id,
      tenantId,
      name: input.name,
      enabled: input.enabled ?? false,
      schemaVersion: '1.0.0',
      nodesJson: JSON.stringify(normalizedNodes),
      edgesJson: JSON.stringify(input.edges ?? []),
      nodeDefsJson: JSON.stringify(input.nodeDefs ?? []),
      createdAt: now,
      updatedAt: now,
    };
    if (input.description !== undefined) insertValues.description = input.description;
    if (input.tags !== undefined) insertValues.tagsJson = JSON.stringify(input.tags);
    if (input.folderId !== undefined && input.folderId !== null)
      insertValues.folderId = input.folderId;
    if (input.onError !== undefined) insertValues.onErrorJson = JSON.stringify(input.onError);
    if (input.errorWorkflowId !== undefined) insertValues.errorWorkflowId = input.errorWorkflowId;
    if (input.concurrencyLimit !== undefined)
      insertValues.concurrencyLimit = input.concurrencyLimit;
    if (input.ephemeralRuns !== undefined) insertValues.ephemeralRuns = input.ephemeralRuns;
    if (input.runVerbosity !== undefined) {
      // F2 tier gating: Free tenant non può abilitare persistenza runs.
      // Forziamo a 'silent' indipendentemente da quello che il client invia.
      const { canPersistRunTrace: canPersist } =
        await import('@/services/storage-quota.service.js');
      const { loadConfig } = await import('@/config.js');
      insertValues.runVerbosity = canPersist(loadConfig().MEDEA_PLAN_CODE)
        ? input.runVerbosity
        : 'silent';
    }
    if (input.createdBy !== undefined) insertValues.createdBy = input.createdBy;

    await db.insert(workflows).values(insertValues);

    const created = await this.get(id, tenantId);
    if (!created) throw new Error(`Workflow ${id} not found after insert`);

    await audit.append({
      tenantId,
      action: 'workflow.create',
      resourceType: 'workflow',
      resourceId: id,
      ...(input.createdBy !== undefined ? { actorId: input.createdBy } : {}),
      metadata: { name: input.name },
    });

    this.eventBus.emit({
      name: 'workflow.created',
      tenantId,
      data: { id, name: input.name },
      ts: now,
    });

    return created;
  }

  async update(
    id: string,
    input: UpdateWorkflowInput,
    tenantId = 'default',
  ): Promise<Workflow | null> {
    const { db } = getDatabase();
    const existing = await this.get(id, tenantId);
    if (!existing) return null;

    // Pre-save validator: refuse workflows where edges reference non-existent
    // nodes. Without this, renaming a node leaves orphan edges and the engine
    // silently skips the sub-graph downstream, producing a "5 out of 11 steps
    // ran, status=success" lie. Computed against the FINAL state (incoming
    // nodes + edges if provided, otherwise existing values).
    const finalNodes = Array.isArray(input.nodes) ? input.nodes : existing.nodes;
    const finalEdges = Array.isArray(input.edges) ? input.edges : existing.edges;
    const nodeIds = new Set(
      (finalNodes as { id?: string }[])
        .map((n) => n.id)
        .filter((s): s is string => typeof s === 'string'),
    );
    const orphanEdges: string[] = [];
    for (const e of finalEdges as { from?: string; to?: string }[]) {
      if (e.from && !nodeIds.has(e.from))
        orphanEdges.push(`edge.from="${e.from}" (nodo inesistente)`);
      if (e.to && !nodeIds.has(e.to)) orphanEdges.push(`edge.to="${e.to}" (nodo inesistente)`);
    }
    if (orphanEdges.length > 0) {
      throw new WorkflowValidationError(
        `Workflow non valido: ${orphanEdges.length} edge orfani — ${orphanEdges.slice(0, 3).join('; ')}${orphanEdges.length > 3 ? ` … (+${orphanEdges.length - 3} altri)` : ''}`,
      );
    }

    const now = new Date().toISOString();
    const patch: Partial<NewWorkflowRow> = { updatedAt: now };
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    // CONTRACT indirection: come in create(), mai un token webhook cablato su disco.
    if (input.nodes !== undefined)
      patch.nodesJson = JSON.stringify(
        await this.normalizeWebhookLinks(ensureFormTriggerTokens(input.nodes)),
      );
    if (input.edges !== undefined) patch.edgesJson = JSON.stringify(input.edges);
    if (input.nodeDefs !== undefined) patch.nodeDefsJson = JSON.stringify(input.nodeDefs);
    if (input.breakpoints !== undefined) patch.breakpointsJson = JSON.stringify(input.breakpoints);
    if (input.tags !== undefined) patch.tagsJson = JSON.stringify(input.tags);
    if (input.folderId !== undefined) patch.folderId = input.folderId;
    if (input.onError !== undefined)
      patch.onErrorJson = input.onError === null ? null : JSON.stringify(input.onError);
    if (input.errorWorkflowId !== undefined) patch.errorWorkflowId = input.errorWorkflowId;
    if (input.concurrencyLimit !== undefined) patch.concurrencyLimit = input.concurrencyLimit;
    if (input.ephemeralRuns !== undefined) patch.ephemeralRuns = input.ephemeralRuns;
    if (input.runVerbosity !== undefined) {
      // F2 tier gating: Free non può uscire da silent.
      const { canPersistRunTrace: canPersist } =
        await import('@/services/storage-quota.service.js');
      const { loadConfig } = await import('@/config.js');
      const requested = input.runVerbosity;
      patch.runVerbosity = canPersist(loadConfig().MEDEA_PLAN_CODE) ? requested : 'silent';
    }

    // ── Quota enforcement single-source-of-truth (2026-06-06) ─────────
    // Lo SPOSTAMENTO del check da route HTTP a service garantisce che
    // ogni caller (HTTP /workflows, internal scripts admin-cli, e2e fixtures,
    // import bundle quando enable=true, ecc.) rispetti il cap del piano.
    // Prima: il check viveva SOLO in routes/workflows.ts → bypass triviale
    // via direct service.update() call. Caso reale: tenant FREE con 8
    // workflow attivi su limit=3 perché un import bulk + enable batch
    // ha bypassato il check.
    //
    // Politica: la quota scatta SOLO sulla transizione `disabled → enabled`.
    // Disable di workflow esistenti, modifiche a workflow già-enabled, e
    // creazione di workflow disabled NON consumano lo slot.
    if (input.enabled === true && existing.enabled === false) {
      tenantService.checkQuota(tenantId, 'workflows');
    }

    // MANUAL SAVE: il draft autosaved viene "promosso" → quindi lo
    // azzeriamo qui (l'utente ora vede la versione definitiva). Se non
    // c'era draft pendente, il NULL è no-op.
    patch.draftJson = null;
    patch.draftUpdatedAt = null;

    await db
      .update(workflows)
      .set(patch)
      .where(and(eq(workflows.id, id), eq(workflows.tenantId, tenantId)));

    const updated = await this.get(id, tenantId);

    await audit.append({
      tenantId,
      action: 'workflow.update',
      resourceType: 'workflow',
      resourceId: id,
      ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
      metadata: { fields: Object.keys(patch) },
    });

    this.eventBus.emit({
      name: 'workflow.updated',
      tenantId,
      data: { id, fields: Object.keys(patch) },
      ts: now,
    });

    return updated;
  }

  /**
   * AUTOSAVE — scrive uno snapshot completo del workflow nel campo
   * `draft_json` SENZA toccare la versione "ufficiale" usata dall'engine
   * (`nodes_json`/`edges_json`/...). L'utente continua a sperimentare
   * in editor; se chiude il browser senza salvare, alla riapertura
   * l'editor mostra il draft (banner: "salvato in automatico, non
   * definitivo"). Se l'utente clicca SALVA, `update()` promuove il
   * draft. Se clicca SCARTA, `discardDraft()` lo butta via.
   *
   * Validation: nessuna (è un autosave, può contenere stati intermedi).
   * Storage: 1 row update — atomic, no race con `update()`.
   */
  async saveDraft(
    id: string,
    payload: unknown,
    tenantId = 'default',
  ): Promise<{ savedAt: string } | null> {
    const { db } = getDatabase();
    const existing = await this.get(id, tenantId);
    if (!existing) return null;

    const now = new Date().toISOString();
    await db
      .update(workflows)
      .set({
        draftJson: JSON.stringify(payload),
        draftUpdatedAt: now,
      })
      .where(and(eq(workflows.id, id), eq(workflows.tenantId, tenantId)));

    // Niente audit log (gli autosave sono fitti e non producono informazione
    // d'interesse). Niente event bus (engine non guarda draft).
    return { savedAt: now };
  }

  /**
   * DISCARD — azzera il draft pendente. L'editor ricarica il workflow
   * (GET /:id) → vede solo la versione "ufficiale".
   */
  async discardDraft(id: string, tenantId = 'default'): Promise<boolean> {
    const { db } = getDatabase();
    const existing = await this.get(id, tenantId);
    if (!existing) return false;

    await db
      .update(workflows)
      .set({ draftJson: null, draftUpdatedAt: null })
      .where(and(eq(workflows.id, id), eq(workflows.tenantId, tenantId)));

    return true;
  }

  /**
   * Returns the autosaved draft (if any) as a parsed object, along with
   * its `savedAt` timestamp. Used by GET /:id to return draft alongside
   * the committed workflow definition. NEVER used by the engine.
   */
  async getDraft(
    id: string,
    tenantId = 'default',
  ): Promise<{ payload: unknown; savedAt: string } | null> {
    const { db } = getDatabase();
    const [row] = await db
      .select({ draftJson: workflows.draftJson, draftUpdatedAt: workflows.draftUpdatedAt })
      .from(workflows)
      .where(and(eq(workflows.id, id), eq(workflows.tenantId, tenantId)))
      .limit(1);
    if (!row?.draftJson || !row.draftUpdatedAt) return null;
    const payload = safeParseJson(row.draftJson);
    // safeParseJson ritorna la stringa originale se malformed; per draft
    // accettiamo solo object (Workflow payload) — string = malformed → null.
    if (payload === null || typeof payload !== 'object') return null;
    return { payload, savedAt: row.draftUpdatedAt };
  }

  async delete(
    id: string,
    tenantId = 'default',
    actorId?: string,
    opts: { dropTables?: boolean } = {},
  ): Promise<boolean> {
    const { db } = getDatabase();
    const existing = await this.get(id, tenantId);
    if (!existing) return false;

    // Cascade DEDICATA opt-in (anti-dataloss): droppa SOLO le tabelle che questo
    // workflow SCRIVE e che NESSUN altro workflow del tenant usa. Best-effort: un
    // drop fallito NON blocca la delete del workflow.
    const droppedTables: string[] = [];
    if (opts.dropTables) {
      try {
        const others = (await this.list(tenantId)).filter((w) => w.id !== id).map((w) => w.nodes);
        const toDrop = dedicatedTablesToDrop(existing.nodes, others);
        if (toDrop.length > 0) {
          const { DbStudioService } = await import('@/services/db-studio.service.js');
          const dbStudio = new DbStudioService();
          for (const ref of toDrop) {
            try {
              await dbStudio.applyMigration(
                ref.databaseId,
                [{ kind: 'drop_table', tableName: ref.table }],
                tenantId,
              );
              droppedTables.push(ref.table);
            } catch (e) {
              logger.warn(
                { err: e instanceof Error ? e.message : String(e), table: ref.table, tenantId },
                '[workflow.delete] drop tabella dedicata fallito (non-fatale)',
              );
            }
          }
        }
      } catch (e) {
        logger.warn(
          { err: e instanceof Error ? e.message : String(e), tenantId },
          '[workflow.delete] cascade tabelle fallita (non-fatale)',
        );
      }
    }

    await db.delete(workflows).where(and(eq(workflows.id, id), eq(workflows.tenantId, tenantId)));

    const now = new Date().toISOString();
    await audit.append({
      tenantId,
      action: 'workflow.delete',
      resourceType: 'workflow',
      resourceId: id,
      ...(actorId !== undefined ? { actorId } : {}),
      ...(droppedTables.length > 0 ? { metadata: { droppedTables } } : {}),
    });

    this.eventBus.emit({
      name: 'workflow.deleted',
      tenantId,
      data: { id },
      ts: now,
    });

    return true;
  }

  /**
   * Export bundle — workflow portabile cross-tenant/cross-server.
   *
   * NESSUN secret in chiaro:
   *   • Le credenziali referenziate nei nodi (campi che contengono UUID
   *     di user_credentials) vengono mostrate come placeholder {name,
   *     provider}; l'importatore re-mappa al proprio storage credenziali.
   *   • Tenant ID, workflow ID, folderId NON sono inclusi — ri-assegnati
   *     in import.
   *   • Checksum SHA256 del payload (escluso il checksum stesso) per
   *     integrity verification.
   *
   * Forward-compat: schemaVersion permette future migration.
   */
  async exportBundle(
    workflowId: string,
    tenantId: string,
  ): Promise<{
    schemaVersion: '1.0.0';
    exportedAt: string;
    exportedBy: { tenantId: string };
    workflow: {
      name: string;
      description?: string;
      nodes: unknown[];
      edges: unknown[];
      nodeDefs: unknown[];
      tags?: unknown[];
    };
    credentialPlaceholders: { configPath: string; nodeId: string; type: string }[];
    checksum: string;
    notes: string[];
  } | null> {
    const workflow = await this.get(workflowId, tenantId);
    if (!workflow) return null;

    // Scan dei nodi per individuare credenziali referenziate. I campi
    // "credentialId" sono UUID che NON vogliamo esportare (puntano al
    // tenant origine). L'utente riconfigurerà nel nuovo tenant.
    const placeholders: { configPath: string; nodeId: string; type: string }[] = [];
    const notes: string[] = [];
    const sanitizedNodes = workflow.nodes.map((n) => {
      const node = n as { id: string; defId?: string; config?: Record<string, unknown> };
      if (!node.config) return n;
      const config: Record<string, unknown> = { ...node.config };
      for (const [key, val] of Object.entries(config)) {
        if (
          key.toLowerCase().includes('credential') &&
          typeof val === 'string' &&
          val.length >= 16
        ) {
          placeholders.push({ nodeId: node.id, configPath: key, type: node.defId ?? 'unknown' });
          config[key] = ''; // azzero: l'importatore vede campo vuoto e riconfigura
        }
        // Password, secret token e API key vengono rimossi anche se non
        // referenziati come credential lookup (es. trigger_imap.password
        // hardcoded). Mai esportare valori segreti in chiaro.
        if (
          /password|secret|apikey|api_key|token|bearer/i.test(key) &&
          typeof val === 'string' &&
          val.length > 0
        ) {
          // Eccezione: publicToken di trigger_form va RIGENERATO in import,
          // non esportato (così i link pubblici del WF originale restano
          // invalidi se il bundle finisce in mani sbagliate)
          if (key === 'publicToken') {
            config[key] = '';
            notes.push(`Node "${node.id}": publicToken rigenerato in import.`);
            continue;
          }
          placeholders.push({ nodeId: node.id, configPath: key, type: node.defId ?? 'secret' });
          config[key] = '';
          notes.push(
            `Node "${node.id}": campo "${key}" azzerato (segreto) — riconfigurare in import.`,
          );
        }
      }
      return { ...node, config };
    });

    const bundle: {
      schemaVersion: '1.0.0';
      exportedAt: string;
      exportedBy: { tenantId: string };
      workflow: {
        name: string;
        description?: string;
        nodes: unknown[];
        edges: unknown[];
        nodeDefs: unknown[];
        tags?: unknown[];
      };
      credentialPlaceholders: { configPath: string; nodeId: string; type: string }[];
      checksum: string;
      notes: string[];
    } = {
      schemaVersion: '1.0.0',
      exportedAt: new Date().toISOString(),
      exportedBy: { tenantId },
      workflow: {
        name: workflow.name,
        nodes: sanitizedNodes,
        edges: workflow.edges,
        nodeDefs: workflow.nodeDefs,
      },
      credentialPlaceholders: placeholders,
      checksum: '',
      notes,
    };
    if (workflow.description) bundle.workflow.description = workflow.description;
    if (workflow.tags) bundle.workflow.tags = workflow.tags;

    // Calcola checksum SHA256 sul payload (con checksum vuoto), così
    // l'importatore può verificare integrity.
    const { createHash } = await import('node:crypto');
    bundle.checksum = createHash('sha256')
      .update(JSON.stringify({ ...bundle, checksum: '' }))
      .digest('hex');

    await audit.append({
      tenantId,
      action: 'workflow.export',
      resourceType: 'workflow',
      resourceId: workflowId,
      metadata: { name: workflow.name, nodeCount: workflow.nodes.length },
    });

    return bundle;
  }

  /**
   * Import bundle — crea un nuovo workflow nel tenant del caller.
   *
   * Steps:
   *   1. Validate schemaVersion + struttura minima
   *   2. Verifica checksum (warning se mismatch, non blocker — l'utente
   *      potrebbe aver editato il bundle a mano)
   *   3. Auto-rename se nome collide nel tenant ("(importato)" suffix)
   *   4. Crea workflow disabled=true di default (l'utente deve riconfigurare
   *      credentials + abilitare manualmente)
   *   5. Auto-gen publicToken per trigger_form (già in ensureFormTriggerTokens)
   *   6. Restituisce {workflow, warnings, credentialPlaceholders}
   */
  async importBundle(
    rawBundle: unknown,
    tenantId: string,
    actorId?: string,
  ): Promise<{
    workflow: Workflow;
    warnings: string[];
    credentialPlaceholders: { configPath: string; nodeId: string; type: string }[];
  }> {
    if (!rawBundle || typeof rawBundle !== 'object') {
      throw new Error('Bundle non valido: payload mancante o non è un oggetto.');
    }
    const bundle = rawBundle as {
      schemaVersion?: string;
      workflow?: {
        name?: string;
        description?: string;
        nodes?: unknown[];
        edges?: unknown[];
        nodeDefs?: unknown[];
        tags?: unknown[];
      };
      credentialPlaceholders?: { configPath: string; nodeId: string; type: string }[];
      checksum?: string;
    };

    if (bundle.schemaVersion !== '1.0.0') {
      throw new Error(
        `Bundle schemaVersion "${bundle.schemaVersion ?? 'mancante'}" non supportato. Atteso "1.0.0".`,
      );
    }
    if (!bundle.workflow || typeof bundle.workflow.name !== 'string') {
      throw new Error('Bundle non valido: campo "workflow.name" mancante.');
    }

    const warnings: string[] = [];

    // Verifica checksum (best-effort)
    if (bundle.checksum && typeof bundle.checksum === 'string') {
      const { createHash } = await import('node:crypto');
      const expected = createHash('sha256')
        .update(JSON.stringify({ ...bundle, checksum: '' }))
        .digest('hex');
      if (expected !== bundle.checksum) {
        warnings.push(
          'Checksum del bundle non corrisponde — il file potrebbe essere stato modificato. Verifica integrità.',
        );
      }
    } else {
      warnings.push('Nessun checksum nel bundle — impossibile verificare integrity.');
    }

    // Auto-rename se nome collide nel tenant
    const existing = await this.list(tenantId);
    const nameSet = new Set(existing.map((w) => w.name));
    let name = bundle.workflow.name;
    if (nameSet.has(name)) {
      let i = 1;
      while (nameSet.has(`${name} (importato${i > 1 ? ' ' + i.toString() : ''})`)) i++;
      const newName = `${name} (importato${i > 1 ? ' ' + i.toString() : ''})`;
      warnings.push(`Nome "${name}" già esistente nel tenant. Rinominato in "${newName}".`);
      name = newName;
    }

    // Crea workflow disabled=true (l'utente verifica credentials e attiva)
    const createInput: CreateWorkflowInput = {
      name,
      tenantId,
      enabled: false,
      nodes: bundle.workflow.nodes ?? [],
      edges: bundle.workflow.edges ?? [],
      nodeDefs: bundle.workflow.nodeDefs ?? [],
    };
    if (bundle.workflow.description) createInput.description = bundle.workflow.description;
    if (bundle.workflow.tags) createInput.tags = bundle.workflow.tags as string[];
    if (actorId) createInput.createdBy = actorId;
    const created = await this.create(createInput);

    await audit.append({
      tenantId,
      action: 'workflow.import',
      resourceType: 'workflow',
      resourceId: created.id,
      ...(actorId !== undefined ? { actorId } : {}),
      metadata: {
        name,
        originalName: bundle.workflow.name,
        warnings: warnings.length,
        placeholders: (bundle.credentialPlaceholders ?? []).length,
      },
    });

    return {
      workflow: created,
      warnings,
      credentialPlaceholders: bundle.credentialPlaceholders ?? [],
    };
  }
}
