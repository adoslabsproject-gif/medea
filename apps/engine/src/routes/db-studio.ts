import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { createTenantDatabase, CreateDatabaseError } from '@/services/db-studio/create-database.js';
import {
  DatabaseConnectionSchema,
  TableSchema,
  RelationSchema,
  MigrationActionSchema,
  QuerySpecSchema,
} from '@flowforge/db-studio-core';
import { classifyStatement } from '@flowforge/db-studio-engine';
import { DbStudioService, redactConnectionSecrets } from '@/services/db-studio.service.js';
import { VectorService } from '@/services/vector.service.js';
import { embedText, dimensionsForModel } from '@/services/embeddings.service.js';
import { assertBulkQuota, vectorPlanLimitsFromConfig } from '@/services/vector-ingest.js';
import { isWorkspaceReadOnly } from '@/services/readonly-flag.service.js';
import { scanForInjection } from '@/executors/rag-guard.js';
import { logger } from '@/lib/logger.js';
import { sanitizedErrorResponse } from '@/lib/error-response.js';
import { getTenantId } from '@/lib/tenant.js';
import { stream } from 'hono/streaming';
import { csvHeaderLine, csvBodyLines, unionColumns, sanitizeFilename, exportStamp } from '@/services/db-studio/db-export.js';
import { parseDumpTables, createTableStatement, insertStatement } from '@/services/db-studio/sql-dump.js';

const CreateDbSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  connection: DatabaseConnectionSchema,
  tables: z.array(TableSchema).default([]),
  relations: z.array(RelationSchema).default([]),
});

const UpdateDbSchema = CreateDbSchema.partial();

const MigrationRequestSchema = z.object({
  actions: z.array(MigrationActionSchema).min(1),
});

const InsertRequestSchema = z.object({
  table: z.string().min(1),
  row: z.record(z.string(), z.unknown()),
});

const RawSqlSchema = z.object({
  sql: z.string().min(1).max(50_000),
  dryRun: z.boolean().default(false),
  rowLimit: z.number().int().positive().max(50_000).default(1000),
});

const AutoEmbedSchema = z.object({
  sourceTable: z.string().min(1),
  textColumns: z.array(z.string().min(1)).min(1),
  idColumn: z.string().min(1).default('id'),
  targetDatabaseId: z.string().min(1),
  targetCollection: z.string().min(1).max(200),
  provider: z.enum(['openai', 'voyage', 'ollama']),
  apiKey: z.string().optional(),
  model: z.string().min(1),
  baseUrl: z.string().optional(),
  distance: z.enum(['cosine', 'euclidean', 'dot']).default('cosine'),
  limit: z.number().int().positive().max(50_000).default(1000),
  payloadColumns: z.array(z.string().min(1)).optional(),
});

/**
 * Risposta 423 standard quando il workspace è in sola lettura (disco oltre il
 * limite, grace period). FIX 2026-06-15: prima SOLO /auto-embed era gateato →
 * insert/update/delete/transaction/migrations-apply/truncate e le scritture via
 * /sql crescevano il disco anche con workspace congelato. Ora il gate è
 * coerente su TUTTE le write-path (come vector.ts), mentre SELECT/EXPLAIN
 * restano permessi anche in grace (lettura non bloccata).
 */
/**
 * Converte una cella DB (valore sconosciuto) in testo in modo type-safe:
 * primitivi → String, oggetti/array → JSON. Evita il '[object Object]' e
 * soddisfa @typescript-eslint/no-base-to-string su valori `unknown`.
 */
function cellToText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v);
}

function readOnlyBody(): { error: string; code: string } {
  return {
    error: 'Workspace in sola lettura (spazio disco oltre il limite): scrittura bloccata. Riduci i dati o riattiva un piano.',
    code: 'WORKSPACE_READ_ONLY',
  };
}

