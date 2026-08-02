/**
 * Contract test — db_update / db_delete (executor) ↔ db-studio REST endpoints.
 *
 * I nodi db_update/db_delete chiamano endpoint del servizio db-studio via callDb.
 * Un commento STANTIO sosteneva che gli endpoint "non esistono ancora" → questo
 * test pinna il contratto REALE (path + schema + mount) così che se qualcuno
 * rimuove/rinomina l'endpoint o cambia i campi, il test si rompe SUBITO invece di
 * lasciare il nodo a chiamare nel vuoto in silenzio.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbUpdateExecutor, dbDeleteExecutor } from './db-write.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(__dirname, rel), 'utf-8');

const dbWriteSrc = read('./db-write.ts');
const dbStudioSrc = read('../routes/db-studio.ts');
const serverSrc = read('../server.ts');

describe('contratto db-write ↔ db-studio', () => {
  it('callDb instrada su /api/v1/db (montato in server.ts)', () => {
    expect(dbWriteSrc).toMatch(/\$\{RUNTIME_BASE\}\/api\/v1\/db\$\{path\}/);
    expect(serverSrc).toMatch(
      /app\.route\(\s*['"]\/api\/v1\/db['"]\s*,\s*createDbStudioRoutes\(\)\s*\)/,
    );
  });

  it("db_update chiama /databases/:id/update e l'endpoint ESISTE con schema {table,where,patch}", () => {
    // databaseId vincolato (assertDatabaseId) + encodeURIComponent prima del path.
    expect(dbWriteSrc).toMatch(
      /callDb\(\s*`\/databases\/\$\{encodeURIComponent\(assertDatabaseId\(databaseId, 'db_update'\)\)\}\/update`/,
    );
    expect(dbStudioSrc).toMatch(/app\.post\(\s*['"]\/databases\/:id\/update['"]/);
    // schema deve accettare esattamente i campi inviati dal nodo
    const updateSchema = /UpdateRowSchema = z\.object\(\{([\s\S]*?)\}\)/.exec(dbStudioSrc);
    expect(updateSchema, 'UpdateRowSchema non trovato').toBeTruthy();
    for (const field of ['table', 'where', 'patch']) {
      expect(updateSchema![1]).toContain(field);
    }
  });

  it("db_delete chiama /databases/:id/delete e l'endpoint ESISTE con schema {table,where}", () => {
    expect(dbWriteSrc).toMatch(
      /callDb\(\s*`\/databases\/\$\{encodeURIComponent\(assertDatabaseId\(databaseId, 'db_delete'\)\)\}\/delete`/,
    );
    expect(dbStudioSrc).toMatch(/app\.post\(\s*['"]\/databases\/:id\/delete['"]/);
    const deleteSchema = /DeleteRowSchema = z\.object\(\{([\s\S]*?)\}\)/.exec(dbStudioSrc);
    expect(deleteSchema, 'DeleteRowSchema non trovato').toBeTruthy();
    for (const field of ['table', 'where']) {
      expect(deleteSchema![1]).toContain(field);
    }
  });

  it('niente più debt-marker bugiardo "no /update REST endpoint yet"', () => {
    expect(dbWriteSrc).not.toMatch(/no \/update REST endpoint yet|will be implemented/);
  });

  it('gli endpoint update/delete sono tenant-scoped (passano tenantId al service)', () => {
    expect(dbStudioSrc).toMatch(/service\.updateRow\(.*tenantId\)/);
    expect(dbStudioSrc).toMatch(/service\.deleteRow\(.*tenantId\)/);
  });
});

describe('🚨🚨 db-write — path-injection su databaseId (verso API interna con X-Internal-Token)', () => {
  const ctx = {
    tenantId: 't1',
    runId: 'r',
    workflowId: 'w',
    nodeId: 'n',
    secrets: {},
    llmProviders: [],
    nodeOutputs: {},
  } as never;
  // databaseId ostile → assertDatabaseId lancia durante la costruzione del path,
  // PRIMA di qualsiasi fetch (nessun mock necessario: il throw precede callDb).
  for (const bad of ['../../internal/secrets', 'a/b', 'x%2e%2e', 'id?admin=1', 'a'.repeat(129)]) {
    it(`db_update rifiuta databaseId "${bad.slice(0, 24)}…"`, async () => {
      await expect(
        dbUpdateExecutor(
          { databaseId: bad, table: 't', whereJson: '{"id":1}', patchJson: '{"x":1}' } as never,
          null as never,
          ctx,
        ),
      ).rejects.toThrow(/databaseId non valido/u);
    });
    it(`db_delete rifiuta databaseId "${bad.slice(0, 24)}…"`, async () => {
      await expect(
        dbDeleteExecutor(
          { databaseId: bad, table: 't', whereJson: '{"id":1}', confirmDelete: true } as never,
          null as never,
          ctx,
        ),
      ).rejects.toThrow(/databaseId non valido/u);
    });
  }
});
