/**
 * Auto-exposed REST API per table.
 * For every table inside a FlowForge-managed database, the runtime exposes:
 *   GET    /api/v1/db/:dbId/t/:table         list (with ?filter / ?limit / ?offset / ?order)
 *   GET    /api/v1/db/:dbId/t/:table/:rowId  single row by primary key
 *   POST   /api/v1/db/:dbId/t/:table         insert (body = row)
 *   PATCH  /api/v1/db/:dbId/t/:table/:rowId  update by primary key
 *   DELETE /api/v1/db/:dbId/t/:table/:rowId  delete by primary key
 *
 * This makes every FlowForge table a REST resource without writing any
 * additional adapter code — the SqliteAdapter's query/insert/update/delete
 * methods are mapped 1:1.
 */

import { Hono } from 'hono';
import { DbStudioService } from '@/services/db-studio.service.js';
import { sanitizedErrorResponse } from '@/lib/error-response.js';
import { getTenantId } from '@/lib/tenant.js';
import type { QueryFilter, QuerySpec } from '@flowforge/db-studio-core';

/**
 * Valida identifier SQL ricevuti via query/path: anti-injection guard
 * applicato PRIMA di interpolarli in SQL string.
 * Pattern: `^[A-Za-z_][A-Za-z0-9_]{0,62}$` — identifier standard SQL.
 * Exported per essere testabile come unit.
 */
export function validateSqlIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) {
    throw Object.assign(new Error(`Invalid SQL identifier: ${name}`), {
      code: 'INVALID_IDENTIFIER',
      status: 400,
    });
  }
  return name;
}

function parseFilters(filterParam: string | undefined): QueryFilter[] {
  if (!filterParam) return [];
  try {
    const parsed: unknown = JSON.parse(filterParam);
    return Array.isArray(parsed) ? (parsed as QueryFilter[]) : [];
  } catch {
    return [];
  }
}

export function createDbRestRoutes(): Hono {
  const app = new Hono();
  const service = new DbStudioService();

  app.get('/:dbId/t/:table', async (c) => {
    const tenantId = getTenantId(c);
    const { dbId, table } = c.req.param();
    const filters = parseFilters(c.req.query('filter'));
    const limit = c.req.query('limit');
    const offset = c.req.query('offset');
    const orderBy = c.req.query('order')?.split(',').map((p) => {
      const [col, dir] = p.split(':');
      const direction: 'asc' | 'desc' = dir === 'desc' ? 'desc' : 'asc';
      return { column: col ?? '', direction };
    });

    const spec: QuerySpec = {
      table,
      filters,
      orderBy: orderBy ?? [],
    };
    if (limit) spec.limit = Number(limit);
    if (offset) spec.offset = Number(offset);

    try {
      const result = await service.query(dbId, spec, tenantId);
      return c.json(result);
    } catch (error) {
      return sanitizedErrorResponse(c, error, {
        code: 'DB_REST_LIST_FAILED',
        userMessage: 'List rows fallita',
        logContext: { op: 'db-rest.list', dbId, table },
      });
    }
  });

  // NB registrata PRIMA di /:rowId, altrimenti "count" verrebbe interpretato come rowId.
  app.get('/:dbId/t/:table/count', async (c) => {
    const tenantId = getTenantId(c);
    const { dbId, table } = c.req.param();
    try {
      const total = await service.countRows(dbId, table, tenantId);
      return c.json({ total });
    } catch (error) {
      return sanitizedErrorResponse(c, error, {
        code: 'DB_REST_COUNT_FAILED',
        userMessage: 'Conteggio righe fallito',
        logContext: { op: 'db-rest.count', dbId, table },
      });
    }
  });

  app.get('/:dbId/t/:table/:rowId', async (c) => {
    const tenantId = getTenantId(c);
    const { dbId, table, rowId } = c.req.param();
    const pkColumn = validateSqlIdentifier(c.req.query('pk') ?? 'id');
    try {
      const result = await service.query(
        dbId,
        { table, filters: [{ column: pkColumn, op: 'eq', value: rowId }], orderBy: [], limit: 1 },
        tenantId,
      );
      const rows = (result as { rows: unknown[] }).rows;
      if (!rows[0]) return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
      return c.json(rows[0]);
    } catch (error) {
      return sanitizedErrorResponse(c, error, {
        code: 'DB_REST_GET_FAILED',
        userMessage: 'Get row fallita',
        logContext: { op: 'db-rest.get', dbId, table },
      });
    }
  });

  app.post('/:dbId/t/:table', async (c) => {
    const tenantId = getTenantId(c);
    const { dbId, table } = c.req.param();
    const raw = (await c.req.json()) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return c.json({ error: { code: 'INVALID_BODY', message: 'Body must be a JSON object' } }, 400);
    }
    const row = raw as Record<string, unknown>;
    try {
      const result = await service.insert(dbId, table, row, tenantId);
      return c.json(result, 201);
    } catch (error) {
      return sanitizedErrorResponse(c, error, {
        code: 'DB_REST_INSERT_FAILED',
        userMessage: 'Insert riga fallita — verifica constraint',
        logContext: { op: 'db-rest.insert', dbId, table },
      });
    }
  });

  // Update one row by PK. Body is the patch (partial column→value map);
  // PK column name comes from ?pk= query (default 'id').
  app.put('/:dbId/t/:table/:rowId', async (c) => {
    const tenantId = getTenantId(c);
    const { dbId, table, rowId } = c.req.param();
    const pkColumn = validateSqlIdentifier(c.req.query('pk') ?? 'id');
    const raw = (await c.req.json()) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return c.json({ error: { code: 'INVALID_BODY', message: 'Body must be a JSON object (patch)' } }, 400);
    }
    try {
      const result = await service.updateRow(dbId, table, { [pkColumn]: rowId }, raw as Record<string, unknown>, tenantId);
      return c.json(result);
    } catch (error) {
      return sanitizedErrorResponse(c, error, {
        code: 'DB_REST_UPDATE_FAILED',
        userMessage: 'Update riga fallita',
        logContext: { op: 'db-rest.update', dbId, table },
      });
    }
  });

  // Delete one row by PK. Pair with the UI confirm dialog in TableBrowser.
  // Cascades depend on the user's schema (FK ON DELETE rules).
  app.delete('/:dbId/t/:table/:rowId', async (c) => {
    const tenantId = getTenantId(c);
    const { dbId, table, rowId } = c.req.param();
    const pkColumn = validateSqlIdentifier(c.req.query('pk') ?? 'id');
    try {
      const result = await service.deleteRow(dbId, table, { [pkColumn]: rowId }, tenantId);
      return c.json(result);
    } catch (error) {
      return sanitizedErrorResponse(c, error, {
        code: 'DB_REST_DELETE_FAILED',
        userMessage: 'Delete riga fallita',
        logContext: { op: 'db-rest.delete', dbId, table },
      });
    }
  });

  return app;
}
