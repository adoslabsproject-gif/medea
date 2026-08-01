/**
 * WorkflowCommentsService — commenti su nodi/workflow + @mentions (Tier 3, #7).
 * Persistito su SQLite. La lista ordinata per created_at è anche l'activity feed.
 */
import { nanoid } from 'nanoid';
import { getDatabase } from '@/storage/db.js';
import { parseMentions } from './workflow-comments.logic.js';

export interface WorkflowComment {
  id: string;
  workflowId: string;
  nodeId: string | null;
  userId: string;
  userName: string;
  body: string;
  mentions: string[];
  resolved: boolean;
  createdAt: string;
}

interface CommentRow {
  id: string; workflow_id: string; node_id: string | null; user_id: string;
  user_name: string; body: string; mentions_json: string | null; resolved: number; created_at: string;
}

function rowToComment(r: CommentRow): WorkflowComment {
  let mentions: string[] = [];
  if (r.mentions_json) { try { mentions = JSON.parse(r.mentions_json) as string[]; } catch { mentions = []; } }
  return {
    id: r.id, workflowId: r.workflow_id, nodeId: r.node_id, userId: r.user_id,
    userName: r.user_name, body: r.body, mentions, resolved: r.resolved === 1, createdAt: r.created_at,
  };
}

export class WorkflowCommentsService {
  add(input: { workflowId: string; nodeId?: string | null; userId: string; userName: string; body: string }): WorkflowComment {
    const id = nanoid();
    const mentions = parseMentions(input.body);
    const createdAt = new Date().toISOString();
    getDatabase().sqlite.prepare(`
      INSERT INTO workflow_comments (id, workflow_id, node_id, user_id, user_name, body, mentions_json, resolved, created_at)
      VALUES (@id, @wf, @node, @uid, @uname, @body, @mentions, 0, @createdAt)
    `).run({ id, wf: input.workflowId, node: input.nodeId ?? null, uid: input.userId, uname: input.userName, body: input.body, mentions: JSON.stringify(mentions), createdAt });
    return { id, workflowId: input.workflowId, nodeId: input.nodeId ?? null, userId: input.userId, userName: input.userName, body: input.body, mentions, resolved: false, createdAt };
  }

  /** Lista commenti: tutto il workflow, oppure di un nodo specifico (nodeId, anche null per i generali). */
  list(workflowId: string, nodeId?: string | null): WorkflowComment[] {
    const sqlite = getDatabase().sqlite;
    const rows = (nodeId === undefined
      ? sqlite.prepare('SELECT * FROM workflow_comments WHERE workflow_id = ? ORDER BY created_at ASC').all(workflowId)
      : sqlite.prepare('SELECT * FROM workflow_comments WHERE workflow_id = ? AND node_id IS ? ORDER BY created_at ASC').all(workflowId, nodeId)) as CommentRow[];
    return rows.map(rowToComment);
  }

  /** Conteggi per nodo (per il badge "N commenti" sul canvas). */
  countsByNode(workflowId: string): Record<string, number> {
    const rows = getDatabase().sqlite
      .prepare('SELECT node_id, COUNT(*) AS n FROM workflow_comments WHERE workflow_id = ? AND node_id IS NOT NULL AND resolved = 0 GROUP BY node_id')
      .all(workflowId) as { node_id: string; n: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.node_id] = r.n;
    return out;
  }

  /**
   * AUDIT FIX H2 (2026-06-09): aggiunto filter workflow_id.
   * Pre-fix: `UPDATE WHERE id=?` permetteva a chiunque autenticato (cross-tenant
   * superadmin impersonate) di risolvere/riaprire QUALSIASI commento conoscendo
   * l'id. Ora UPDATE WHERE id=? AND workflow_id=? — ritorna boolean per dire al
   * caller se il commento appartiene effettivamente al workflow → 404 altrimenti.
   */
  setResolved(id: string, resolved: boolean, workflowId: string): boolean {
    const res = getDatabase().sqlite
      .prepare('UPDATE workflow_comments SET resolved = ? WHERE id = ? AND workflow_id = ?')
      .run(resolved ? 1 : 0, id, workflowId);
    return res.changes > 0;
  }

  /**
   * Cancella SOLO se è del richiedente (no cancellazione di commenti altrui).
   * AUDIT FIX H3 (2026-06-09): aggiunto filter workflow_id come defense-in-depth
   * contro cross-tenant impersonate (l'id commento può collidere con altro workflow).
   */
  remove(id: string, userId: string, workflowId: string): boolean {
    const res = getDatabase().sqlite
      .prepare('DELETE FROM workflow_comments WHERE id = ? AND user_id = ? AND workflow_id = ?')
      .run(id, userId, workflowId);
    return res.changes > 0;
  }
}
