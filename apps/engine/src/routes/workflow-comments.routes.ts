/**
 * Endpoint commenti workflow (Tier 3 multi-user, #7), estratti per testabilità.
 * GET lista/counts, POST add (+ @mentions auto), PATCH resolve, DELETE (owner).
 *
 * 2026-06-09 AUDIT FIX H2+H3:
 *   - **H3 tenant gate**: ogni mutating handler (POST/PATCH/DELETE) verifica
 *     `workflowService.get(workflowId, auth.tenantId)` come gate iniziale.
 *     Superadmin impersonate con workflow_id di altro tenant → 404 invece di
 *     leak/zombie row. Read (GET) restano permessi anche se il workflow non
 *     esiste (lista vuota, no info leak).
 *   - **H2 setResolved ownership**: il filter workflow_id=? è ora applicato
 *     a livello SQL nel service. Route ritorna 404 se `changes === 0` (commento
 *     non esiste nel workflow specificato → no silent success).
 */
import type { Hono } from 'hono';
import type { WorkflowCommentsService } from '@/services/workflow-comments.service.js';
import type { NotificationsService } from '@/services/notifications.service.js';
import type { WorkflowService } from '@/services/workflow.service.js';

export function registerWorkflowCommentsRoutes(
  app: Hono,
  comments: WorkflowCommentsService,
  notifications: NotificationsService,
  workflowService: WorkflowService,
): void {
  app.get('/:id/comments', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const nodeId = c.req.query('nodeId');
    const list = nodeId !== undefined
      ? comments.list(c.req.param('id'), nodeId === '' ? null : nodeId)
      : comments.list(c.req.param('id'));
    return c.json({ comments: list });
  });

  app.get('/:id/comments/counts', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    return c.json({ counts: comments.countsByNode(c.req.param('id')) });
  });

  app.post('/:id/comments', async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    // H3 tenant gate: il workflow deve esistere E appartenere al tenant.
    const workflowId = c.req.param('id');
    const wf = await workflowService.get(workflowId, auth.tenantId);
    if (!wf) return c.json({ error: 'Workflow not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as { nodeId?: string | null; body?: string };
    const text = (body.body ?? '').trim();
    if (text === '') return c.json({ error: 'Empty comment' }, 400);
    const comment = comments.add({
      workflowId,
      nodeId: body.nodeId ?? null,
      userId: auth.userId,
      userName: auth.email,
      body: text,
    });
    // Push @mention: notifica gli utenti menzionati (risolti dal tenant).
    // M6 (2026-06-09): tenantId esplicito → resolve scoped al solo tenant in cui
    // il commento è stato fatto (anti-leak cross-tenant via superadmin SSO upsert).
    if (comment.mentions.length > 0) {
      notifications.notifyForComment({
        mentions: comment.mentions, authorUserId: auth.userId, actorName: auth.email,
        workflowId: comment.workflowId, nodeId: comment.nodeId, body: comment.body,
        tenantId: auth.tenantId,
      });
    }
    return c.json({ comment }, 201);
  });

  app.patch('/:id/comments/:commentId', async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const workflowId = c.req.param('id');
    // H3 tenant gate
    const wf = await workflowService.get(workflowId, auth.tenantId);
    if (!wf) return c.json({ error: 'Workflow not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as { resolved?: boolean };
    // H2 ownership check: setResolved filtra anche per workflow_id.
    const ok = comments.setResolved(c.req.param('commentId'), body.resolved === true, workflowId);
    if (!ok) return c.json({ error: 'Comment not found in this workflow' }, 404);
    return c.json({ ok: true });
  });

  app.delete('/:id/comments/:commentId', async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const workflowId = c.req.param('id');
    const wf = await workflowService.get(workflowId, auth.tenantId);
    if (!wf) return c.json({ error: 'Workflow not found' }, 404);
    const removed = comments.remove(c.req.param('commentId'), auth.userId, workflowId);
    return c.json({ removed }, removed ? 200 : 403);
  });
}
