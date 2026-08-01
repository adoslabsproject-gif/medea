/**
 * Forms admin endpoints — backs the `/#/forms` editor tab.
 *
 * Routes:
 *   GET  /forms-list                       — list every workflow with a trigger_form
 *   POST /forms-list/quick-create          — scaffold a new workflow with a form trigger pre-wired
 *   GET  /forms-list/:workflowId/submissions — list submissions (runs) for a form
 *   GET  /forms-list/:workflowId/submissions.csv — download submissions as CSV
 *
 * All scoped to the JWT-verified tenantId (header values are caller-controlled
 * and would otherwise let a member of tenant A peek at tenant B's submissions).
 */

import { Hono } from 'hono';
import { eq, and, sql, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDatabase } from '@/storage/db.js';
import { runs as runsTable } from '@/storage/schema.js';
import { WorkflowService } from '@/services/workflow.service.js';
import { InMemoryEventBus } from '@/adapters/event-bus-memory.js';
import { getTenantId } from '@/lib/tenant.js';

interface FormSummary {
  workflowId: string;
  workflowName: string;
  enabled: boolean;
  nodeId: string;
  title: string;
  fieldsCount: number;
  formUrl: string;
  submissionCount: number;
  lastSubmissionAt: string | null;
}

interface SubmissionRow {
  runId: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  input: Record<string, unknown>;
}

/** Default fields for the "quick create" scaffold — a 3-field contact form. */
const DEFAULT_FORM_FIELDS = [
  { key: 'nome', label: 'Nome', type: 'text', required: true, placeholder: 'Mario Rossi' },
  { key: 'email', label: 'Email', type: 'email', required: true, placeholder: 'mario@example.com' },
  { key: 'messaggio', label: 'Messaggio', type: 'textarea', required: true, placeholder: 'Scrivi qui...' },
];

