import { Hono } from 'hono';
import { getDatabase } from '@/storage/db.js';

export const healthRoutes = new Hono();

healthRoutes.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'flowforge-runtime',
    ts: new Date().toISOString(),
  });
});

healthRoutes.get('/ready', (c) => {
  try {
    const { sqlite } = getDatabase();
    sqlite.prepare('SELECT 1').get();
    return c.json({ status: 'ready', database: 'ok' });
  } catch (error) {
    return c.json(
      {
        status: 'not_ready',
        database: 'error',
        error: error instanceof Error ? error.message : String(error),
      },
      503,
    );
  }
});
