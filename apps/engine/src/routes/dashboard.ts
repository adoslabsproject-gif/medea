/**
 * Dashboard live — Server-Sent Events stream of workflow run events.
 *
 * Why SSE not WebSocket: events are one-way (server → browser), SSE is
 * simpler (no upgrade handshake, no protocol layer), and survives proxy
 * traversal natively. WebSocket would be overkill.
 *
 * Endpoints:
 *   GET /api/v1/dashboard/workflows  — snapshot of all workflows + last-run status
 *   GET /api/v1/dashboard/stream      — text/event-stream live feed
 *
 * Client contract: the SSE messages are JSON-encoded EventPayloads from
 * the runtime event bus, filtered by tenant. The browser hook subscribes
 * to `run.started`, `run.step`, `run.completed`, `run.errored` and updates
 * an in-memory map of `runId → step states` to animate the canvas.
 */
import { Hono } from 'hono';
import { streamSSENoTransform } from '@/lib/sse-no-transform.js';
import type { IEventBus, EventPayload } from '@/ports/event-bus.js';
import { WorkflowService } from '@/services/workflow.service.js';
import { getTenantId } from '@/lib/tenant.js';
import { getDatabase } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';
import { auditCrossTenantAccess } from '@/lib/audit-log.js';
import { fetchPortalTokenUsage } from '@/services/portal-quota.service.js';

/** IP del chiamante dagli header proxy (best-effort, per l'audit). */
function clientIp(c: { req: { header: (n: string) => string | undefined } }): string | undefined {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip');
}

/** Minimal shape del client SQLite usato per il count (testabile in isolamento). */
interface SqliteCounter {
  prepare: (sql: string) => { get: (...p: unknown[]) => { c: number } | undefined };
}

/**
 * Conta i workflow ATTIVI (`enabled = 1`) di un tenant.
 *
 * Estratto come funzione pura ESPORTATA di proposito: il test della route
 * mocka `getDatabase()` e quindi NON esegue mai la SQL — non avrebbe colto
 * `SQLITE_ERROR: no such column: deleted_at` (incident 2026-06-04, plan-usage
 * 500 in prod). `dashboard.plan-usage.test.ts` esegue questa funzione contro
 * lo schema REALE (`migrate.schema.ts`) in :memory:, chiudendo il test-gap.
 *
 * NB: `workflows` è hard-deleted (`db.delete`) → niente colonna `deleted_at`.
 * Allineato a `tenantService.checkQuota` (conta solo `enabled = 1`).
 */
export function countActiveWorkflows(sqlite: SqliteCounter, tenantId: string): number {
  const row = sqlite
    .prepare('SELECT COUNT(*) AS c FROM workflows WHERE tenant_id = ? AND enabled = 1')
    .get(tenantId);
  return row?.c ?? 0;
}

export interface RunSummaryRow {
  id: string;
  status: string;
  error_count: number;
  started_at: string;
  ended_at: string | null;
  total_duration_ms: number | null;
}
interface SqliteRunReader {
  prepare: (sql: string) => { all: (...p: unknown[]) => unknown[] };
}

/**
 * Ultimi `limit` run di OGNI workflow in UNA SOLA query (window function
 * ROW_NUMBER), raggruppati per workflow_id, più-recente-prima.
 *
 * Fix N+1 2026-06-15: prima il snapshot /workflows faceva 2 query PER workflow
 * (last + recent20) → 2×N, e in vista cross-tenant ×(tutti i workflow di tutti i
 * tenant), ad ogni snapshot E ad ogni reload (run.completed). Ora 1 query
 * (chunked sotto il limite di 999 variabili SQLite). Esportata + testata contro
 * lo schema reale (come countActiveWorkflows).
 */
