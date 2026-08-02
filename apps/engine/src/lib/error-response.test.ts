/**
 * Tests per error-response sanitization (#194 H5 regression test).
 *
 * Invarianti critiche:
 *   - PROD: NO `err.message` raw nel response body
 *   - DEV: err.message visible (debug local)
 *   - SEMPRE log con err completo + reqId + code
 *   - Status code rispettato (400 default, 500 / 422 ecc.)
 *   - reqId fallback 'unknown'
 *   - logContext extra propagato a logger ma non a client
 */

import type { Context } from 'hono';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { logger } from '@/lib/logger.js';

vi.mock('@/lib/logger.js');
const loggerErrorSpy = vi.mocked(logger).error;

beforeEach(() => {
  loggerErrorSpy.mockReset();
});

async function buildAppWithRoute(handler: (c: Context) => Response | Promise<Response>) {
  const app = new Hono();
  app.get('/boom', handler);
  return app;
}

describe('sanitizedErrorResponse', () => {
  it('PROD: NO err.message nel body, status 400 default', async () => {
    process.env.NODE_ENV = 'production';
    const { sanitizedErrorResponse } = await import('./error-response.js');
    const app = await buildAppWithRoute((c) => {
      const err = new Error('SQL error: column tenant_id does not exist in schema flowforge');
      return sanitizedErrorResponse(c, err, { code: 'DB_QUERY_FAILED' });
    });
    const res = await app.request('/boom', { headers: { 'x-request-id': 'req-prod-1' } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string; reqId: string } };
    expect(body.error.code).toBe('DB_QUERY_FAILED');
    expect(body.error.message).toBe('Operazione fallita');
    expect(body.error.reqId).toBe('req-prod-1');
    expect(JSON.stringify(body)).not.toMatch(/tenant_id/);
    expect(JSON.stringify(body)).not.toMatch(/schema flowforge/);
  });

  it('DEV: prefix [DEV] + err.message originale (debug local)', async () => {
    process.env.NODE_ENV = 'development';
    const { sanitizedErrorResponse } = await import('./error-response.js');
    const app = await buildAppWithRoute((c) => {
      return sanitizedErrorResponse(c, new Error('intern detail xyz'), { code: 'TEST_FAIL' });
    });
    const res = await app.request('/boom');
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('intern detail xyz');
    expect(body.error.message).toMatch(/^\[DEV\]/);
  });

  it('userMessage custom usato in prod (priorita` su default)', async () => {
    process.env.NODE_ENV = 'production';
    const { sanitizedErrorResponse } = await import('./error-response.js');
    const app = await buildAppWithRoute((c) => {
      return sanitizedErrorResponse(c, new Error('x'), {
        code: 'MIG_PREVIEW_FAIL',
        userMessage: 'Migration preview non valida — verifica syntax SQL',
      });
    });
    const res = await app.request('/boom');
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('Migration preview non valida');
  });

  it('status code custom (es. 422 unprocessable)', async () => {
    process.env.NODE_ENV = 'production';
    const { sanitizedErrorResponse } = await import('./error-response.js');
    const app = await buildAppWithRoute((c) => {
      return sanitizedErrorResponse(c, new Error('x'), { code: 'INVALID', status: 422 });
    });
    const res = await app.request('/boom');
    expect(res.status).toBe(422);
  });

  it('logger.error SEMPRE chiamato con err + reqId + path + method (NO err.message al client)', async () => {
    process.env.NODE_ENV = 'production';
    const { sanitizedErrorResponse } = await import('./error-response.js');
    const app = await buildAppWithRoute((c) => {
      return sanitizedErrorResponse(c, new Error('confidential'), {
        code: 'X',
        logContext: { workspaceId: 'ws-1', queryHash: 'abc' },
      });
    });
    await app.request('/boom', { method: 'GET', headers: { 'x-request-id': 'rid-9' } });
    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    const [ctx, msg] = loggerErrorSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect((ctx.err as Error).message).toBe('confidential');
    expect(ctx.reqId).toBe('rid-9');
    expect(ctx.code).toBe('X');
    expect(ctx.path).toBe('/boom');
    expect(ctx.method).toBe('GET');
    expect(ctx.workspaceId).toBe('ws-1');
    expect(ctx.queryHash).toBe('abc');
    expect(msg).toContain('confidential'); // logger sa, client no
  });

  it('reqId fallback "unknown" se header x-request-id assente', async () => {
    process.env.NODE_ENV = 'production';
    const { sanitizedErrorResponse } = await import('./error-response.js');
    const app = await buildAppWithRoute((c) =>
      sanitizedErrorResponse(c, new Error('x'), { code: 'X' }),
    );
    const res = await app.request('/boom');
    const body = (await res.json()) as { error: { reqId: string } };
    expect(body.error.reqId).toBe('unknown');
  });

  it('🚨 errore di CONNETTIVITÀ (ssh handshake timeout) → OVERRIDE 503 + code DB_UNREACHABLE + msg chiaro ESPOSTO anche in prod', async () => {
    process.env.NODE_ENV = 'production';
    const { sanitizedErrorResponse } = await import('./error-response.js');
    const app = await buildAppWithRoute((c) =>
      // la route chiede 400/DB_INTROSPECT_FAILED, ma l'override lo porta a 503/DB_UNREACHABLE
      sanitizedErrorResponse(c, new Error('Timed out while waiting for handshake'), {
        code: 'DB_INTROSPECT_FAILED',
        userMessage: 'Introspezione fallita',
      }),
    );
    const res = await app.request('/boom');
    expect(res.status).toBe(503); // NON 400
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('DB_UNREACHABLE');
    expect(body.error.message).toMatch(/tunnel SSH|irraggiungibile/i); // messaggio actionable esposto
    // il log usa il code corretto
    const [ctx] = loggerErrorSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(ctx.code).toBe('DB_UNREACHABLE');
  });

  it("🔒 errore NON di connettività → resta com'era (status/code/message invariati)", async () => {
    process.env.NODE_ENV = 'production';
    const { sanitizedErrorResponse } = await import('./error-response.js');
    const app = await buildAppWithRoute((c) =>
      sanitizedErrorResponse(c, new Error('syntax error near SELCT'), {
        code: 'DB_QUERY_FAILED',
        status: 422,
      }),
    );
    const res = await app.request('/boom');
    expect(res.status).toBe(422); // NON sovrascritto
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('DB_QUERY_FAILED');
  });

  it('errore non-Error (string thrown) gestito senza crash', async () => {
    process.env.NODE_ENV = 'production';
    const { sanitizedErrorResponse } = await import('./error-response.js');
    const app = await buildAppWithRoute((c) =>
      sanitizedErrorResponse(c, 'plain string error', { code: 'STR_ERR' }),
    );
    const res = await app.request('/boom');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('STR_ERR');
  });
});