export function createDbStudioRoutes(): Hono {
  const app = new Hono();
  const service = new DbStudioService();

  app.get('/databases', (c) => {
    const auth = c.get('auth') as { tenantId: string; role?: string } | null;
    const impersonateHeader = c.req.header('x-tenant-id');
    const isCrossTenant = auth?.role === 'superadmin' && !impersonateHeader;
    const tenantId = getTenantId(c);
    // Vista cross-tenant per superadmin senza impersonate: vede TUTTI i
    // database di TUTTI i tenant (vista "gestore server"), raggruppati
    // per tenant lato UI tramite `db.tenantId` esposto in ogni record.
    // Redazione secret in display SEMPRE (anche same-tenant): il frontend non
    // riceve mai password/chiavi (cifrate a riposo). Idempotente sui cross-tenant
    // già redatti dal service. Per editare, il campo vuoto/'***redacted***' in
    // update significa "mantieni" (vedi service.update).
    const list = (isCrossTenant ? service.listAllAcrossTenants() : service.list(tenantId)).map(redactConnectionSecrets);
    return c.json({ databases: list, total: list.length, crossTenant: isCrossTenant });
  });

  app.get('/databases/:id', (c) => {
    const auth = c.get('auth') as { tenantId: string; role?: string } | null;
    const impersonateHeader = c.req.header('x-tenant-id');
    const isCrossTenant = auth?.role === 'superadmin' && !impersonateHeader;
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const db = isCrossTenant ? service.getAnyTenant(id) : service.get(id, tenantId);
    if (!db) return c.json({ error: 'Not found' }, 404);
    return c.json({ database: redactConnectionSecrets(db) });
  });

  app.post('/databases', zValidator('json', CreateDbSchema), async (c) => {
    const tenantId = getTenantId(c);
    const body = c.req.valid('json');
    const conn = body.connection;

    // MANAGED: DB sidecar provisionato NEL tenant (on-demand). La logica
    // (provisiona via portal + salva la connessione risolta) vive in
    // createTenantDatabase, CONDIVISA col tool create_database del DB-agent.
    if (conn.managed === true) {
      try {
        const created = await createTenantDatabase({
          tenantId, name: body.name,
          ...(body.description !== undefined ? { description: body.description } : {}),
          engine: conn.engine, managed: true, dbStudio: service,
        });
        return c.json({ database: redactConnectionSecrets(created) }, 201);
      } catch (err) {
        if (err instanceof CreateDatabaseError) return c.json({ error: err.message }, 400);
        const msg = err instanceof Error ? err.message : 'Provisioning non riuscito';
        return c.json({ error: msg }, 502);
      }
    }

    const created = service.create({ ...body, tenantId });
    return c.json({ database: redactConnectionSecrets(created) }, 201);
  });

  // Test connessione PRIMA del salvataggio (UI: bottone "Test connection").
  app.post('/databases/test-connection', zValidator('json', z.object({ connection: DatabaseConnectionSchema })), async (c) => {
    const tenantId = getTenantId(c);
    const result = await service.testConnection(c.req.valid('json').connection, tenantId);
    return c.json(result, result.ok ? 200 : 422);
  });

  app.put('/databases/:id', zValidator('json', UpdateDbSchema), (c) => {
    const tenantId = getTenantId(c);
    const body = c.req.valid('json');
    const patch: Parameters<typeof service.update>[1] = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.connection !== undefined) patch.connection = body.connection;
    if (body.tables !== undefined) patch.tables = body.tables;
    if (body.relations !== undefined) patch.relations = body.relations;
    const updated = service.update(c.req.param('id'), patch, tenantId);
    if (!updated) return c.json({ error: 'Not found' }, 404);
    return c.json({ database: redactConnectionSecrets(updated) });
  });

  app.delete('/databases/:id', (c) => {
    const tenantId = getTenantId(c);
    const ok = service.delete(c.req.param('id'), tenantId);
    if (!ok) return c.json({ error: 'Not found' }, 404);
    return c.body(null, 204);
  });

  app.post('/databases/:id/migrations/preview', zValidator('json', MigrationRequestSchema), async (c) => {
    const tenantId = getTenantId(c);
    try {
      const sql = await service.previewMigration(c.req.param('id'), c.req.valid('json').actions, tenantId);
      return c.json({ sql });
    } catch (error) {
      return sanitizedErrorResponse(c, error, {
        code: 'DB_MIGRATION_PREVIEW_FAILED',
        userMessage: 'Anteprima migration fallita — verifica syntax SQL e schema target',
        logContext: { op: 'db-studio.migration.preview', dbId: c.req.param('id') },
      });
    }
  });

  app.post('/databases/:id/migrations/apply', zValidator('json', MigrationRequestSchema), async (c) => {
    if (isWorkspaceReadOnly()) return c.json(readOnlyBody(), 423);
    const tenantId = getTenantId(c);
    try {
      const result = await service.applyMigration(c.req.param('id'), c.req.valid('json').actions, tenantId);
      return c.json(result);
    } catch (error) {
      return sanitizedErrorResponse(c, error, {
        code: 'DB_MIGRATION_APPLY_FAILED',
        userMessage: 'Esecuzione migration fallita',
        logContext: { op: 'db-studio.migration.apply', dbId: c.req.param('id') },
      });
    }
  });

  app.post('/databases/:id/query', zValidator('json', QuerySpecSchema), async (c) => {
    const tenantId = getTenantId(c);
    try {
      const result = await service.query(c.req.param('id'), c.req.valid('json'), tenantId);
      return c.json(result);
    } catch (error) {
      return sanitizedErrorResponse(c, error, {
        code: 'DB_QUERY_FAILED',
        userMessage: 'Query fallita — verifica filtri e join',
        logContext: { op: 'db-studio.query', dbId: c.req.param('id') },
      });
    }
  });

  // ─── EXPORT / BACKUP scaricabile sul device (read-only: ok anche su DB esterni) ───
  // STREAMING a memoria limitata: una pagina alla volta sul wire, mai l'intera
  // tabella in RAM (bug 2026-06-16: il buffering OOM-crashava il container su
  // tabelle grandi). Pre-flight della prima pagina FUORI dallo stream → errori
  // (tabella inesistente, connessione) danno status HTTP corretto, non un file
  // troncato. GET → il browser scarica (Content-Disposition attachment).
  app.get('/databases/:id/tables/:table/export', async (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const table = c.req.param('table');
    const format = (c.req.query('format') ?? 'csv').toLowerCase();
    if (format !== 'csv' && format !== 'json' && format !== 'sql') {
      return c.json({ error: 'format deve essere "csv", "json" o "sql"' }, 400);
    }
    // Pre-flight: valida tabella/connessione PRIMA di aprire lo stream.
    try {
      await service.fetchTablePage(id, table, 1, 0, tenantId);
    } catch (error) {
      return sanitizedErrorResponse(c, error, {
        code: 'DB_EXPORT_FAILED',
        userMessage: 'Export tabella fallito',
        logContext: { op: 'db-studio.export', dbId: id, table },
      });
    }
    // Per il dump SQL serve lo schema della tabella (CREATE TABLE) → introspezione
    // filtrata a questa tabella; colonne dalla 1ª riga come fallback.
    let sqlColumns: string[] = [];
    let createDdl = '';
    if (format === 'sql') {
      const dumpTable = parseDumpTables(await service.introspect(id, tenantId)).find((t) => t.name === table);
      sqlColumns = dumpTable?.columns.map((col) => col.name) ?? [];
      if (sqlColumns.length === 0) {
        const firstRow = (await service.fetchTablePage(id, table, 1, 0, tenantId))[0];
        sqlColumns = firstRow ? Object.keys(firstRow) : [];
      }
      createDdl = dumpTable ? createTableStatement(table, dumpTable.columns) : '';
    }
    const base = `${sanitizeFilename(table)}-${exportStamp()}`;
    const contentType = format === 'csv'
      ? 'text/csv; charset=utf-8'
      : format === 'sql' ? 'application/sql; charset=utf-8' : 'application/json; charset=utf-8';
    c.header('Content-Type', contentType);
    c.header('Content-Disposition', `attachment; filename="${base}.${format}"`);
    c.header('X-Content-Type-Options', 'nosniff');
    return stream(c, async (s) => {
      if (format === 'csv') {
        await s.write(String.fromCharCode(0xfeff)); // BOM UTF-8 → Excel apre con encoding corretto.
        let columns: string[] | null = null;
        await service.streamTableRows(id, table, async (rows) => {
          if (columns === null) {
            columns = unionColumns(rows);
            await s.write(csvHeaderLine(columns));
          }
          if (columns.length > 0) await s.write(`\r\n${csvBodyLines(rows, columns)}`);
        }, tenantId);
      } else if (format === 'sql') {
        if (createDdl) await s.write(`${createDdl}\n`);
        if (sqlColumns.length > 0) {
          await service.streamTableRows(id, table, async (rows) => {
            const lines = rows.map((r) => insertStatement(table, sqlColumns, r)).join('\n');
            if (lines.length > 0) await s.write(`${lines}\n`);
          }, tenantId);
        }
      } else {
        await s.write('[');
        let first = true;
        await service.streamTableRows(id, table, async (rows) => {
          for (const r of rows) {
            await s.write(`${first ? '' : ','}${JSON.stringify(r)}`);
            first = false;
          }
        }, tenantId);
        await s.write(']');
      }
    });
  });

  // L'INTERO database → DUMP SQL streamato (CREATE TABLE + INSERT), ripristinabile.
  // Lista tabelle + colonne via introspezione (funziona anche sui DB esterni, il cui
  // spec non ha le tabelle). Ogni tabella streamata → memoria limitata anche su DB
  // grandi. `?format=json` → variante JSON delle sole righe (retro-compat/leggero).
  app.get('/databases/:id/backup', async (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const format = (c.req.query('format') ?? 'sql').toLowerCase();
    if (format !== 'sql' && format !== 'json') {
      return c.json({ error: 'format deve essere "sql" o "json"' }, 400);
    }
    const database = service.get(id, tenantId);
    if (!database) return c.json({ error: 'Database non trovato' }, 404);
    let tables: ReturnType<typeof parseDumpTables>;
    try {
      tables = parseDumpTables(await service.introspect(id, tenantId));
    } catch (error) {
      return sanitizedErrorResponse(c, error, {
        code: 'DB_BACKUP_FAILED',
        userMessage: 'Backup database fallito (introspezione tabelle)',
        logContext: { op: 'db-studio.backup', dbId: id },
      });
    }
    const base = `backup-${sanitizeFilename(database.name)}-${exportStamp()}`;
    c.header('Content-Disposition', `attachment; filename="${base}.${format}"`);
    c.header('X-Content-Type-Options', 'nosniff');

    if (format === 'json') {
      c.header('Content-Type', 'application/json; charset=utf-8');
      return stream(c, async (s) => {
        await s.write(`{"database":${JSON.stringify({ id: database.id, name: database.name })},`);
        await s.write(`"exportedAt":${JSON.stringify(new Date().toISOString())},`);
        await s.write(`"tableCount":${String(tables.length)},"tables":{`);
        let firstTable = true;
        for (const t of tables) {
          await s.write(`${firstTable ? '' : ','}${JSON.stringify(t.name)}:[`);
          firstTable = false;
          let firstRow = true;
          try {
            await service.streamTableRows(id, t.name, async (rows) => {
              for (const r of rows) { await s.write(`${firstRow ? '' : ','}${JSON.stringify(r)}`); firstRow = false; }
            }, tenantId);
          } catch (err) {
            logger.warn({ dbId: id, table: t.name, err: err instanceof Error ? err.message : String(err) }, '[db-studio.backup] tabella saltata');
          }
          await s.write(']');
        }
        await s.write('}}');
      });
    }

    // format === 'sql' — dump ripristinabile.
    c.header('Content-Type', 'application/sql; charset=utf-8');
    return stream(c, async (s) => {
      await s.write(`-- FlowForge backup SQL\n-- database: ${database.name}\n-- exported: ${new Date().toISOString()}\n-- tables: ${String(tables.length)}\n`);
      for (const t of tables) {
        await s.write(`\n-- ─── Tabella: ${t.name} ───\n`);
        await s.write(`${createTableStatement(t.name, t.columns)}\n`);
        const colNames = t.columns.map((col) => col.name);
        if (colNames.length === 0) continue; // niente colonne note → solo DDL placeholder
        try {
          await service.streamTableRows(id, t.name, async (rows) => {
            const lines = rows.map((r) => insertStatement(t.name, colNames, r)).join('\n');
            if (lines.length > 0) await s.write(`${lines}\n`);
          }, tenantId);
        } catch (err) {
          await s.write(`-- (errore lettura righe di ${t.name}: tabella saltata)\n`);
          logger.warn({ dbId: id, table: t.name, err: err instanceof Error ? err.message : String(err) }, '[db-studio.backup] tabella saltata');
        }
      }
    });
  });

  app.post('/databases/:id/insert', zValidator('json', InsertRequestSchema), async (c) => {
    if (isWorkspaceReadOnly()) return c.json(readOnlyBody(), 423);
    const tenantId = getTenantId(c);
    try {
      const { table, row } = c.req.valid('json');
      const result = await service.insert(c.req.param('id'), table, row, tenantId);
      return c.json(result);
    } catch (error) {
      return sanitizedErrorResponse(c, error, {
        code: 'DB_INSERT_FAILED',
        userMessage: 'Insert riga fallita — verifica constraint e tipi',
        logContext: { op: 'db-studio.insert', dbId: c.req.param('id') },
      });
    }
  });

  // Atomic batch — header + N children in one transaction. See
  // db-studio.service.ts#transaction and engine BatchOp definition.
  const BatchOpSchema = z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('insert'),
      table: z.string().min(1),
      row: z.record(z.string(), z.unknown()),
      as: z.string().optional(),
    }),
    z.object({
      kind: z.literal('insertMany'),
      table: z.string().min(1),
      rows: z.array(z.record(z.string(), z.unknown())),
      refColumn: z.string().optional(),
      refFrom: z.string().optional(),
    }),
  ]);
  const BatchRequestSchema = z.object({ ops: z.array(BatchOpSchema).min(1).max(500) });

  app.post('/databases/:id/transaction', zValidator('json', BatchRequestSchema), async (c) => {
    if (isWorkspaceReadOnly()) return c.json(readOnlyBody(), 423);
    const tenantId = getTenantId(c);
    try {
      const { ops } = c.req.valid('json');
      const result = await service.transaction(c.req.param('id'), ops, tenantId);
      return c.json(result);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'BATCH_UNSUPPORTED') {
        return sanitizedErrorResponse(c, error, {
          code: 'BATCH_UNSUPPORTED',
          status: 405,
          userMessage: 'Operazione batch non supportata da questo adapter',
          logContext: { op: 'db-studio.transaction', dbId: c.req.param('id') },
        });
      }
      return sanitizedErrorResponse(c, error, {
        code: 'DB_TRANSACTION_FAILED',
        userMessage: 'Transazione atomica fallita — rollback eseguito',
        logContext: { op: 'db-studio.transaction', dbId: c.req.param('id') },
      });
    }
  });

  const UpdateRowSchema = z.object({
    table: z.string().min(1),
    where: z.record(z.string(), z.unknown()),
    patch: z.record(z.string(), z.unknown()),
  });

  app.post('/databases/:id/update', zValidator('json', UpdateRowSchema), async (c) => {
    if (isWorkspaceReadOnly()) return c.json(readOnlyBody(), 423);
    const tenantId = getTenantId(c);
    try {
      const { table, where, patch } = c.req.valid('json');
      const result = await service.updateRow(c.req.param('id'), table, where, patch, tenantId);
      return c.json(result);
    } catch (error) {
      return sanitizedErrorResponse(c, error, {
        code: 'DB_UPDATE_FAILED',
        userMessage: 'Update riga fallita — verifica filtro WHERE e tipi patch',
        logContext: { op: 'db-studio.update', dbId: c.req.param('id') },
      });
    }
  });

  const DeleteRowSchema = z.object({
    table: z.string().min(1),
    where: z.record(z.string(), z.unknown()),
  });

  app.post('/databases/:id/delete', zValidator('json', DeleteRowSchema), async (c) => {
    if (isWorkspaceReadOnly()) return c.json(readOnlyBody(), 423);
    const tenantId = getTenantId(c);
    try {
      const { table, where } = c.req.valid('json');
      const result = await service.deleteRow(c.req.param('id'), table, where, tenantId);
      return c.json(result);
    } catch (error) {
      return sanitizedErrorResponse(c, error, {
        code: 'DB_DELETE_FAILED',
        userMessage: 'Delete riga fallita — verifica filtro WHERE',
        logContext: { op: 'db-studio.delete', dbId: c.req.param('id') },
      });
    }
  });

  app.post('/databases/:id/auto-embed', zValidator('json', AutoEmbedSchema), async (c) => {
    // Write-path che FA CRESCERE i vettori → gate read-only come ingest-text/upsert
    // (un tenant in disk over-quota grace non deve crescere via auto-embed bulk).
    if (isWorkspaceReadOnly()) {
      return c.json(
        { error: 'Workspace in sola lettura (spazio disco oltre il limite): indicizzazione bloccata. Riduci i dati o riattiva un piano.', code: 'WORKSPACE_READ_ONLY' },
        423,
      );
    }
    const tenantId = getTenantId(c);
    const sourceId = c.req.param('id');
    if (!sourceId) return c.json({ error: 'Bad request' }, 400);
    const body = c.req.valid('json');

    const vector = new VectorService();
    const dimensions = dimensionsForModel(body.model);

    try {
      const queryResult = await service.query(
        sourceId,
        { table: body.sourceTable, filters: [], orderBy: [], limit: body.limit },
        tenantId,
      ) as { rows: Record<string, unknown>[] };

      const rows = queryResult.rows;
      if (rows.length === 0) {
        return c.json({ ok: true, indexed: 0, skipped: 0, message: 'Tabella vuota — nessun record indicizzato.' });
      }

      // QUOTA: proiezione AGGREGATA per-tenant prima di scrivere — l'auto-embed NON
      // deve aggirare il limite del piano (lo fa il path single ingestText). Risposta
      // PULITA 413 (non mascherata dal catch generico) col motivo, così l'utente sa
      // che deve ridurre i dati / fare upgrade.
      try {
        await assertBulkQuota(tenantId, rows.length, body.model, vectorPlanLimitsFromConfig(), vector);
      } catch (quotaErr) {
        return c.json(
          { error: quotaErr instanceof Error ? quotaErr.message : String(quotaErr), code: 'VECTOR_QUOTA_EXCEEDED' },
          413,
        );
      }

      // ensureCollection DOPO il gate quota (no collezione fantasma su batch rifiutato).
      await vector.ensureCollection(body.targetDatabaseId, body.targetCollection, dimensions, body.distance, tenantId);

      const embedReq = {
        provider: body.provider,
        model: body.model,
        ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {}),
        ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
      };

      let indexed = 0;
      let skipped = 0;
      const errors: string[] = [];
      const batchSize = 50;

      for (let i = 0; i < rows.length; i += batchSize) {
        const slice = rows.slice(i, i + batchSize);
        const records: { id: string; vector: number[]; payload: Record<string, unknown> }[] = [];

        for (const row of slice) {
          const idValue = row[body.idColumn];
          if (idValue === undefined || idValue === null || idValue === '') {
            skipped++;
            continue;
          }
          const id = cellToText(idValue);

          const textParts = body.textColumns
            .map((col) => cellToText(row[col]))
            .filter((s) => s.trim() !== '');

          if (textParts.length === 0) {
            skipped++;
            continue;
          }

          const text = textParts.join('\n\n');

          // SICUREZZA: riga avvelenata (prompt-injection ad alta confidenza) → NON
          // indicizzata (hard-block), coerente col path single ingestText. Difesa in
          // profondità oltre al framing al retrieval. La riga è saltata, non aborta il batch.
          const scan = scanForInjection(text);
          if (!scan.safe) {
            skipped++;
            errors.push(`row ${id}: bloccata (prompt-injection: ${scan.reasons.join(', ')})`);
            continue;
          }

          const payload: Record<string, unknown> = { _source_table: body.sourceTable, _source_id: id };
          const payloadCols = body.payloadColumns ?? Object.keys(row);
          for (const col of payloadCols) {
            if (row[col] !== undefined) payload[col] = row[col];
          }

          try {
            const vec = await embedText({ ...embedReq, text });
            records.push({ id: `${body.sourceTable}:${id}`, vector: vec, payload });
          } catch (err) {
            errors.push(`row ${id}: ${err instanceof Error ? err.message : String(err)}`);
            skipped++;
          }
        }

        if (records.length > 0) {
          await vector.upsert(body.targetDatabaseId, body.targetCollection, records, tenantId);
          indexed += records.length;
        }
      }

      logger.info(
        { tenantId, sourceId, sourceTable: body.sourceTable, indexed, skipped },
        'Auto-embed completed',
      );

      const response: { ok: true; indexed: number; skipped: number; total: number; dimensions: number; errors?: string[] } = {
        ok: true,
        indexed,
        skipped,
        total: rows.length,
        dimensions,
      };
      if (errors.length > 0) response.errors = errors.slice(0, 10);
      return c.json(response);
    } catch (error) {
      return sanitizedErrorResponse(c, error, {
        code: 'DB_AUTO_EMBED_FAILED',
        userMessage: 'Auto-embedding fallito — verifica modello e source',
        logContext: { op: 'db-studio.auto-embed', sourceId, body },
      });
    }
  });

  /**
   * POST /databases/:id/tables/:name/truncate — svuota una singola tabella
   * (DELETE FROM table). Operazione DISTRUTTIVA: richiede il body
   * `{ confirm: '<table-name>' }` come second-step acknowledgement.
   *
   * Tenant-isolated via service layer. Niente DROP, niente schema change.
   * Federico-grade: no shortcuts, no rm -rf da remote.
   */
  /**
   * GET /databases/:id/tables/:name/truncate-preview — analisi pre-truncate.
   * Ritorna info FK-aware per decidere in sicurezza:
   *   - rowCount: quante righe verranno cancellate
   *   - referencedBy: tabelle che hanno FK su QUESTA (svuotando, future
   *     INSERT su QUELLE falliranno se il valore non esiste qui)
   *   - references: tabelle a cui QUESTA punta (informativo)
   *
   * Federico-grade: l'utente VEDE l'impatto PRIMA di confermare. Per
   * tabelle "master/lookup" (referenced_by != []) mostriamo un warning
   * forte: svuotare suppliers significa rompere orders, invoices, …
   *
   * Implementazione CROSS-DIALECT (fix 2026-06-15): la logica vive nel service
   * (truncatePreview) e usa countRows + introspectRelations — funziona su
   * SQLite/Postgres/MySQL/MSSQL. Prima era SQLite-only (PRAGMA + sqlite_master)
   * → per i sidecar managed il preview FK falliva e si truncava alla cieca.
   */
  app.get('/databases/:id/tables/:name/truncate-preview', async (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const tableName = c.req.param('name');
    if (!id || !tableName) return c.json({ error: 'Bad request' }, 400);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
      return c.json({ error: 'Nome tabella non valido', code: 'INVALID_TABLE_NAME' }, 400);
    }
    try {
      const preview = await service.truncatePreview(id, tableName, tenantId);
      return c.json(preview);
    } catch (error) {
      return sanitizedErrorResponse(c, error, {
        code: 'DB_TABLE_PREVIEW_FAILED',
        userMessage: 'Preview tabella fallita — schema illegibile o adapter non supportato',
        logContext: { op: 'db-studio.table.preview', dbId: c.req.param('id'), table: c.req.param('name') },
      });
    }
  });

  app.post('/databases/:id/tables/:name/truncate', async (c) => {
    if (isWorkspaceReadOnly()) return c.json(readOnlyBody(), 423);
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const tableName = c.req.param('name');
    if (!id || !tableName) return c.json({ error: 'Bad request' }, 400);
    let body: { confirm?: string } = {};
    try { body = await c.req.json<{ confirm?: string }>(); } catch { /* empty body ok if confirm wrong */ }
    if (body.confirm !== tableName) {
      return c.json({
        error: `Conferma mancante. Per svuotare la tabella "${tableName}" il body deve contenere {"confirm": "${tableName}"}.`,
        code: 'CONFIRM_MISMATCH',
      }, 400);
    }
    // Sanity: tableName deve essere SQL-safe (no spazi, no quote, no ';')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
      return c.json({ error: 'Nome tabella non valido', code: 'INVALID_TABLE_NAME' }, 400);
    }
    try {
      const result = await service.executeRaw(id, `DELETE FROM "${tableName}"`, { dryRun: false, rowLimit: 0 }, tenantId);
      logger.warn({ tenantId, dbId: id, tableName, result }, 'DB Studio: TRUNCATE table executed');
      const resultObj = (result && typeof result === 'object') ? result as Record<string, unknown> : {};
      return c.json({ ok: true, table: tableName, ...resultObj });
    } catch (error) {
      return sanitizedErrorResponse(c, error, {
        code: 'DB_TRUNCATE_FAILED',
        userMessage: 'TRUNCATE tabella fallita — verifica permessi e constraint FK',
        logContext: { op: 'db-studio.truncate', dbId: id, tableName },
      });
    }
  });

  app.post('/databases/:id/sql', zValidator('json', RawSqlSchema), async (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'Bad request' }, 400);
    const { sql, dryRun, rowLimit } = c.req.valid('json');
    // Read-only: blocca SOLO le scritture reali. SELECT/EXPLAIN e i dryRun
    // (preview, non scrivono) restano permessi anche in grace. classifyStatement
    // ripiega al kind PEGGIORE di un blob multi-statement (anti-CTE-bypass).
    if (isWorkspaceReadOnly() && !dryRun) {
      const kind = classifyStatement(sql);
      if (kind !== 'select' && kind !== 'explain') return c.json(readOnlyBody(), 423);
    }
    try {
      const result = await service.executeRaw(id, sql, { dryRun, rowLimit }, tenantId);
      return c.json(result);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'RAW_SQL_UNSUPPORTED') {
        return sanitizedErrorResponse(c, error, {
          code: 'RAW_SQL_UNSUPPORTED',
          status: 405,
          userMessage: 'Raw SQL non supportato per questo adapter',
          logContext: { op: 'db-studio.raw-sql', dbId: id },
        });
      }
      return sanitizedErrorResponse(c, error, {
        code: 'DB_SQL_EXEC_FAILED',
        userMessage: 'Esecuzione SQL fallita — verifica syntax',
        logContext: { op: 'db-studio.raw-sql', dbId: id, sqlPreview: sql.slice(0, 100) },
      });
    }
  });

  app.get('/databases/:id/introspect', async (c) => {
    const tenantId = getTenantId(c);
    try {
      const tables = await service.introspect(c.req.param('id'), tenantId);
      return c.json({ tables });
    } catch (error) {
      return sanitizedErrorResponse(c, error, {
        code: 'DB_INTROSPECT_FAILED',
        userMessage: 'Introspezione schema fallita',
        logContext: { op: 'db-studio.introspect', dbId: c.req.param('id') },
      });
    }
  });

  // Foreign key reali del DB (per l'ER diagram). Tenant-scoped via getTenantId.
  app.get('/databases/:id/relations', async (c) => {
    const tenantId = getTenantId(c);
    try {
      const relations = await service.introspectRelations(c.req.param('id'), tenantId);
      return c.json({ relations });
    } catch (error) {
      return sanitizedErrorResponse(c, error, {
        code: 'DB_RELATIONS_FAILED',
        userMessage: 'Lettura foreign key fallita',
        logContext: { op: 'db-studio.relations', dbId: c.req.param('id') },
      });
    }
  });

  return app;
}