export function fetchRecentRunsByWorkflow(
  sqlite: SqliteRunReader,
  workflowIds: string[],
  limit = 20,
): Map<string, RunSummaryRow[]> {
  const out = new Map<string, RunSummaryRow[]>();
  if (workflowIds.length === 0) return out;
  const cap = Math.max(1, Math.min(Math.trunc(limit), 100));
  const CHUNK = 400; // < 999 var SQLite, con margine
  for (let i = 0; i < workflowIds.length; i += CHUNK) {
    const chunk = workflowIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = sqlite.prepare(`
      SELECT id, workflow_id, status, error_count, started_at, ended_at, total_duration_ms
      FROM (
        SELECT id, workflow_id, status, error_count, started_at, ended_at, total_duration_ms,
               ROW_NUMBER() OVER (PARTITION BY workflow_id ORDER BY started_at DESC, id DESC) AS rn
        FROM runs WHERE workflow_id IN (${placeholders})
      ) WHERE rn <= ${String(cap)}
      ORDER BY workflow_id, rn
    `).all(...chunk) as (RunSummaryRow & { workflow_id: string })[];
    for (const r of rows) {
      const arr = out.get(r.workflow_id) ?? [];
      arr.push({ id: r.id, status: r.status, error_count: r.error_count, started_at: r.started_at, ended_at: r.ended_at, total_duration_ms: r.total_duration_ms });
      out.set(r.workflow_id, arr);
    }
  }
  return out;
}