/**
 * DB_CONFLICT_UNIQUE — classificazione violazioni UNIQUE/PK (2026-07-06).
 *
 * Bug trovato E2E (workflow pizzeria): la sanitizzazione H5 mascherava il
 * dettaglio "UNIQUE constraint failed" → il contratto onConflict='ignore'
 * dell'executor db_insert (regex sul messaggio) era rotto su TUTTO il path
 * API. Questi test fissano il contratto in entrambe le direzioni.
 */
describe('sanitizedErrorResponse — conflitto UNIQUE/PK → 409 DB_CONFLICT_UNIQUE', () => {
  /** STESSA regex dell'executor db_insert (packages/engine/nodes/db/src/index.ts,
   *  ramo onConflict==='ignore'). Se una delle due parti cambia, questo test
   *  inchioda il drift. */
  const EXECUTOR_ONCONFLICT_REGEX = /UNIQUE|duplicate|PRIMARY KEY|already exists/i;

  it('🚨 SQLite "UNIQUE constraint failed" → 409 + code DB_CONFLICT_UNIQUE, valori riga MAI nel body', async () => {
    process.env.NODE_ENV = 'production';
    const { sanitizedErrorResponse } = await import('./error-response.js');
    const app = await buildAppWithRoute((c) =>
      sanitizedErrorResponse(
        c,
        new Error('UNIQUE constraint failed: pizzeria_clienti.telefono (value 393331234567)'),
        {
          code: 'DB_INSERT_FAILED',
          userMessage: 'Insert riga fallita — verifica constraint e tipi',
        },
      ),
    );
    const res = await app.request('/boom');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('DB_CONFLICT_UNIQUE');
    // Il messaggio NOMINA il vincolo ma NON leaka i valori della riga.
    expect(body.error.message).toMatch(/UNIQUE/u);
    expect(JSON.stringify(body)).not.toMatch(/393331234567/u);
  });

  it('🚨 CONTRACT executor db_insert: il messaggio 409 matcha la regex onConflict=ignore', async () => {
    process.env.NODE_ENV = 'production';
    const { sanitizedErrorResponse } = await import('./error-response.js');
    const app = await buildAppWithRoute((c) =>
      sanitizedErrorResponse(c, new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: t.id'), {
        code: 'DB_INSERT_FAILED',
      }),
    );
    const res = await app.request('/boom');
    const body = (await res.json()) as { error: { message: string } };
    // L'executor vede "db API 409: {...message...}" e deve poter riconoscere il conflitto.
    expect(EXECUTOR_ONCONFLICT_REGEX.test(body.error.message)).toBe(true);
  });

  it('postgres "duplicate key value violates unique constraint" → 409', async () => {
    process.env.NODE_ENV = 'production';
    const { sanitizedErrorResponse } = await import('./error-response.js');
    const app = await buildAppWithRoute((c) =>
      sanitizedErrorResponse(
        c,
        new Error('duplicate key value violates unique constraint "users_pk"'),
        { code: 'DB_INSERT_FAILED' },
      ),
    );
    const res = await app.request('/boom');
    expect(res.status).toBe(409);
  });

  it('🚨 anti-falso-positivo: errore generico resta 400 col code originale', async () => {
    process.env.NODE_ENV = 'production';
    const { sanitizedErrorResponse } = await import('./error-response.js');
    const app = await buildAppWithRoute((c) =>
      sanitizedErrorResponse(c, new Error('NOT NULL constraint failed: t.nome'), {
        code: 'DB_INSERT_FAILED',
      }),
    );
    const res = await app.request('/boom');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('DB_INSERT_FAILED');
  });

  it('classifyDbConflictError: unit su tutte le firme driver + negativi', async () => {
    const { classifyDbConflictError } = await import('./error-response.js');
    expect(classifyDbConflictError(new Error('UNIQUE constraint failed: x.y')).conflict).toBe(true);
    expect(classifyDbConflictError(new Error('duplicate key value')).conflict).toBe(true);
    expect(classifyDbConflictError(new Error('PRIMARY KEY must be unique')).conflict).toBe(true);
    expect(classifyDbConflictError(new Error('table already exists')).conflict).toBe(true);
    expect(classifyDbConflictError(new Error('SQLITE_CONSTRAINT_PRIMARYKEY')).conflict).toBe(true);
    expect(classifyDbConflictError(new Error('NOT NULL constraint failed')).conflict).toBe(false);
    expect(classifyDbConflictError(new Error('syntax error near SELCT')).conflict).toBe(false);
    expect(classifyDbConflictError('boom').conflict).toBe(false);
    expect(classifyDbConflictError(null).conflict).toBe(false);
    // Il generico SQLITE_CONSTRAINT_* NON-unique resta 400 (NOT NULL/CHECK).
    expect(
      classifyDbConflictError(new Error('SQLITE_CONSTRAINT_NOTNULL: NOT NULL constraint failed'))
        .conflict,
    ).toBe(false);
  });
});
