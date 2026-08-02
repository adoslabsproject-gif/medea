/**
 * Bug-bounty test — listCustomNodeDefinitions (catalogo editor /custom-nodes/catalog).
 *
 * Proprietà inchiodate:
 *   1. ritorna SOLO i runnable (published_priv / marketplace_published /
 *      marketplace_pending) col `sourceDefinition` — draft/candidate/archived ESCLUSI;
 *   2. 🔒 ISOLAMENTO multi-tenant: mai righe di un altro workspace;
 *   3. 🔒 NON trapela l'executor (la entry non ha sourceExecutor/sourceSchema):
 *      l'endpoint è member-accessible, l'executor è codice — non deve uscire;
 *   4. workspace vuoto → [].
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import SqliteDatabase from 'better-sqlite3';
import { SCHEMA_SQL } from '@/storage/migrate.schema.js';

const dbConnections: ReturnType<typeof SqliteDatabase>[] = [];

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => {
    const conn = dbConnections[dbConnections.length - 1]!;
    return {
      sqlite: {
        prepare: (sql: string) => {
          const stmt = conn.prepare(sql);
          return {
            run: (...p: unknown[]) => stmt.run(...p),
            get: (...p: unknown[]) => stmt.get(...p),
            all: (...p: unknown[]) => stmt.all(...p),
          };
        },
        exec: (sql: string) => {
          conn.exec(sql);
        },
      },
    };
  },
}));

import { listCustomNodeDefinitions } from './service.js';

let conn: SqliteDatabase.Database;

beforeEach(() => {
  conn = new SqliteDatabase(':memory:');
  conn.exec(SCHEMA_SQL);
  dbConnections.push(conn);
});
afterEach(() => {
  conn.close();
  dbConnections.pop();
});

function insertNode(opts: {
  id: string;
  ws: string;
  slug: string;
  status: string;
  definition?: string;
  executor?: string;
}): void {
  const at = new Date().toISOString();
  conn
    .prepare(
      `
    INSERT INTO custom_nodes (
      id, workspace_id, owner_user_id, slug, display_name, status, semver,
      source_executor, source_definition, source_schema, created_at, updated_at
    ) VALUES (?, ?, 'owner', ?, ?, ?, '1.0.0', ?, ?, 'schema', ?, ?)
  `,
    )
    .run(
      opts.id,
      opts.ws,
      opts.slug,
      `Node ${opts.slug}`,
      opts.status,
      opts.executor ?? 'SECRET_EXECUTOR_CODE',
      opts.definition ?? 'export const d = {};',
      at,
      at,
    );
}

describe('🚨 listCustomNodeDefinitions', () => {
  it('ritorna i RUNNABLE col sourceDefinition; esclude draft/candidate/archived', () => {
    insertNode({
      id: '1',
      ws: 'ws-A',
      slug: 'pub',
      status: 'published_priv',
      definition: 'export const d = { configFields: [] };',
    });
    insertNode({ id: '2', ws: 'ws-A', slug: 'mkt', status: 'marketplace_published' });
    insertNode({ id: '3', ws: 'ws-A', slug: 'pending', status: 'marketplace_pending' });
    insertNode({ id: '4', ws: 'ws-A', slug: 'draft', status: 'draft' });
    insertNode({ id: '5', ws: 'ws-A', slug: 'cand', status: 'candidate' });
    insertNode({ id: '6', ws: 'ws-A', slug: 'arch', status: 'archived' });

    const out = listCustomNodeDefinitions('ws-A');
    expect(out.map((d) => d.slug).sort()).toEqual(['mkt', 'pending', 'pub']);
    const pub = out.find((d) => d.slug === 'pub')!;
    expect(pub.sourceDefinition).toContain('configFields');
  });

  it('🔒 ISOLAMENTO: non ritorna righe di un altro workspace', () => {
    insertNode({ id: '1', ws: 'ws-A', slug: 'mine', status: 'published_priv' });
    insertNode({ id: '2', ws: 'ws-B', slug: 'theirs', status: 'published_priv' });
    const out = listCustomNodeDefinitions('ws-A');
    expect(out.map((d) => d.slug)).toEqual(['mine']);
  });

  it("🔒 NON trapela l'executor (nessun campo sourceExecutor/sourceSchema nella entry)", () => {
    insertNode({
      id: '1',
      ws: 'ws-A',
      slug: 'pub',
      status: 'published_priv',
      executor: 'STEAL_SECRETS()',
    });
    const out = listCustomNodeDefinitions('ws-A');
    const entry = out[0]!;
    expect(entry).not.toHaveProperty('sourceExecutor');
    expect(entry).not.toHaveProperty('sourceSchema');
    expect(JSON.stringify(entry)).not.toContain('STEAL_SECRETS');
  });

  it('workspace senza custom node → []', () => {
    expect(listCustomNodeDefinitions('ws-empty')).toEqual([]);
  });
});
