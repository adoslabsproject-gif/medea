/**
 * Notifiche in-app (Tier 3 push @mention, #7). Montate su /api/v1/notifications.
 * GET lista + unread count, POST read-all, PATCH :id/read. Solo dell'utente auth.
 */
import { Hono } from 'hono';
import { NotificationsService } from '@/services/notifications.service.js';
import { notificationsBus } from '@/services/notifications-bus.js';
import { streamSSENoTransform } from '@/lib/sse-no-transform.js';

export function createNotificationsRoutes(): Hono {
  const app = new Hono();
  const svc = new NotificationsService();

  /**
   * Stream SSE push real-time (#7 Tier 3). Il bell apre un EventSource qui e
   * riceve ogni @mention all'istante — niente polling. Stesso pattern di
   * dashboard/stream: padding anti-CF-buffering, hello, heartbeat 15s, cleanup
   * onAbort. EventSource manda i cookie same-origin → auth via ff_session (il
   * middleware copre /api/v1/notifications/*).
   */
  app.get('/stream', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const userId = auth.userId;
    return streamSSENoTransform(c, async (stream) => {
      // 16KB di padding: Cloudflare bufferizza ~8KB su HTTP/2 prima del primo
      // flush → senza questo il client vedrebbe lo stream "idle".
      await stream.writeComment(' '.repeat(16_384));
      await stream.writeSSE({
        event: 'hello',
        data: JSON.stringify({ ts: new Date().toISOString() }),
      });

      const unsubscribe = notificationsBus.subscribe(userId, (notif) => {
        void stream.writeSSE({ event: 'notification', data: JSON.stringify(notif) }).catch(() => {
          /* client gone */
        });
      });
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: 'ping', data: String(Date.now()) }).catch(() => {
          /* client gone */
        });
      }, 15_000);

      stream.onAbort(() => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      // Tiene lo stream aperto finché il client non si disconnette.
      await new Promise<void>(() => {
        /* never resolves; aborted via onAbort */
      });
    });
  });

  app.get('/', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const unreadOnly = c.req.query('unread') === '1';
    return c.json({
      notifications: svc.list(auth.userId, { unreadOnly }),
      unread: svc.unreadCount(auth.userId),
    });
  });

  app.post('/read-all', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    svc.markAllRead(auth.userId);
    return c.json({ ok: true });
  });

  app.patch('/:id/read', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    svc.markRead(c.req.param('id'), auth.userId);
    return c.json({ ok: true });
  });

  return app;
}
