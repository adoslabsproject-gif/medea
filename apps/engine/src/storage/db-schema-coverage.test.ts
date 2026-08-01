/**
 * DB SCHEMA-COVERAGE — il "test coverage" del database.
 *
 * Problema risolto (incident dashboard 500, 2026-06-04): una query con colonna
 * fantasma (`workflows.deleted_at` inesistente) è andata in PROD perché nessun
 * test la eseguiva contro lo schema REALE — il test della route mockava il DB.
 *
 * Il gate, in due livelli:
 *   1. Costruisce lo schema REALE in :memory: = `runMigrations()` + tutte le
 *      CREATE inline lazy + tutti gli ALTER ADD COLUMN evolutivi sparsi nei service.
 *   2a. Query STATICHE — ogni `.prepare('SELECT …')` senza interpolazione è
 *       preparata contro lo schema reale. `no such column/table` → build rosso.
 *   2b. Query DINAMICHE — ogni `.prepare(`… ${x} …`)` è risolta da
 *       `resolveDynamicSql`, che neutralizza i frammenti runtime e valida la
 *       parte statica (tabella + colonne SELECT/WHERE/ORDER BY). NESSUNA query
 *       viene più saltata in silenzio: una forma dinamica non gestita è
 *       `irreducible` e fa fallire il gate (anti-erosione).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectTsFiles,
  extractPreparedSql,
  extractCreateTables,
  extractAddColumns,
  resolveDynamicSql,
} from './__testkit__/sql-coverage.js';
import { EXPORT_TABLES } from '../routes/backup.js';

// Schema reale costruito da runMigrations() su questo DB in-memory.
const db = new Database(':memory:');

vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: db }) }));
vi.mock('@/lib/logger.js');

const { runMigrations } = await import('./migrate.js');

const HERE = dirname(fileURLToPath(import.meta.url)); // .../src/storage
const SRC_ROOT = join(HERE, '..'); // .../src

/** Solo gli errori di SCHEMA-DRIFT ci interessano (no sintassi parziale / multi-stmt). */
const isSchemaDrift = (msg: string): boolean => /no such column|no such table/i.test(msg);

describe('DB schema-coverage — ogni query prepara contro lo schema REALE', () => {
  beforeAll(() => {
    // Schema completo = runMigrations() (core) + tabelle LAZY-CREATE sparse nei
    // moduli (workflow_memory, wait_states, …) + ALTER ADD COLUMN evolutivi.
    runMigrations();
    const files = collectTsFiles(SRC_ROOT);
    for (const file of files) {
      for (const create of extractCreateTables(readFileSync(file, 'utf8'))) {
        try { db.exec(create); } catch { /* IF NOT EXISTS idempotente / FK forward-ref → ok */ }
      }
    }
    for (const file of files) {
      for (const { table, col } of extractAddColumns(readFileSync(file, 'utf8'))) {
        try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`); } catch { /* colonna/tabella già gestita → ok */ }
      }
    }
  });

  it('zero schema-drift nelle query STATICHE (.prepare senza interpolazione)', () => {
    const failures: string[] = [];
    let staticCount = 0;

    for (const file of collectTsFiles(SRC_ROOT)) {
      const src = readFileSync(file, 'utf8');
      for (const sql of extractPreparedSql(src)) {
        if (sql.includes('${')) continue; // dinamica → caso successivo
        const trimmed = sql.trim();
        if (!trimmed) continue;
        staticCount += 1;
        try {
          db.prepare(trimmed);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (isSchemaDrift(msg)) {
            failures.push(`${relative(SRC_ROOT, file)}: ${msg}\n    SQL: ${trimmed.slice(0, 120).replace(/\s+/g, ' ')}`);
          }
        }
      }
    }

     
    console.log(`[db-schema-coverage] static-validated=${String(staticCount)} failures=${String(failures.length)}`);
    expect(staticCount).toBeGreaterThan(100); // sanity: stiamo davvero scansionando
    expect(failures, `\nSchema-drift STATICO (colonna/tabella fantasma):\n${failures.join('\n')}\n`).toEqual([]);
  });

  it('zero schema-drift e zero buchi silenziosi nelle query DINAMICHE (${} risolto)', () => {
    const driftFailures: string[] = [];
    const irreducible: string[] = [];
    let dynamicCount = 0;
    let resolvedVariants = 0;
    let introspective = 0;

    for (const file of collectTsFiles(SRC_ROOT)) {
      const src = readFileSync(file, 'utf8');
      for (const sql of extractPreparedSql(src)) {
        if (!sql.includes('${')) continue; // statica → caso precedente
        if (!sql.trim()) continue;
        dynamicCount += 1;

        const res = resolveDynamicSql(sql, EXPORT_TABLES);
        if (res.kind === 'introspective') { introspective += 1; continue; }
        if (res.kind === 'irreducible') {
          irreducible.push(`${relative(SRC_ROOT, file)}: ${res.reason}`);
          continue;
        }
        for (const variant of res.variants) {
          resolvedVariants += 1;
          try {
            db.prepare(variant);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (isSchemaDrift(msg)) {
              driftFailures.push(`${relative(SRC_ROOT, file)}: ${msg}\n    SQL: ${variant.slice(0, 120)}`);
            }
          }
        }
      }
    }

     
    console.log(`[db-schema-coverage] dynamic=${String(dynamicCount)} resolved-variants=${String(resolvedVariants)} introspective=${String(introspective)} irreducible=${String(irreducible.length)} drift=${String(driftFailures.length)}`);

    // Anti-erosione: ogni dinamica DEVE essere resolved o introspective. Una forma
    // nuova non gestita compare qui e blocca il merge → niente skip di nascosto.
    expect(irreducible, `\nQuery dinamiche NON risolte (aggiungi una regola a resolveDynamicSql):\n${irreducible.join('\n')}\n`).toEqual([]);
    expect(driftFailures, `\nSchema-drift DINAMICO (colonna/tabella fantasma nella parte statica):\n${driftFailures.join('\n')}\n`).toEqual([]);
    expect(dynamicCount).toBeGreaterThan(0); // sanity: il caso dinamico esiste davvero
  });
});
