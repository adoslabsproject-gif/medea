/**
 * Admin workers — control fleet workers + log streaming.
 *
 * Estratto da routes/admin.ts (#199 H14 split) — 7 endpoint:
 *   GET   /admin/workers                          — list active fleet
 *   POST  /admin/workers/:id/restart              — queue restart action
 *   POST  /admin/workers/:id/drain                — queue drain action
 *   POST  /admin/workers/:id/resume               — queue resume action
 *   PATCH /admin/workers/:id/concurrency          — set concurrency
 *   GET   /admin/workers/:id/logs                 — tail journalctl
 *   GET   /admin/workers/:id/logs/stream          — SSE live tail
 *
 * Worker action intents seguono pattern queue-based (write DB column,
 * worker legge sulla prossima heartbeat <=10s) — safer than RPC.
 */

import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { WorkerCoordinationService } from '@/services/worker-coordination.service.js';
import { getDatabase } from '@/storage/db.js';
import { AuditLogService } from '@/services/audit.service.js';
import { parseIntParam } from './_shared/query-int.js';

const audit = new AuditLogService();

const ConcurrencySchema = z.object({ concurrency: z.number().int().min(1).max(64) });

export function registerWorkersRoutes(app: Hono): void {
  const workerCoord = new WorkerCoordinationService();

  app.get('/admin/workers', (c) => {
    return c.json({ workers: workerCoord.listActive() });
  });

  app.post('/admin/workers/:id/restart', async (c) => {
    const auth = c.get('auth');
    const workerId = c.req.param('id');
    if (!workerId) return c.json({ error: 'Bad request' }, 400);
    const ok = workerCoord.requestAction(workerId, 'restart', auth?.email ?? 'admin');
    if (!ok) return c.json({ error: `Worker ${workerId} not found` }, 404);
    await audit.append({
      tenantId: 'system',
      action: 'admin.worker.restart',
      resourceType: 'worker',
      resourceId: workerId,
      ...(auth?.userId ? { actorId: auth.userId } : {}),
      metadata: { action: 'restart', actorEmail: auth?.email ?? null },
    });
    return c.json({ ok: true, action: 'restart', appliedWithin: '10s' });
  });

  app.post('/admin/workers/:id/drain', async (c) => {
    const auth = c.get('auth');
    const workerId = c.req.param('id');
    if (!workerId) return c.json({ error: 'Bad request' }, 400);
    const ok = workerCoord.requestAction(workerId, 'drain', auth?.email ?? 'admin');
    if (!ok) return c.json({ error: `Worker ${workerId} not found` }, 404);
    await audit.append({
      tenantId: 'system',
      action: 'admin.worker.drain',
      resourceType: 'worker',
      resourceId: workerId,
      ...(auth?.userId ? { actorId: auth.userId } : {}),
      metadata: { action: 'drain', actorEmail: auth?.email ?? null },
    });
    return c.json({ ok: true, action: 'drain', appliedWithin: '10s' });
  });

  app.post('/admin/workers/:id/resume', async (c) => {
    const auth = c.get('auth');
    const workerId = c.req.param('id');
    if (!workerId) return c.json({ error: 'Bad request' }, 400);
    const ok = workerCoord.requestAction(workerId, 'resume', auth?.email ?? 'admin');
    if (!ok) return c.json({ error: `Worker ${workerId} not found` }, 404);
    // audit #7: resume È un cambio di stato del worker → audit come restart/drain
    // (prima era l'UNICA azione fleet senza traccia).
    await audit.append({
      tenantId: 'system',
      action: 'admin.worker.resume',
      resourceType: 'worker',
      resourceId: workerId,
      ...(auth?.userId ? { actorId: auth.userId } : {}),
      metadata: { action: 'resume', actorEmail: auth?.email ?? null },
    });
    return c.json({ ok: true, action: 'resume', appliedWithin: '10s' });
  });

  app.patch('/admin/workers/:id/concurrency', zValidator('json', ConcurrencySchema), async (c) => {
    const auth = c.get('auth');
    const workerId = c.req.param('id');
    const { concurrency } = c.req.valid('json');
    if (!workerId) return Promise.resolve(c.json({ error: 'Bad request' }, 400));
    try {
      const ok = workerCoord.requestConcurrency(workerId, concurrency, auth?.email ?? 'admin');
      if (!ok) return Promise.resolve(c.json({ error: `Worker ${workerId} not found` }, 404));
      await audit.append({
        tenantId: 'system',
        action: 'admin.worker.concurrency',
        resourceType: 'worker',
        resourceId: workerId,
        ...(auth?.userId ? { actorId: auth.userId } : {}),
        metadata: { concurrency, actorEmail: auth?.email ?? null },
      });
      return Promise.resolve(c.json({ ok: true, concurrency, appliedWithin: '10s' }));
    } catch (err) {
      return Promise.resolve(
        c.json({ error: err instanceof Error ? err.message : String(err) }, 400),
      );
    }
  });

  /**
   * GET /admin/workers/:id/logs — tail journalctl per il worker pid.
   * Read-only, ultimi N righe. NO WS streaming v1 (vedi stream endpoint).
   * Upgrade path: WS quando il runtime è frontato da log aggregator
   * (Loki/Vector).
   */
  app.get('/admin/workers/:id/logs', async (c) => {
    const workerId = c.req.param('id');
    // Clamp difensivo (audit #10): `?tail=abc` → NaN, `?tail=-5` → negativo,
    // `?tail=9e9` → overflow non devono raggiungere journalctl -n.
    const tail = parseIntParam(c.req.query('tail'), { def: 200, min: 1, max: 2000 });
    if (!workerId) return c.json({ error: 'Bad request' }, 400);
    const { sqlite } = getDatabase();
    const row = sqlite.prepare(`SELECT pid, hostname FROM workers WHERE id = ?`).get(workerId) as
      | { pid: number; hostname: string }
      | undefined;
    if (!row) return c.json({ error: `Worker ${workerId} not found` }, 404);
    try {
      // Hardening #1: lettura via execFile (argv array, zero shell) — vedi worker-logs.ts.
      const { readWorkerLogs } = await import('./worker-logs.js');
      const out = readWorkerLogs(row.pid, tail);
      return c.json({ workerId, pid: row.pid, tail, lines: out.split('\n') });
    } catch (err) {
      return c.json(
        { error: 'Log fetch failed', detail: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  /**
   * GET /admin/workers/:id/logs/stream — Server-Sent Events live tail.
   * SSE > WS for log streaming: one-way text, no upgrade handshake,
   * native reverse-proxy support, replay via Last-Event-Id.
   * Spawns journalctl -f (fallback tail -F) e pipe stdout line-by-line.
   * On client disconnect, kills lo spawned process — no leak.
   */
  app.get('/admin/workers/:id/logs/stream', async (c) => {
    const workerId = c.req.param('id');
    if (!workerId) return c.json({ error: 'Bad request' }, 400);
    const { sqlite } = getDatabase();
    const row = sqlite.prepare(`SELECT pid FROM workers WHERE id = ?`).get(workerId) as
      | { pid: number }
      | undefined;
    if (!row) return c.json({ error: `Worker ${workerId} not found` }, 404);
    const pid = Math.floor(Math.abs(Number(row.pid))).toString(); // sanitize → digits only

    const { streamSSENoTransform } = await import('@/lib/sse-no-transform.js');
    const { spawn } = await import('node:child_process');

    return streamSSENoTransform(c, async (stream) => {
      // CF anti-buffer padding (vedi dashboard.ts per dettagli)
      await stream.writeComment(' '.repeat(16_384));
      const child = spawn(
        'sh',
        [
          '-c',
          `journalctl _PID=${pid} -f -n 50 -o cat 2>/dev/null || tail -F /var/log/flowforge/worker-${pid}.log 2>/dev/null || echo "(no journalctl/no file for pid ${pid})"`,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );

      let closed = false;
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* already exited */
        }
      };
      c.req.raw.signal.addEventListener('abort', cleanup);

      child.stdout.setEncoding('utf8');
      let buf = '';
      child.stdout.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line) void stream.writeSSE({ event: 'log', data: line, id: Date.now().toString() });
        }
      });
      child.on('error', (err) => {
        void stream.writeSSE({ event: 'error', data: err.message });
        cleanup();
      });
      const hb = setInterval(() => {
        void stream.writeSSE({ event: 'heartbeat', data: '·' });
      }, 15_000);

      await new Promise<void>((resolve) => {
        child.on('exit', () => {
          clearInterval(hb);
          resolve();
        });
        c.req.raw.signal.addEventListener('abort', () => {
          clearInterval(hb);
          resolve();
        });
      });
    });
  });
}
