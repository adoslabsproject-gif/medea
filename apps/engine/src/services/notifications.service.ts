/**
 * NotificationsService — notifiche in-app (Tier 3 push @mention, #7).
 *
 * Quando un commento menziona @handle, risolviamo l'handle all'utente del tenant
 * (users.email = handle@…) e creiamo una notifica per il suo user_id (= JWT sub).
 * Il destinatario la riceve in tempo reale via SSE (stream per-utente) + la
 * legge dal bell. Niente auto-notifica all'autore.
 */
import { nanoid } from 'nanoid';
import { getDatabase } from '@/storage/db.js';
import { notificationsBus } from './notifications-bus.js';

export interface Notification {
  id: string;
  userId: string;
  type: string;
  workflowId: string | null;
  nodeId: string | null;
  actorName: string;
  preview: string;
  read: boolean;
  createdAt: string;
}

interface NotifRow {
  id: string; user_id: string; type: string; workflow_id: string | null; node_id: string | null;
  actor_name: string; preview: string; read: number; created_at: string;
}
function rowToNotif(r: NotifRow): Notification {
  return { id: r.id, userId: r.user_id, type: r.type, workflowId: r.workflow_id, nodeId: r.node_id, actorName: r.actor_name, preview: r.preview, read: r.read === 1, createdAt: r.created_at };
}

export class NotificationsService {
  /**
   * Risolve un @handle all'user_id del tenant (email = handle@…), o null.
   *
   * AUDIT FIX M6 (2026-06-09): aggiunto filter `tenant_id` come parametro
   * OBBLIGATORIO. Pre-fix: `WHERE lower(email) LIKE lower(?) || '@%'` matchava
   * QUALSIASI utente nel DB con quell'handle, indipendentemente dal tenant. In
   * scenari superadmin-impersonate (super_admin upserted in tenant X DB via
   * SSO), un @mention "superadmin@..." poteva notificare super_admin di un
   * altro tenant. Ora la query è tenant-scoped → resolve solo membri del
   * tenant in cui il commento è stato fatto.
   */
  resolveMentionUserId(handle: string, tenantId: string): string | null {
    const row = getDatabase().sqlite
      .prepare("SELECT id FROM users WHERE tenant_id = ? AND lower(email) LIKE lower(?) || '@%' AND enabled = 1 LIMIT 1")
      .get(tenantId, handle) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * user_id dei membri del tenant con ruolo amministrativo (owner del workspace).
   *
   * Per notifiche di SISTEMA tenant-scoped che non hanno un destinatario umano
   * esplicito (es. una detection del Janitor): il responsabile della qualità dei
   * dati del workspace è l'owner. TENANT-SCOPED per costruzione (stesso fix M6
   * del resolve @mention) → mai notifiche cross-tenant. `superadmin` incluso solo
   * se realmente upserted in QUESTO DB tenant (impersonation), così il provider
   * SaaS vede le detection sui workspace su cui sta operando.
   */
  tenantAdminUserIds(tenantId: string): string[] {
    const rows = getDatabase().sqlite
      .prepare("SELECT id FROM users WHERE tenant_id = ? AND enabled = 1 AND role IN ('owner', 'superadmin')")
      .all(tenantId) as { id: string }[];
    return rows.map((r) => r.id);
  }

  create(input: { userId: string; type: string; workflowId?: string | null; nodeId?: string | null; actorName: string; preview: string }): void {
    const id = nanoid();
    const createdAt = new Date().toISOString();
    const preview = input.preview.slice(0, 200);
    const workflowId = input.workflowId ?? null;
    const nodeId = input.nodeId ?? null;
    getDatabase().sqlite.prepare(`
      INSERT INTO notifications (id, user_id, type, workflow_id, node_id, actor_name, preview, read, created_at)
      VALUES (@id, @uid, @type, @wf, @node, @actor, @preview, 0, @createdAt)
    `).run({ id, uid: input.userId, type: input.type, wf: workflowId, node: nodeId, actor: input.actorName, preview, createdAt });
    // Push real-time: lo stream SSE dell'utente (stesso container) riceve
    // all'istante. Nessuna latenza da polling. Vedi notifications-bus.ts.
    notificationsBus.emitToUser(input.userId, {
      id, userId: input.userId, type: input.type, workflowId, nodeId,
      actorName: input.actorName, preview, read: false, createdAt,
    });
  }

  /**
   * Crea le notifiche @mention per un commento appena aggiunto. Risolve ogni
   * handle (TENANT-SCOPED — vedi M6), salta l'autore e gli handle non risolti.
   * Ritorna quanti notificati.
   */
  notifyForComment(input: { mentions: readonly string[]; authorUserId: string; actorName: string; workflowId: string; nodeId: string | null; body: string; tenantId: string }): number {
    let n = 0;
    for (const handle of input.mentions) {
      const userId = this.resolveMentionUserId(handle, input.tenantId);
      if (!userId || userId === input.authorUserId) continue;
      this.create({ userId, type: 'mention', workflowId: input.workflowId, nodeId: input.nodeId, actorName: input.actorName, preview: input.body });
      n += 1;
    }
    return n;
  }

  list(userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}): Notification[] {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
    const sql = opts.unreadOnly
      ? 'SELECT * FROM notifications WHERE user_id = ? AND read = 0 ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?';
    return (getDatabase().sqlite.prepare(sql).all(userId, limit) as NotifRow[]).map(rowToNotif);
  }

  unreadCount(userId: string): number {
    const row = getDatabase().sqlite.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0').get(userId) as { n: number };
    return row.n;
  }

  markRead(id: string, userId: string): void {
    getDatabase().sqlite.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?').run(id, userId);
  }

  markAllRead(userId: string): void {
    getDatabase().sqlite.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(userId);
  }
}