export function createFormsListRoutes(): Hono {
  const app = new Hono();
  const workflowService = new WorkflowService(new InMemoryEventBus());

  // ───── LIST ─────
  app.get('/forms-list', async (c) => {
    const tenantId = getTenantId(c);
    const origin = c.req.header('origin') ?? `${new URL(c.req.url).origin}`;
    const list = await workflowService.list(tenantId);
    const result: FormSummary[] = [];

    for (const wf of list) {
      const formNode = wf.nodes.find((n) => n.defId === 'trigger_form');
      if (!formNode) continue;
      let fieldsCount = 0;
      try {
        const fields = JSON.parse(formNode.config.fieldsJson ?? '[]') as unknown[];
        fieldsCount = Array.isArray(fields) ? fields.length : 0;
      } catch {
        fieldsCount = 0;
      }

      const { db } = getDatabase();
      const [counted] = await db
        .select({ c: sql<number>`count(*)`, last: sql<string | null>`max(started_at)` })
        .from(runsTable)
        .where(and(eq(runsTable.workflowId, wf.id), eq(runsTable.triggerType, 'form')));

      result.push({
        workflowId: wf.id,
        workflowName: wf.name,
        enabled: wf.enabled,
        nodeId: formNode.id,
        title: typeof formNode.config.title === 'string' ? formNode.config.title : wf.name,
        fieldsCount,
        formUrl: `${origin}/forms/${wf.id}/${formNode.id}`,
        submissionCount: Number(counted?.c ?? 0),
        lastSubmissionAt: counted?.last ?? null,
      });
    }

    return c.json({ forms: result, total: result.length });
  });

  // ───── QUICK-CREATE ─────
  app.post('/forms-list/quick-create', async (c) => {
    const tenantId = getTenantId(c);
    const body = await c.req.json().catch(() => ({})) as { name?: string; title?: string };
    const name = (body.name?.trim()) || 'Nuovo form';
    const title = (body.title?.trim()) || name;

    const triggerNodeId = `form-${nanoid(8)}`;
    const wf = await workflowService.create({
      name,
      tenantId,
      enabled: false, // user enables AFTER customizing fields
      nodes: [
        {
          id: triggerNodeId,
          defId: 'trigger_form',
          x: 100,
          y: 200,
          config: {
            title,
            fieldsJson: JSON.stringify(DEFAULT_FORM_FIELDS),
            submitLabel: 'Invia',
            successMessage: 'Grazie! Abbiamo ricevuto la tua segnalazione.',
            rateLimitPerMin: '10',
          },
        },
      ],
      edges: [],
    });

    return c.json({ workflow: { id: wf.id, name: wf.name, formNodeId: triggerNodeId } }, 201);
  });

  // ───── SUBMISSIONS (JSON) ─────
  app.get('/forms-list/:workflowId/submissions', async (c) => {
    const tenantId = getTenantId(c);
    const workflowId = c.req.param('workflowId');
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 100)));

    // Tenant ownership check — never let a request peek at another tenant's runs.
    const wf = await workflowService.get(workflowId, tenantId);
    if (!wf) return c.json({ error: 'Workflow non trovato' }, 404);

    const { db } = getDatabase();
    const rows = await db
      .select()
      .from(runsTable)
      .where(and(eq(runsTable.workflowId, workflowId), eq(runsTable.triggerType, 'form')))
      .orderBy(desc(runsTable.startedAt))
      .limit(limit);

    const submissions: SubmissionRow[] = rows.map((r) => {
      let input: Record<string, unknown> = {};
      try {
        const parsed = r.triggerPayloadJson ? JSON.parse(r.triggerPayloadJson) as unknown : null;
        if (parsed && typeof parsed === 'object') {
          // Form trigger stores { fields: {...} } as triggerPayloadJson;
          // fall back to whole input if the shape isn't there.
          const p = parsed as Record<string, unknown>;
          input = (p.fields && typeof p.fields === 'object' ? p.fields : p) as Record<string, unknown>;
        }
      } catch { /* keep empty */ }
      return {
        runId: r.id,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.endedAt,
        durationMs: r.totalDurationMs,
        input,
      };
    });

    return c.json({ submissions, total: submissions.length, workflowName: wf.name });
  });

  // ───── SUBMISSIONS (CSV download) ─────
  app.get('/forms-list/:workflowId/submissions.csv', async (c) => {
    const tenantId = getTenantId(c);
    const workflowId = c.req.param('workflowId');

    const wf = await workflowService.get(workflowId, tenantId);
    if (!wf) return c.json({ error: 'Workflow non trovato' }, 404);

    const { db } = getDatabase();
    const rows = await db
      .select()
      .from(runsTable)
      .where(and(eq(runsTable.workflowId, workflowId), eq(runsTable.triggerType, 'form')))
      .orderBy(desc(runsTable.startedAt));

    // Discover all field names across all submissions for a stable header.
    const fieldSet = new Set<string>();
    const parsed: { startedAt: string; status: string; runId: string; input: Record<string, unknown> }[] = [];
    for (const r of rows) {
      let input: Record<string, unknown> = {};
      try {
        const p = r.triggerPayloadJson ? JSON.parse(r.triggerPayloadJson) as Record<string, unknown> : {};
        if (p && typeof p === 'object') {
          input = (p.fields && typeof p.fields === 'object' ? p.fields : p) as Record<string, unknown>;
        }
      } catch { /* skip */ }
      for (const k of Object.keys(input)) fieldSet.add(k);
      parsed.push({ startedAt: r.startedAt, status: r.status, runId: r.id, input });
    }
    const fields = Array.from(fieldSet).sort();

    // RFC 4180 escaping: wrap in quotes if value contains comma/newline/quote;
    // double any embedded quotes.
    const esc = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
      if (/[",\n\r]/u.test(s)) return `"${s.replace(/"/gu, '""')}"`;
      return s;
    };

    const lines: string[] = [];
    lines.push(['run_id', 'started_at', 'status', ...fields].map(esc).join(','));
    for (const row of parsed) {
      lines.push([row.runId, row.startedAt, row.status, ...fields.map((f) => row.input[f])].map(esc).join(','));
    }

    const filename = `${wf.name.replace(/[^a-z0-9-_]+/giu, '_').slice(0, 60) || 'form'}-submissions.csv`;
    return new Response(lines.join('\r\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  });

  return app;
}