export function createDashboardRoutes(eventBus: IEventBus): Hono {
  const app = new Hono();
  const workflows = new WorkflowService(eventBus);

  /**
   * GET /api/v1/dashboard/plan-usage
   *
   * Plan limits + consumption in tempo reale (sprint 2026-05-31 user-segnalato
   * "voglio vedere i rimanenti del mio piano in dashboard").
   *
   * Source of truth:
   *  - max_workflows / max_users / plan_code → env Docker iniettato dal portal
   *    (MEDEA_MAX_WORKFLOWS, MEDEA_PLAN_CODE) + tabella `tenants`
   *  - current workflows count → SELECT FROM workflows local SQLite
   *  - disk usage / disk_total → statfs sul mount /data (loop device size)
   *  - liara tokens del periodo → letti S2S dal portal (tabella llm_quotas,
   *    fail-soft + cache) via services/portal-quota.service.ts. Il periodo è
   *    ancorato al giorno di abbonamento del tenant (vedi portal quota.ts).
   *
   * Risposta:
   *   { plan: { code }, workflows: {used,limit},
   *     disk: {usedBytes, totalBytes, usedPercent, binaryBytes},
   *     liara: {tokensLimit, tokensUsedMonth, periodEndIso} }
   */
  app.get('/plan-usage', async (c) => {
    const auth = c.get('auth') as { tenantId: string } | null;
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const tenantId = getTenantId(c);
    const planCode = process.env.MEDEA_PLAN_CODE ?? 'free';
    const maxWfRaw = process.env.MEDEA_MAX_WORKFLOWS;
    const maxTokenRaw = process.env.MEDEA_MAX_LIARA_TOKENS_MONTHLY;
    const maxWorkflows = (!maxWfRaw || maxWfRaw === '') ? null : parseInt(maxWfRaw, 10);
    const maxLiaraTokensMonthly = (!maxTokenRaw || maxTokenRaw === '') ? null : parseInt(maxTokenRaw, 10);

    // Count active (enabled=1) workflows del tenant. Policy 2026-06-04: quota
    // max_workflows = parallelamente abilitati, non totali. Allineato a
    // tenantService.checkQuota + PlanUsageWidget. Query in countActiveWorkflows
    // (esportata + testata contro schema reale).
    const sqlite = getDatabase().sqlite as unknown as SqliteCounter;
    const workflowsUsed = countActiveWorkflows(sqlite, tenantId);

    // 2026-06-04: disk.total = limite SOFT del piano (MEDEA_PLAN_DISK_GB),
    // NON lo statfs del loop device che può essere più grande del piano se il
    // tenant è stato downgraded (il loop NON viene shrinkato per evitare
    // data-loss su online resize). Pattern: widget mostra il limite business
    // (es. Free=1GB) anche se HW alloca 5GB. used = bytes effettivamente sul
    // disco via statfs (progress bar accurato).
    let diskUsedBytes = 0;
    let diskTotalBytes = 0;
    const planDiskGbRaw = process.env.MEDEA_PLAN_DISK_GB;
    if (planDiskGbRaw && planDiskGbRaw !== '') {
      diskTotalBytes = parseInt(planDiskGbRaw, 10) * 1024 * 1024 * 1024;
    }
    try {
      const { statfs } = await import('node:fs/promises');
      const st = await statfs('/data');
      diskUsedBytes = (st.blocks - st.bavail) * st.bsize;
      // Fallback total se env non set (pre-2026-06-04 tenants).
      if (diskTotalBytes === 0) diskTotalBytes = st.blocks * st.bsize;
    } catch { /* not available, leave 0 */ }

    // Binary blob usage (gap #13): sottoinsieme del disk usage (i blob vivono
    // in MEDEA_DATA_DIR/blobs, già contati nello statfs). Esposto per dare
    // visibilità "di cui allegati binari" nel widget. Fail-soft.
    let diskBinaryBytes = 0;
    try {
      const { getBinaryStore } = await import('@/services/binary-store.service.js');
      diskBinaryBytes = await getBinaryStore().usage();
    } catch { /* not available, leave 0 */ }

    // Dati quota dal PORTAL (S2S, fail-soft, cache 25s): usato token del periodo
    // (tabella llm_quotas vive nel portal) + limite sub-users del piano. Fetch
    // SEMPRE: maxUsers serve anche quando il piano ha token illimitati.
    const tokenUsage = await fetchPortalTokenUsage(tenantId);

    // Sub-users del tenant: count locale SQLite (utenti abilitati). Il container
    // è per-tenant → nessun filtro tenant necessario. Fail-soft (tabella assente
    // in alcuni contesti di test → 0).
    let usersUsed = 0;
    try {
      const row = (getDatabase().sqlite as unknown as {
        prepare: (s: string) => { get: () => { c: number } | undefined };
      }).prepare('SELECT COUNT(*) AS c FROM users WHERE enabled = 1').get();
      usersUsed = row?.c ?? 0;
    } catch { /* users table missing → 0 */ }

    return c.json({
      plan: { code: planCode },
      workflows: {
        used: workflowsUsed,
        limit: maxWorkflows,                   // null = unlimited
      },
      disk: {
        usedBytes: diskUsedBytes,
        totalBytes: diskTotalBytes,
        usedPercent: diskTotalBytes > 0 ? Math.round((diskUsedBytes / diskTotalBytes) * 100) : 0,
        binaryBytes: diskBinaryBytes,
      },
      users: {
        used: usersUsed,
        limit: tokenUsage?.maxUsers ?? null,   // null = illimitato (o portal irraggiungibile)
      },
      liara: {
        // tokensLimit dal PORTAL (DB-backed = source of truth). Bug 2026-06-26:
        // prima usava MEDEA_MAX_LIARA_TOKENS_MONTHLY (env del container,
        // "set-and-forget" all'onboarding) → dopo un upgrade quota nel DB l'env
        // restava STALE e il banner mostrava il vecchio limite (es. Starter
        // 500K invece dei nuovi 30M) segnalando "quota esaurita" mentre
        // l'enforcement reale (gateway portal, anch'esso DB-backed) la lasciava
        // lavorare. Ora il display usa la stessa fonte dell'enforcement.
        // Fallback all'env SOLO se il portal è irraggiungibile (degradazione).
        tokensLimit: tokenUsage ? tokenUsage.tokensLimit : maxLiaraTokensMonthly,
        tokensUsedMonth: tokenUsage?.tokensUsed ?? null, // dato REALE dal portal (no più stub)
        periodEndIso: tokenUsage?.periodEndIso ?? null,  // prossimo reset (giorno abbonamento)
      },
    });
  });

  /**
   * GET /api/v1/dashboard/workflows
   *
   * Initial snapshot for the dashboard sidebar: every workflow in the
   * caller's tenant, with the most-recent run summary (status + endedAt)
   * so the UI can render badges ("ok", "error", "running", "idle") on
   * page load before the SSE stream catches up.
   */
  app.get('/workflows', async (c) => {
    const auth = c.get('auth') as { tenantId: string; role?: string; userId?: string; email?: string } | null;
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    // Vista cross-tenant per superadmin SENZA impersonate (Federico-grade):
    //   • Se il caller è superadmin e NON sta impersonando un tenant
    //     specifico (header `x-tenant-id` non settato), ritorna i workflow
    //     di TUTTI i tenant. La sidebar UI li raggrupperà per tenant.
    //   • Se impersona via `x-tenant-id`, ritorna SOLO quel tenant
    //     (vista "come un utente di quel tenant").
    //   • Se è un utente normale, ritorna solo il suo tenant home.
    const impersonateHeader = c.req.header('x-tenant-id');
    const isCrossTenant = auth.role === 'superadmin' && !impersonateHeader;
    const tenantId = getTenantId(c);

    // Audit: il superadmin sta per leggere i workflow di TUTTI i tenant.
    if (isCrossTenant) {
      const ip = clientIp(c);
      auditCrossTenantAccess({ userId: auth.userId ?? 'unknown', ...(auth.email ? { email: auth.email } : {}), action: 'dashboard.workflows', scope: 'all-tenants', ...(ip ? { ip } : {}) });
    }

    const all = isCrossTenant
      ? await workflows.listAllAcrossTenants()
      : await workflows.list(tenantId);

    // UNA query per TUTTI i workflow (no più N+1, vedi fetchRecentRunsByWorkflow).
    const sqlite = getDatabase().sqlite as unknown as SqliteRunReader;
    const runsByWf = fetchRecentRunsByWorkflow(sqlite, all.map((wf) => wf.id), 20);
    const enriched = all.map((wf) => {
      const recentRuns = runsByWf.get(wf.id) ?? [];
      const last = recentRuns[0] ?? null; // più-recente-prima → rn=1
      return {
        id: wf.id,
        name: wf.name,
        // In vista cross-tenant esponiamo `tenantId` per ogni workflow
        // così la sidebar può raggruppare. In vista mono-tenant il campo
        // è comunque presente (tenantId del caller) per simmetria type.
        tenantId: wf.tenantId ?? tenantId,
        enabled: wf.enabled,
        // Timestamps esposti per dashboard "creato N min fa" / sort by recency
        // (bug user-segnalato 2026-05-31: la lista non mostrava data creazione).
        createdAt: wf.createdAt,
        updatedAt: wf.updatedAt,
        nodes: wf.nodes.map((n) => ({ id: n.id, defId: n.defId, label: n.config.label ?? n.id })),
        edges: wf.edges.map((e) => ({ from: e.from, to: e.to })),
        lastRun: last ?? null,
        recentRuns,
      };
    });
    return c.json({ workflows: enriched, crossTenant: isCrossTenant });
  });

  /**
   * POST /api/v1/dashboard/runs/progress
   *
   * BATCH progress lookup — design "summary-first, details-on-demand" per
   * evitare flood SSE sul Dashboard quando 5+ workflow runnano in parallelo
   * con 30+ step ciascuno (300+ eventi/sec → main thread saturato).
   *
   * Body: { runIds: string[] }
   * Output: {
   *   runs: Record<runId, {
   *     status: 'running'|'success'|'error'|'partial',
   *     currentStep: number,
   *     totalSteps: number,
   *     progressPercent: number,
   *     currentNodeId: string | null,
   *     currentNodeLabel: string | null,
   *     startedAt: number,
   *     lastUpdateAt: number,
   *     errorCount: number,
   *   }>
   * }
   *
   * Il client polla questo endpoint ogni ~3s per i run attivi invece di
   * elaborare 30 eventi/sec via SSE. Costo: 1 fetch ogni 3s, ~500 bytes.
   * Idempotente, cache-friendly (Cache-Control 1s).
   */
  app.post('/runs/progress', async (c) => {
    const auth = c.get('auth') as { tenantId: string; role?: string } | null;
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const queryTenant = c.req.header('x-tenant-id');
    const tenantId = (auth.role === 'superadmin' && queryTenant)
      ? queryTenant
      : getTenantId(c);

    let body: { runIds?: unknown };
    try {
      body = (await c.req.json());
    } catch {
      return c.json({ error: 'Body JSON non valido' }, 400);
    }
    const runIds = Array.isArray(body.runIds)
      ? body.runIds.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 50)
      : [];
    if (runIds.length === 0) return c.json({ runs: {} });

    const { db } = getDatabase();
    const { runs } = await import('../storage/schema.js');
    const { inArray, and, eq } = await import('drizzle-orm');
    const rows = await db.select().from(runs)
      .where(and(inArray(runs.id, runIds), eq(runs.tenantId, tenantId)));

    const out: Record<string, unknown> = {};
    for (const row of rows) {
      let steps: { nodeId: string; status: string; durationMs?: number; nodeLabel?: string }[] = [];
      try { steps = (JSON.parse(row.stepsJson) as typeof steps | null) ?? []; } catch { steps = []; }
      const completed = steps.filter((s) => s.status === 'success' || s.status === 'error' || s.status === 'skipped').length;
      const errored = steps.filter((s) => s.status === 'error').length;
      // currentNode: ultimo step
      const current = steps[steps.length - 1];
      const total = steps.length;
      // ── Progress percent ── BUG FIX (25 mag 2026):
      // Prima `completed/total × 100` ritornava SEMPRE 100% durante un run
      // (ogni step esistente è già completato per definizione: l'engine
      // pubblica lo step DOPO l'esecuzione). Risultato: la UI mostrava
      // "Step 45/45 — 100%" quando il workflow con loop aveva ancora 7 iter
      // da fare.
      // Federico-grade: durante 'running'/'pending' il progress è davvero
      // *indeterminate* (loop con N iter ignote a priori). Ritorniamo:
      //   • status terminato → 100% se success, oppure errored%
      //   • status in corso → null (UI mostra "in corso" senza %)
      const isTerminal = row.status === 'success' || row.status === 'error' || row.status === 'partial' || row.status === 'paused';
      const percent = !isTerminal
        ? null
        : (total > 0 ? Math.round((completed / total) * 100) : 0);
      out[row.id] = {
        status: row.status,
        currentStep: completed,
        totalSteps: total,
        progressPercent: percent,
        currentNodeId: current?.nodeId ?? null,
        currentNodeLabel: current?.nodeLabel ?? current?.nodeId ?? null,
        startedAt: row.startedAt ? new Date(row.startedAt).getTime() : null,
        lastUpdateAt: Date.now(),
        errorCount: errored,
      };
    }
    // Cache 1s — riduce hit DB se più tab pollano lo stesso runId in window
    c.header('Cache-Control', 'private, max-age=1');
    return c.json({ runs: out });
  });

  /**
   * GET /api/v1/dashboard/stream
   *
   * Persistent SSE channel. Subscribes to ALL event-bus events filtered
   * by tenant, formats each as `data: <json>\n\n`, and keeps the response
   * open until the client disconnects. Heartbeat every 25s (less than
   * the default 60s nginx/cloudflare idle timeout) so the connection
   * survives reverse-proxy buffering.
   */
  app.get('/stream', (c) => {
    const auth = c.get('auth') as { tenantId: string; role?: string; userId?: string; email?: string } | null;
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    // Disabilita HTTP/3 (QUIC) per questo path. Chrome + Cloudflare HTTP/3
    // terminano i stream SSE long-lived con ERR_QUIC_PROTOCOL_ERROR (idle
    // stream timeout side-effect). `Alt-Svc: clear` istruisce il browser
    // a smettere di annunciare h3 alternative service per questo origin
    // → riconnessione successiva su HTTP/2, stabile per SSE.
    c.header('Alt-Svc', 'clear');
    // Defense-in-depth contro proxy buffering. `X-Accel-Buffering: no` è
    // honorato da nginx (disabilita buffering even se proxy_buffering on).
    c.header('X-Accel-Buffering', 'no');
    // NB: NON usiamo `streamSSE` di Hono perché sovrascrive il nostro
    // Cache-Control. Usiamo `streamSSENoTransform` (wrapper custom) che
    // setta `no-cache, no-transform` + `Content-Encoding: identity` —
    // previene Cloudflare Brotli su HTTP/2 SSE (ERR_HTTP2_PROTOCOL_ERROR
    // su Chrome). Vedi apps/engine/src/lib/sse-no-transform.ts.
    // EventSource non può mandare header custom (x-tenant-id). Per
    // permettere al superadmin di vedere lo stream di un tenant
    // impersonato, accettiamo un parametro `?tenant=` opzionale, MA
    // SOLO se il caller è superadmin. Altrimenti il caller resta
    // confinato al suo tenant home, no cross-tenant leak.
    const queryTenant = c.req.query('tenant');
    const tenantId = (auth.role === 'superadmin' && queryTenant)
      ? queryTenant
      : getTenantId(c);
    // Vista cross-tenant per superadmin SENZA tenant override: non
    // filtra l'event bus — vede gli eventi di TUTTI i tenant in tempo
    // reale. Quando impersona invece resta confinato a quel tenant.
    const crossTenantSuperadmin = auth.role === 'superadmin' && !queryTenant;
    // Audit REALE dell'accesso cross-tenant (fix 2026-06-15): canale `audit`,
    // così la "vista gestore" privilegiata lascia una traccia GDPR-compliant.
    if (crossTenantSuperadmin) {
      const ip = clientIp(c);
      auditCrossTenantAccess({ userId: auth.userId ?? 'unknown', ...(auth.email ? { email: auth.email } : {}), action: 'dashboard.stream', scope: 'all-tenants', ...(ip ? { ip } : {}) });
    }

    return streamSSENoTransform(c, async (stream) => {
      // Bounded queue — protects against the "slow client, fast producer"
      // scenario where a stale browser tab leaves the EventSource open
      // while events pile up. Without a cap, a node executing a 10k-row
      // loop would balloon the queue and eventually OOM the worker.
      // Cap = 500 (≈ 50KB JSON at 100 bytes/event) — generous enough for
      // any realistic dashboard scenario, tight enough to fail fast on
      // a hung client.
      const QUEUE_CAP = 500;
      const queue: EventPayload[] = [];
      let droppedSinceLastWarn = 0;
      let lastDropWarnAt = 0;
      let flushing = false;
      const flush = async (): Promise<void> => {
        if (flushing) return;
        flushing = true;
        while (queue.length > 0) {
          const ev = queue.shift();
          if (!ev) break;
          try {
            await stream.writeSSE({ event: ev.name, data: JSON.stringify(ev) });
          } catch (e) {
            logger.warn({ err: e }, 'dashboard SSE write failed');
          }
        }
        flushing = false;
      };

      const unsubscribe = eventBus.subscribe((ev) => {
        // Filter by tenant — never leak cross-tenant run events.
        // Eccezione: superadmin senza impersonate vede TUTTO (vista
        // "gestore del server"). L'accesso è AUDITATO all'apertura dello
        // stream (auditCrossTenantAccess → canale `audit`, sopra).
        if (!crossTenantSuperadmin) {
          if (ev.tenantId && ev.tenantId !== tenantId && ev.tenantId !== 'system') return;
        }
        if (queue.length >= QUEUE_CAP) {
          // Drop the OLDEST event, not the new one — most dashboards
          // benefit more from seeing "current state" than "ancient state".
          queue.shift();
          droppedSinceLastWarn += 1;
          // Log throttled — once every 5 seconds at most — so a sustained
          // dropping condition doesn't flood the logs.
          const now = Date.now();
          if (now - lastDropWarnAt > 5_000) {
            logger.warn({ tenantId, dropped: droppedSinceLastWarn, queueDepth: queue.length }, 'dashboard SSE queue overflowing — slow client');
            droppedSinceLastWarn = 0;
            lastDropWarnAt = now;
          }
        }
        queue.push(ev);
        void flush();
      });

      // ⛔ CF anti-buffering hack: Cloudflare bufferizza fino a ~8KB su
      // HTTP/2 streaming prima del primo flush al client. Se il primo
      // write è piccolo (es. "hello" ~100 byte), CF aspetta più dati →
      // browser vede stream "idle" → eventualmente ERR_HTTP2_PROTOCOL_ERROR.
      // Fix: 16KB di SSE comment iniziale (riga `:` è ignorata dal client
      // per spec ma conta per il buffer CF — il doppio del threshold per
      // sicurezza). Pattern usato da OpenAI, Anthropic, Vercel.
      await stream.writeComment(' '.repeat(16_384));
      // Send a hello so the client knows it's connected (and survives
      // the immediate-close behavior of some browsers / curl debug runs).
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ tenantId, ts: new Date().toISOString() }) });

      // Heartbeat to keep proxies from closing the connection.
      // Ridotto a 15s (CF default idle timeout è ~100s ma stream con
      // throughput basso può triggerare reset prima).
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: 'ping', data: String(Date.now()) }).catch(() => { /* client gone */ });
      }, 15_000);

      // Cleanup on disconnect.
      stream.onAbort(() => {
        clearInterval(heartbeat);
        unsubscribe();
      });

      // Hold the stream open. streamSSE returns when the async fn exits,
      // so we await an unresolving promise until the client aborts.
      await new Promise<void>(() => { /* never resolves; aborted via onAbort */ });
    });
  });

  return app;
}
