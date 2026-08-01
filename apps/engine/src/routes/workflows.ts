import { Hono } from 'hono';
import { coerceString } from '@/lib/coerce.js';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { WorkflowService } from '@/services/workflow.service.js';
import { WorkflowLockService } from '@/services/workflow-lock.service.js';
import { registerWorkflowLockRoutes } from './workflow-lock.routes.js';
import { WorkflowCommentsService } from '@/services/workflow-comments.service.js';
import { registerWorkflowCommentsRoutes } from './workflow-comments.routes.js';
import { registerWorkflowWebhookUrlRoutes } from './workflow-webhook-url.routes.js';
import { NotificationsService } from '@/services/notifications.service.js';
import { EstimatorService } from '@/services/estimator.service.js';
import { aiScaffold, AiScaffoldError } from '@/services/ai-scaffold.service.js';
import { createJob, completeJob, failJob, getJob } from '@/services/ai-scaffold/scaffold-jobs.js';
import { persistScaffoldResult, loadScaffoldResult } from '@/services/ai-scaffold/scaffold-result-persist.js';
import { remapNodeDatabaseIds, provisionDeclaredTables } from '@/services/ai-scaffold/scaffold-table-provision.js';
import { randomUUID } from 'node:crypto';
import { autoLayout as computeAutoLayout, type LayoutNode, type LayoutEdge } from '@/services/auto-layout.service.js';
import { tenantService, QuotaExceededError, TenantNotFoundError } from '@/services/tenant.service.js';
import type { IEventBus } from '@/ports/event-bus.js';
import { logger } from '@/lib/logger.js';
import { getTenantId } from '@/lib/tenant.js';
import { getActorId } from '@/lib/actor.js';

const OnErrorSchema = z.object({
  webhookUrl: z.string().url().optional(),
  emailTo: z.string().email().optional(),
});

const TableToCreateSchema = z.object({
  databaseId: z.string().min(1).max(50).optional(),
  name: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/u),
  description: z.string().max(200).optional(),
  columns: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/u),
    type: z.enum(['bigint', 'boolean', 'text', 'varchar', 'integer', 'decimal', 'real', 'date', 'time', 'datetime', 'json', 'uuid']),
    nullable: z.boolean().optional(),
    unique: z.boolean().optional(),
    primaryKey: z.boolean().optional(),
  })).min(1).max(30),
}).strict();

const CreateWorkflowSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  nodes: z.array(z.unknown()).optional(),
  edges: z.array(z.unknown()).optional(),
  nodeDefs: z.array(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  folderId: z.string().nullable().optional(),
  onError: OnErrorSchema.optional(),
  concurrencyLimit: z.number().int().nonnegative().optional(),
  /** @deprecated 2026-06-07 sera — usa `runVerbosity`. */
  ephemeralRuns: z.boolean().optional(),
  /** 2026-06-07 sera (tier-aware logging): tri-state per WorkflowMetaModal. */
  runVerbosity: z.enum(['silent', 'summary', 'full']).optional(),
  /** Tabelle nuove dichiarate dal wizard AI scaffold. Verranno create PRE-workflow
   *  via dbStudio.applyMigration. Best-effort: se una fallisce (es. nome
   *  duplicato) il workflow viene comunque salvato + warning in notes. */
  tablesToCreate: z.array(TableToCreateSchema).max(5).optional(),
});

const UpdateWorkflowSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  nodes: z.array(z.unknown()).optional(),
  edges: z.array(z.unknown()).optional(),
  nodeDefs: z.array(z.unknown()).optional(),
  breakpoints: z.array(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  folderId: z.string().nullable().optional(),
  onError: OnErrorSchema.nullable().optional(),
  // E4 (2026-06-06): id del workflow di errore (null = remove binding).
  errorWorkflowId: z.string().min(1).max(64).nullable().optional(),
  concurrencyLimit: z.number().int().nonnegative().nullable().optional(),
  /** @deprecated 2026-06-07 sera — usa `runVerbosity`. */
  ephemeralRuns: z.boolean().optional(),
  /** 2026-06-07 sera (tier-aware logging): null cancella → fallback default tier. */
  runVerbosity: z.enum(['silent', 'summary', 'full']).nullable().optional(),
});

export function createWorkflowRoutes(eventBus: IEventBus): Hono {
  const app = new Hono();
  const service = new WorkflowService(eventBus);
  // Multi-user editing lock (Tier 1, #7) — endpoint estratti per testabilità.
  // AUDIT FIX H3+M3 (2026-06-09): passa il WorkflowService per gate workflow-exists
  // + tenant boundary (prevenire cross-tenant superadmin impersonate + zombie row).
  registerWorkflowLockRoutes(app, new WorkflowLockService(), service);
  // Commenti + @mentions con notifiche push (Tier 3, #7).
  registerWorkflowCommentsRoutes(app, new WorkflowCommentsService(), new NotificationsService(), service);
  // URL pubblico del webhook col token derivato CORRENTE (SSOT backend —
  // il frontend non ha il secret e non può calcolarlo; fix "no-token").
  registerWorkflowWebhookUrlRoutes(app, service);

  app.get('/', async (c) => {
    const auth = c.get('auth') as { tenantId: string; role?: string } | null;
    const impersonateHeader = c.req.header('x-tenant-id');
    const isCrossTenant = auth?.role === 'superadmin' && !impersonateHeader;
    const tenantId = getTenantId(c);
    const list = isCrossTenant
      ? await service.listAllAcrossTenants()
      : await service.list(tenantId);
    return c.json({ workflows: list, total: list.length, crossTenant: isCrossTenant });
  });

  app.get('/:id', async (c) => {
    const auth = c.get('auth') as { tenantId: string; role?: string } | null;
    const impersonateHeader = c.req.header('x-tenant-id');
    const isCrossTenant = auth?.role === 'superadmin' && !impersonateHeader;
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    // Superadmin senza impersonate può aprire QUALSIASI workflow del
    // server. Audit log automatico via tracking sessionId nel JWT.
    const workflow = isCrossTenant
      ? await service.getByIdAnyTenant(id)
      : await service.get(id, tenantId);
    if (!workflow) return c.json({ error: 'Not found' }, 404);
    // Carica anche il draft autosaved (se presente). L'editor mostra il
    // draft con banner; il runtime engine continua a usare `workflow`
    // (versione "ufficiale", manual-saved).
    const draftTenantId = isCrossTenant ? (workflow.tenantId ?? 'default') : tenantId;
    const draft = await service.getDraft(id, draftTenantId);
    return c.json({ workflow, draft });
  });

  /**
   * GET /:id/pending-secrets — scan del workflow per `{{secrets.X}}` not yet
   * configured nel vault tenant. Usato dalla UI per mostrare un banner
   * "Configura prima di abilitare" + CTA al Settings → Tenant Variables.
   *
   * Response: { pending: [{ name, referencedBy[], fields[] }], total }
   */
  app.get('/:id/pending-secrets', async (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const workflow = await service.get(id, tenantId);
    if (!workflow) return c.json({ error: 'Not found' }, 404);
    const { analyzePendingSecrets } = await import('@/services/ai-scaffold/pending-secrets.js');
    const { GlobalVariablesService } = await import('@/services/global-variables.service.js');
    const gvs = new GlobalVariablesService();
    const configured = new Set<string>(gvs.list(tenantId).map((v) => v.name));
    const pending = analyzePendingSecrets({
      nodes: workflow.nodes.map((n) => ({ id: n.id, config: n.config })),
      configuredSecrets: configured,
    });
    return c.json({ pending, total: pending.length });
  });

  /**
   * PATCH /:id/draft — autosave del workflow.
   *
   * Scrive uno snapshot del workflow nel campo separato `draft_json`.
   * NON tocca la versione "ufficiale" eseguita dall'engine. Idempotente
   * (ultima chiamata vince). Validation: nessuna (può essere stato
   * intermedio inconsistente — l'utente lo correggerà).
   *
   * Body: snapshot completo serializzabile (nodes, edges, name, ...).
   * Response: { savedAt: ISO timestamp }
   */
  app.patch('/:id/draft', async (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    let payload: unknown;
    try { payload = await c.req.json(); } catch { return c.json({ error: 'JSON non valido' }, 400); }
    const result = await service.saveDraft(id, payload, tenantId);
    if (!result) return c.json({ error: 'Not found' }, 404);
    return c.json(result);
  });

  /**
   * GET /:id/error-workflow — leggi il binding error-workflow corrente.
   * Response: { errorWorkflowId: string | null }
   */
  app.get('/:id/error-workflow', async (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const existing = await service.get(id, tenantId);
    if (!existing) return c.json({ error: 'Not found' }, 404);
    const errorWorkflowId = await service.getErrorWorkflowId(id, tenantId);
    return c.json({ errorWorkflowId });
  });

  /**
   * PATCH /:id/error-workflow — UX-friendly setter dedicato.
   * Body: { errorWorkflowId: string | null }
   *   - string → bind error workflow (deve esistere nel tenant)
   *   - null   → remove binding
   * Validazioni: anti-self (id === errorWorkflowId rifiutato).
   * Risponde { errorWorkflowId: string | null }.
   */
  app.patch('/:id/error-workflow', zValidator('json', z.object({
    errorWorkflowId: z.string().min(1).max(64).nullable(),
  })), async (c) => {
    const tenantId = getTenantId(c);
    const actorId = getActorId(c);
    const id = c.req.param('id');
    const body = c.req.valid('json');
    const existing = await service.get(id, tenantId);
    if (!existing) return c.json({ error: 'Not found' }, 404);
    if (body.errorWorkflowId === id) {
      return c.json({ error: 'Anti-self loop: errorWorkflowId non può coincidere con il workflow stesso' }, 400);
    }
    if (body.errorWorkflowId !== null) {
      const target = await service.get(body.errorWorkflowId, tenantId);
      if (!target) return c.json({ error: `Error workflow ${body.errorWorkflowId} non trovato nel tenant` }, 404);
    }
    const updateInput: { errorWorkflowId: string | null; actorId?: string } = {
      errorWorkflowId: body.errorWorkflowId,
    };
    if (actorId !== null && actorId !== undefined) updateInput.actorId = actorId;
    await service.update(id, updateInput, tenantId);
    return c.json({ errorWorkflowId: body.errorWorkflowId });
  });

  /**
   * POST /:id/discard-draft — butta via il draft autosaved.
   *
   * L'editor lo chiama quando l'utente, di fronte al prompt
   * "vuoi salvare?" decide di SCARTARE le modifiche. Dopo questa
   * chiamata, GET /:id ritorna `draft: null`.
   */
  app.post('/:id/discard-draft', async (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const ok = await service.discardDraft(id, tenantId);
    if (!ok) return c.json({ error: 'Not found' }, 404);
    return c.json({ ok: true });
  });

  /**
   * GET /:id/export — esporta un workflow come bundle portabile.
   *
   * Federico-grade bundle:
   *   • workflow definition completa (nodes, edges, nodeDefs)
   *   • metadata: nome, descrizione, tag (NO id, NO tenantId — ri-assegnati in import)
   *   • elenco credenziali REFERENZIATE come placeholder (nome + provider),
   *     NESSUN valore in chiaro — l'importatore deve riconfigurare
   *   • variabili workflow-level (se presenti)
   *   • checksum SHA256 del payload per integrity verification
   *   • metadata di export (data, schemaVersion) per future migrations
   *
   * Il bundle viene scaricato come file `.flowforge.json` lato UI.
   */
  app.get('/:id/export', async (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const bundle = await service.exportBundle(id, tenantId);
    if (!bundle) return c.json({ error: 'Not found' }, 404);
    // Header download-friendly per il browser
    const filename = `${bundle.workflow.name.replace(/[^A-Za-z0-9._-]/g, '_')}.flowforge.json`;
    return new Response(JSON.stringify(bundle, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  });

  /**
   * POST /import — importa un bundle FlowForge nel tenant corrente.
   *
   * Validate:
   *   • schemaVersion compatibile
   *   • checksum opzionale (warning, non blocker)
   *   • nome auto-rinominato se collide nel tenant (suffix "(importato)")
   *   • auto-gen publicToken per trigger_form (sicurezza: gli URL del
   *     workflow originale NON funzionano nel nuovo tenant)
   *
   * Risposta: { workflow, warnings, credentialMappings? }
   */
  app.post('/import', async (c) => {
    const tenantId = getTenantId(c);
    const actorId = getActorId(c) ?? undefined;
    let bundle: unknown;
    try { bundle = await c.req.json(); } catch { return c.json({ error: 'Bundle JSON non valido' }, 400); }
    try {
      const result = await service.importBundle(bundle, tenantId, actorId);
      return c.json(result, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg, code: 'IMPORT_FAILED' }, 400);
    }
  });

  app.post('/', zValidator('json', CreateWorkflowSchema), async (c) => {
    const tenantId = getTenantId(c);
    const actorId = getActorId(c) ?? undefined;
    const body = c.req.valid('json');

    // ── Quota enforcement (#142, policy 2026-06-04) ──────────────────
    // La quota `workflows` conta gli ATTIVI (enabled=1), non i totali.
    // Pattern n8n: l'utente può creare quanti workflow vuole come bozze;
    // il limite scatta SOLO se prova a creare un workflow già abilitato e
    // tutti gli slot attivi sono pieni. Default enabled=false → no check.
    if (body.enabled === true) {
      try {
        tenantService.checkQuota(tenantId, 'workflows');
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          return c.json({
            error: err.message,
            code: 'WORKFLOW_QUOTA_EXCEEDED',
            quota: { kind: err.kind, limit: err.limit, current: err.current },
            hint: 'Hai raggiunto il limite di workflow ATTIVI del tuo piano. Disattivane uno o passa a un piano superiore.',
            upgradeUrl: '/account/billing?reason=quota',
          }, 402);
        }
        if (err instanceof TenantNotFoundError) {
          return c.json({ error: 'Tenant non trovato', code: 'TENANT_NOT_FOUND' }, 404);
        }
        throw err;
      }
    }

    // ── Pre-create tables (wizard scaffold tablesToCreate) ─────────────
    // Se il wizard ha dichiarato tabelle nuove necessarie al workflow, le
    // crea via DbStudio PRIMA di salvare il workflow. Logica condivisa con
    // /templates/:id/instantiate in provisionDeclaredTables (best-effort:
    // tabella esistente = ok idempotente, self-heal del databaseId, DB SQLite
    // on-demand se il tenant non ne ha, remap dei nodi verso l'id reale).
    let tablesCreated: { name: string; ok: boolean; error?: string }[] = [];
    if (body.tablesToCreate && body.tablesToCreate.length > 0) {
      const { DbStudioService } = await import('@/services/db-studio.service.js');
      const provision = await provisionDeclaredTables(
        new DbStudioService(), tenantId, body.tablesToCreate, logger,
      );
      tablesCreated = provision.tablesCreated;
      if (Array.isArray(body.nodes)) {
        remapNodeDatabaseIds(body.nodes, provision.dbRemap);
      }
    }

    try {
      const input: Parameters<WorkflowService['create']>[0] = {
        name: body.name,
        tenantId,
      };
      if (body.description !== undefined) input.description = body.description;
      if (body.enabled !== undefined) input.enabled = body.enabled;
      if (body.nodes !== undefined) input.nodes = body.nodes;
      if (body.edges !== undefined) input.edges = body.edges;
      if (body.nodeDefs !== undefined) input.nodeDefs = body.nodeDefs;
      if (body.tags !== undefined) input.tags = body.tags;
      if (body.folderId !== undefined) input.folderId = body.folderId;
      if (body.onError !== undefined) input.onError = body.onError;
      if (body.concurrencyLimit !== undefined) input.concurrencyLimit = body.concurrencyLimit;
      if (actorId !== undefined) input.createdBy = actorId;
      const created = await service.create(input);
      // Restituisci nel response anche l'esito create_table così la UI può
      // mostrare "✓ tabella X creata" o warning "⚠ tabella Y già esisteva"
      return c.json({ workflow: created, ...(tablesCreated.length > 0 ? { tablesCreated } : {}) }, 201);
    } catch (error) {
      logger.error({ err: error }, 'workflow.create failed');
      return c.json({ error: error instanceof Error ? error.message : 'create failed' }, 400);
    }
  });

  app.put('/:id', zValidator('json', UpdateWorkflowSchema), async (c) => {
    const tenantId = getTenantId(c);
    const actorId = getActorId(c) ?? undefined;
    const id = c.req.param('id');
    const body = c.req.valid('json');

    // ── Quota enforcement on enable transition (policy 2026-06-04) ──
    // Se l'utente sta abilitando un workflow disabled, verifica che gli
    // slot attivi non siano già pieni. Se enabled=false → no check (libera).
    // Se enabled=true ma il workflow è già enabled → no-op, no check.
    if (body.enabled === true) {
      const existing = await service.get(id, tenantId);
      if (existing && !existing.enabled) {
        try {
          tenantService.checkQuota(tenantId, 'workflows');
        } catch (err) {
          if (err instanceof QuotaExceededError) {
            return c.json({
              error: err.message,
              code: 'WORKFLOW_QUOTA_EXCEEDED',
              quota: { kind: err.kind, limit: err.limit, current: err.current },
              hint: 'Hai raggiunto il limite di workflow ATTIVI. Disattivane un altro per liberare uno slot.',
              upgradeUrl: '/account/billing?reason=quota',
            }, 402);
          }
          if (err instanceof TenantNotFoundError) {
            return c.json({ error: 'Tenant non trovato', code: 'TENANT_NOT_FOUND' }, 404);
          }
          throw err;
        }
      }
    }

    const input: Parameters<WorkflowService['update']>[1] = {};
    if (body.name !== undefined) input.name = body.name;
    if (body.description !== undefined) input.description = body.description;
    if (body.enabled !== undefined) input.enabled = body.enabled;
    // CONFIG MERGE preservante (Bug R-recurring): quando il browser ha
    // caricato il workflow PRIMA che il backend deployasse un nuovo
    // configField (es. `onlyUnseen` su trigger_imap), il PUT che il
    // browser invia NON include quel campo nel config del nodo. Senza
    // merge, il backend lo cancellerebbe — distruggendo configurazioni
    // che né l'utente né il frontend conoscono. Strategia: per ogni
    // nodo del PUT che ha lo stesso `id` di un nodo esistente, fai
    // merge dei `config` (preserva chiavi mancanti dal PUT). Questo
    // significa: "PUT può modificare/aggiungere config, MAI cancellare".
    // Se l'utente vuole davvero rimuovere una config field, deve
    // settarla a stringa vuota — semantica più sicura del "missing key".
    if (body.nodes !== undefined) {
      const existing = await service.get(id, tenantId);
      if (existing) {
        const existingById = new Map(existing.nodes.map((n) => [n.id, n]));
        type NodeIn = { id: string; config?: Record<string, unknown> } & Record<string, unknown>;
        input.nodes = (body.nodes as NodeIn[]).map((n) => {
          const prev = existingById.get(n.id);
          if (!prev) return n;
          const mergedConfig: Record<string, unknown> = { ...(prev.config ?? {}) };
          for (const [k, v] of Object.entries(n.config ?? {})) {
            mergedConfig[k] = v;
          }
          return { ...n, config: mergedConfig };
        });
      } else {
        input.nodes = body.nodes;
      }
    }
    if (body.edges !== undefined) input.edges = body.edges;
    if (body.nodeDefs !== undefined) input.nodeDefs = body.nodeDefs;
    if (body.breakpoints !== undefined) input.breakpoints = body.breakpoints;
    if (body.tags !== undefined) input.tags = body.tags;
    if (body.folderId !== undefined) input.folderId = body.folderId;
    if (body.onError !== undefined) input.onError = body.onError;
    if (body.concurrencyLimit !== undefined) input.concurrencyLimit = body.concurrencyLimit;
    if (actorId !== undefined) input.actorId = actorId;

    const updated = await service.update(id, input, tenantId);
    if (!updated) return c.json({ error: 'Not found' }, 404);
    return c.json({ workflow: updated });
  });

  // ─────────────────────────────────────────────────────────────
  // POST /:id/apply-ai-patch
  //
  // Applica un patch generato dall'AI Explain (campo `patch` della response).
  // Server-side rigorosamente valida che ogni field key sia nel NodeDef del
  // nodo target — il modello LLM può aver inventato chiavi inesistenti.
  // Audit log: chi (utente), quando, quale patch, quale runId origine.
  //
  // Body: { patch: WorkflowPatch, sourceRunId?: string, confidence?: number }
  // Output: { workflow: updated, applied: { updateNodes: N, addNodes: M, ... } }
  // ─────────────────────────────────────────────────────────────
  const ApplyAiPatchSchema = z.object({
    patch: z.object({
      updateNodes: z.array(z.object({
        id: z.string(),
        patch: z.object({
          config: z.record(z.string(), z.unknown()).optional(),
          name: z.string().optional(),
          notes: z.string().optional(),
        }),
      })).optional(),
      addNodes: z.array(z.object({
        id: z.string(),
        defId: z.string(),
        config: z.record(z.string(), z.unknown()).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
      })).optional(),
      removeNodeIds: z.array(z.string()).optional(),
      addEdges: z.array(z.object({
        from: z.string(),
        to: z.string(),
        fromPort: z.string().optional(),
      })).optional(),
      removeEdgeIds: z.array(z.string()).optional(),
    }),
    sourceRunId: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  });
  app.post('/:id/apply-ai-patch', zValidator('json', ApplyAiPatchSchema), async (c) => {
    const tenantId = getTenantId(c);
    const actorId = getActorId(c) ?? undefined;
    const id = c.req.param('id');
    const body = c.req.valid('json');

    const existing = await service.get(id, tenantId);
    if (!existing) return c.json({ error: 'Workflow non trovato' }, 404);

    const nodes = [...existing.nodes];
    const edges = [...existing.edges];

    let updateCount = 0, addCount = 0, removeNodeCount = 0, addEdgeCount = 0, removeEdgeCount = 0;
    const issues: string[] = [];

    // 1. updateNodes: patch config + name + notes
    for (const upd of body.patch.updateNodes ?? []) {
      const idx = nodes.findIndex((n) => n.id === upd.id);
      if (idx < 0) {
        issues.push(`updateNodes: nodeId "${upd.id}" non esiste`);
        continue;
      }
      const target = nodes[idx];
      if (!target) continue;
      const next = { ...target };
      if (upd.patch.config) {
        next.config = { ...(target.config ?? {}), ...(upd.patch.config as Record<string, string>) };
      }
      if (upd.patch.name !== undefined) next.name = upd.patch.name;
      if (upd.patch.notes !== undefined) next.notes = upd.patch.notes;
      nodes[idx] = next;
      updateCount += 1;
    }
    // 2. removeNodeIds
    for (const rid of body.patch.removeNodeIds ?? []) {
      const idx = nodes.findIndex((n) => n.id === rid);
      if (idx < 0) {
        issues.push(`removeNodeIds: nodeId "${rid}" non esiste`);
        continue;
      }
      nodes.splice(idx, 1);
      removeNodeCount += 1;
      // Cascade rimuovi edges connesse
      for (let i = edges.length - 1; i >= 0; i--) {
        const edge = edges[i];
        if (edge && (edge.from === rid || edge.to === rid)) {
          edges.splice(i, 1);
          removeEdgeCount += 1;
        }
      }
    }
    // 3. addNodes
    for (const add of body.patch.addNodes ?? []) {
      if (nodes.some((n) => n.id === add.id)) {
        issues.push(`addNodes: nodeId "${add.id}" già esiste`);
        continue;
      }
      nodes.push({
        id: add.id,
        defId: add.defId,
        x: add.x ?? 100,
        y: add.y ?? 100,
        config: (add.config ?? {}) as Record<string, string>,
      });
      addCount += 1;
    }
    // 4. addEdges
    for (const e of body.patch.addEdges ?? []) {
      if (!nodes.some((n) => n.id === e.from) || !nodes.some((n) => n.id === e.to)) {
        issues.push(`addEdges: from="${e.from}" o to="${e.to}" non esistono`);
        continue;
      }
      edges.push({
        from: e.from,
        to: e.to,
        ...(e.fromPort ? { fromPort: e.fromPort } : {}),
      });
      addEdgeCount += 1;
    }
    // 5. removeEdgeIds (gli edge non hanno id stabili, identifichiamo per from+to)
    for (const eid of body.patch.removeEdgeIds ?? []) {
      // formato "from|to" o "from|to|fromPort" — best-effort match
      const parts = eid.split('|');
      const idx = edges.findIndex((e) =>
        e.from === parts[0] && e.to === parts[1]
        && (parts[2] === undefined || e.fromPort === parts[2]),
      );
      if (idx < 0) {
        issues.push(`removeEdgeIds: edge "${eid}" non trovato`);
        continue;
      }
      edges.splice(idx, 1);
      removeEdgeCount += 1;
    }

    const updated = await service.update(
      id,
      { nodes, edges, ...(actorId !== undefined ? { actorId } : {}) },
      tenantId,
    );
    return c.json({
      workflow: updated,
      applied: { updateCount, addCount, removeNodeCount, addEdgeCount, removeEdgeCount },
      issues,
      sourceRunId: body.sourceRunId,
      aiConfidence: body.confidence,
    });
  });

  app.delete('/:id', async (c) => {
    const tenantId = getTenantId(c);
    const actorId = getActorId(c) ?? undefined;
    const id = c.req.param('id');
    // ?dropTables=true → cascade DEDICATA: droppa anche le tabelle scritte SOLO da
    // questo workflow (mai quelle condivise). Default false (non distruttivo).
    const dropTables = c.req.query('dropTables') === 'true';
    const ok = await service.delete(id, tenantId, actorId, { dropTables });
    if (!ok) return c.json({ error: 'Not found' }, 404);
    return c.body(null, 204);
  });

  // ─────────────────────────────────────────────────────────────
  // POST /:id/estimate — static analysis: predict cost, ETA, rate-limit
  // ─────────────────────────────────────────────────────────────
  // POST /:id/auto-layout
  //
  // Riordina TUTTI i nodi del workflow secondo l'algoritmo Sugiyama
  // (Dagre layered drawing), persiste le nuove coordinate sul DB,
  // ritorna il workflow aggiornato + stats di layout.
  //
  // Body (opzionale): { rankdir?: 'LR'|'TB', nodesep?, ranksep?, marginx?, marginy? }
  //   Default: LR, nodesep=70, ranksep=220, margin=80 (testato su 30+ workflow).
  //
  // Idempotente: re-run produce lo stesso output. Safe per autosave/cron.
  // ─────────────────────────────────────────────────────────────
  const LayoutOptsSchema = z.object({
    rankdir: z.enum(['LR', 'TB', 'RL', 'BT']).optional(),
    nodesep: z.number().int().positive().max(500).optional(),
    ranksep: z.number().int().positive().max(800).optional(),
    marginx: z.number().int().nonnegative().max(400).optional(),
    marginy: z.number().int().nonnegative().max(400).optional(),
  });
  app.post('/:id/auto-layout', async (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const actorId = getActorId(c) ?? undefined;

    const opts: Parameters<typeof computeAutoLayout>[2] = {};
    try {
      const raw: unknown = await c.req.json();
      if (raw !== null && typeof raw === 'object') {
        const parsed = LayoutOptsSchema.safeParse(raw);
        if (parsed.success) {
          if (parsed.data.rankdir !== undefined) opts.rankdir = parsed.data.rankdir;
          if (parsed.data.nodesep !== undefined) opts.nodesep = parsed.data.nodesep;
          if (parsed.data.ranksep !== undefined) opts.ranksep = parsed.data.ranksep;
          if (parsed.data.marginx !== undefined) opts.marginx = parsed.data.marginx;
          if (parsed.data.marginy !== undefined) opts.marginy = parsed.data.marginy;
        }
      }
    } catch { /* empty body → defaults */ }

    const existing = await service.get(id, tenantId);
    if (!existing) return c.json({ error: 'Workflow non trovato' }, 404);

    const { nodes: relaid, stats } = await computeAutoLayout(
      existing.nodes as unknown as LayoutNode[],
      existing.edges as unknown as LayoutEdge[],
      opts,
    );

    try {
      const updated = await service.update(
        id,
        { nodes: relaid, ...(actorId !== undefined ? { actorId } : {}) },
        tenantId,
      );
      return c.json({ workflow: updated, layout: stats });
    } catch (err) {
      logger.error({ err, workflowId: id }, 'auto-layout: persist failed');
      return c.json({ error: err instanceof Error ? err.message : 'Layout persist failed' }, 500);
    }
  });

  // pressure before the operator hits "Run". Returns per-loop suggestions.
  // Body: { sampleInput?: unknown, defaultIterationCount?: number }
  // ─────────────────────────────────────────────────────────────
  const estimator = new EstimatorService();
  app.post('/:id/estimate', async (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const workflow = await service.get(id, tenantId);
    if (!workflow) return c.json({ error: 'Not found' }, 404);

    let body: { sampleInput?: unknown; defaultIterationCount?: number } = {};
    try {
      const raw: unknown = await c.req.json();
      if (raw !== null && typeof raw === 'object') {
        body = raw;
      }
    } catch {
      // empty body is fine — estimator will use defaults
    }

    try {
      const estimate = estimator.estimate({
        workflow,
        sampleInput: body.sampleInput,
        ...(body.defaultIterationCount !== undefined ? { defaultIterationCount: body.defaultIterationCount } : {}),
      });
      return c.json({ estimate });
    } catch (err) {
      logger.error({ err, workflowId: id }, 'Estimator failed');
      return c.json({ error: err instanceof Error ? err.message : 'Estimator failed' }, 500);
    }
  });

  // ─────────────────────────────────────────────────────────────
  // POST /ai-scaffold/stream — SSE streaming variant.
  //
  // L'agent loop puo\` durare 2-6 minuti (12 iter × 10-30s ciascuna).
  // Cloudflare timeout sync e\` 100s → POST /ai-scaffold dava 524.
  // Con SSE il client riceve eventi mentre il backend itera, Cloudflare
  // vede traffico continuo → no timeout. UI live progress invece di
  // spinner statico.
  //
  // Eventi emessi:
  //   event: start       { goal, maxIter }
  //   event: iter_start  { iteration, phase: 'llm_call' }
  //   event: tool_call   { iteration, tool, args }
  //   event: tool_result { iteration, tool, ok, elapsedMs }
  //   event: iter_end    { iteration }
  //   event: done        { result }            // workflow finale
  //   event: error       { error: string }
  // ─────────────────────────────────────────────────────────────
  app.post('/ai-scaffold/stream', async (c) => {
    const tenantId = getTenantId(c);
    let body: { goal?: string; databaseId?: string; apiKey?: string; provider?: string };
    try {
      body = (await c.req.json());
    } catch {
      return c.json({ error: 'Body JSON non valido' }, 400);
    }
    if (!body.goal || typeof body.goal !== 'string') {
      return c.json({ error: 'Missing "goal" string in body' }, 400);
    }

    // Job-store: la generazione gira server-side e PERSISTE il risultato qui,
    // così se lo stream SSE cade (generazioni lunghe ~2-4min) il client lo
    // recupera via GET /ai-scaffold/result/:jobId. "Liara gira sul server → il
    // timeout del client non deve far perdere il lavoro già prodotto."
    const jobId = randomUUID();
    createJob(jobId);

    // SSE response. Headers no-transform IMPORTANTI per Cloudflare proxy
    // (la stessa identica problematica del dashboard stream — vedi
    // memory/cloudflare-brotli-sse-fix.md).
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('X-Accel-Buffering', 'no');
    c.header('Connection', 'keep-alive');

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        let lastEventSent: string | null = null;
        const send = (event: string, data: unknown): void => {
          try {
            const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
            controller.enqueue(enc.encode(payload));
            lastEventSent = event;
          } catch (err) {
            // controller closed (client disconnected o close gia\` chiamato).
            // Loggare per debug + non re-throw (lo scaffold non deve abortire
            // per un fail di send: il danno e\` solo "UI non vede ultimi event").
            logger.warn(
              { event, err: err instanceof Error ? err.message : err },
              '[SSE] enqueue fallito (controller closed?)',
            );
          }
        };
        // Padding iniziale (16KB) per forzare Cloudflare a iniziare il
        // pipe — stesso trick di dashboard stream.
        controller.enqueue(enc.encode(`: ${'='.repeat(16_300)}\n\n`));
        // PRIMO event: il jobId, così il client può fare polling del risultato
        // se lo stream cade durante una generazione lunga.
        send('job', { jobId });

        // FIX 2026-05-29 (bug "Stream chiuso senza un risultato"): heartbeat
        // SSE ogni 15s. Liara LLM (Qwen3 32B thinking ON) puo\` prendere 30-60s
        // per ogni tool call → tra 2 SSE event passano ~50s di silenzio sul
        // pipe → CF Worker / proxy / browser fetch chiudono per idle timeout.
        // Il client riceve EOF, mostra "Stream chiuso senza un risultato"
        // anche se il backend e\` ancora vivo. Heartbeat ogni 15s tiene la
        // connessione warm. SSE comment line (inizia con `:`) e\` ignorata
        // dal parser EventSource client → no event spurious lato UI.
        // FIX 2026-05-30 (bug ricorrente — connection drop ~50-65s):
        //   • Heartbeat ogni 3s (era 8s) — aggressive per coprire CDN/proxy
        //     idle timeout brevi (~10s).
        //   • Primo heartbeat IMMEDIATO (no wait 3s) per warm-up della
        //     pipe (alcuni CDN aspettano "first activity" prima di
        //     committarsi al keep-alive).
        //   • Event `ping` (no SSE comment) per essere contato come activity
        //     dai middleware che ignorano comment lines.
        let heartbeatFailLogged = false;
        const sendHeartbeat = (): boolean => {
          try {
            controller.enqueue(enc.encode(`event: ping\ndata: ${Date.now().toString()}\n\n`));
            return true;
          } catch (err) {
            if (!heartbeatFailLogged) {
              heartbeatFailLogged = true;
              logger.warn(
                { err: err instanceof Error ? err.message : err },
                '[SSE] heartbeat fallito (controller closed) — diagnostic',
              );
            }
            return false;
          }
        };
        // Heartbeat immediato per warm-up.
        sendHeartbeat();
        const heartbeatTimer = setInterval(() => {
          if (!sendHeartbeat()) clearInterval(heartbeatTimer);
        }, 3_000);

        (async () => {
          try {
            const input: { goal: string; tenantId: string; databaseId?: string; apiKey?: string; provider?: string } = {
              goal: body.goal!,
              tenantId,
            };
            if (body.databaseId) input.databaseId = body.databaseId;
            if (body.apiKey) input.apiKey = body.apiKey;
            if (body.provider) input.provider = body.provider;
            await aiScaffold.scaffold(input, (event) => {
              // PERSISTI il risultato/errore nel job-store PRIMA di tentare il
              // send SSE: così sopravvive anche se il controller è già chiuso.
              // ('done'/'error' sono emessi a runtime ma fuori dall'union tipato.)
              const evType = event.type as string;
              if (evType === 'done') {
                const res = (event as { result?: unknown }).result;
                completeJob(jobId, res);                 // in-memory (veloce)
                persistScaffoldResult(jobId, res);       // SQLite (sopravvive al restart)
              }
              else if (evType === 'error') failJob(jobId, coerceString((event as { error?: unknown }).error ?? 'AI scaffold error'));
              send(event.type, event);
            });
            // FIX 2026-05-30 (bug "Stream chiuso senza un risultato" #2):
            // Se aiScaffold ritorna senza emettere event 'done' (es. il
            // logger interno fallisce, race fra controller.close() e flush
            // ultimo enqueue, ecc), il client vede EOF senza done → throw
            // "Stream chiuso senza un risultato".
            // Defensive: se nessun event 'done' o 'error' e\` stato sent,
            // emettiamo un 'error' esplicito ora — meglio UX che EOF muto.
            if (lastEventSent !== 'done' && lastEventSent !== 'error') {
              logger.warn(
                { tenantId, lastEventSent, goal: body.goal?.slice(0, 200) },
                '[SSE] AI scaffold returned without done/error — sending fallback error',
              );
              send('error', {
                error: `AI scaffold completato senza event 'done' (ultimo event: ${lastEventSent ?? 'nessuno'}). Bug interno: riprova.`,
                httpStatus: 500,
              });
            }
          } catch (err) {
            const message = err instanceof AiScaffoldError
              ? err.message
              : err instanceof Error ? err.message : 'AI scaffold failed';
            const httpStatus = err instanceof AiScaffoldError ? err.httpStatus : 500;
            logger.warn({ tenantId, httpStatus, errMessage: message, goal: body.goal?.slice(0, 200) }, '[SSE] AI scaffold error');
            failJob(jobId, message, httpStatus);
            send('error', { error: message, httpStatus });
          } finally {
            clearInterval(heartbeatTimer);
            // FIX 2026-05-30: delay 200ms PRIMA del close per garantire che
            // l'ultimo event (done/error) venga flush'd al pipe HTTP/2
            // prima dell'EOF. Senza questo, alcuni reverse-proxy CDN
            // possono droppare gli ultimi bytes accodati. 200ms e\` invisibile
            // all'UX MA copre il window di race buffer.
            await new Promise<void>((resolve) => setTimeout(resolve, 200));
            try { controller.close(); } catch { /* gia\` chiuso */ }
          }
        })().catch(() => {
          clearInterval(heartbeatTimer);
          /* swallowed — controller already closed */
        });
      },
    });

    return c.body(stream);
  });

  // GET /ai-scaffold/result/:jobId — recupero del risultato se lo stream SSE è
  // caduto durante una generazione lunga. Il client fa polling finché 'running'.
  //   200 done {result} · 202 running · 404 unknown/scaduto · 4xx/5xx error.
  app.get('/ai-scaffold/result/:jobId', (c) => {
    const jobId = c.req.param('jobId');
    const job = getJob(jobId);
    if (!job) {
      // In-memory l'ha perso (restart container?) → fallback SQLite sul done persistito.
      const persisted = loadScaffoldResult(jobId);
      if (persisted !== null) return c.json({ status: 'done', result: persisted }, 200);
      return c.json({ status: 'unknown' }, 404);
    }
    if (job.status === 'running') return c.json({ status: 'running' }, 202);
    if (job.status === 'error') return c.json({ status: 'error', error: job.error ?? 'error' }, (job.httpStatus && job.httpStatus >= 400 && job.httpStatus < 600 ? job.httpStatus : 500) as 500);
    return c.json({ status: 'done', result: job.result }, 200);
  });

  // ─────────────────────────────────────────────────────────────
  // POST /ai-scaffold — generate a complete workflow JSON from a
  // natural-language goal. Returns the generated workflow WITHOUT
  // persisting it — the UI can then POST / to import it after review.
  // ─────────────────────────────────────────────────────────────
  app.post('/ai-scaffold', async (c) => {
    const tenantId = getTenantId(c);
    let body: { goal?: string; databaseId?: string; apiKey?: string; provider?: string };
    try {
      body = (await c.req.json());
    } catch {
      return c.json({ error: 'Body JSON non valido' }, 400);
    }
    if (!body.goal || typeof body.goal !== 'string') {
      return c.json({ error: 'Missing "goal" string in body' }, 400);
    }
    try {
      const input: { goal: string; tenantId: string; databaseId?: string; apiKey?: string; provider?: string } = {
        goal: body.goal,
        tenantId,
      };
      if (body.databaseId) input.databaseId = body.databaseId;
      if (body.apiKey) input.apiKey = body.apiKey;
      if (body.provider) input.provider = body.provider;
      const result = await aiScaffold.scaffold(input);
      return c.json(result);
    } catch (err) {
      if (err instanceof AiScaffoldError) {
        // OBSERVABILITY: log AiScaffoldError CON messaggio + httpStatus.
        // Senza questo il container ritorna 502 silenzioso al frontend
        // e diventa impossibile diagnosticare "LIARA NON CREA NULLA" remoto.
        logger.warn(
          {
            tenantId,
            httpStatus: err.httpStatus,
            errMessage: err.message,
            goal: body.goal?.slice(0, 200),
          },
          'AI scaffold returned structured error',
        );
        return c.json({ error: err.message }, err.httpStatus as 400 | 402 | 403 | 502);
      }
      logger.error({ err, tenantId }, 'AI scaffold failed');
      return c.json({ error: err instanceof Error ? err.message : 'AI scaffold failed' }, 500);
    }
  });

  return app;
}
