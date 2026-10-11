/**
 * Togliere una colonna a un database che esiste già.
 *
 * Le tabelle nascono con `CREATE TABLE IF NOT EXISTS`: su un database già
 * creato quella riga non fa niente, quindi togliere una colonna dalla
 * definizione non la toglie a chi ce l'ha. Senza questo passo i database
 * vecchi e quelli nuovi avrebbero forme diverse della stessa tabella, e la
 * differenza si scoprirebbe solo quando qualcosa ci inciampa.
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger.js');
vi.mock('./db.js', () => ({ getDatabase: vi.fn() }));

import { dropColumnIfPresent as togli } from './migrate.js';

/** Adatta better-sqlite3 all'interfaccia SqliteDb strutturale di migrate.ts. */
function dropColumnIfPresent(c: Database.Database, tabella: string, colonna: string): void {
  togli(
    {
      exec: (sql: string) => {
        c.exec(sql);
      },
      prepare: (sql: string) => {
        const stmt = c.prepare(sql);
        return {
          all: (...p: unknown[]) => stmt.all(...p),
          run: (...p: unknown[]) => stmt.run(...p),
        };
      },
    },
    tabella,
    colonna,
  );
}

function colonne(db: Database.Database, tabella: string): string[] {
  return (db.prepare(`PRAGMA table_info(${tabella})`).all() as { name: string }[]).map(
    (c) => c.name,
  );
}

function databaseVecchio(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE preferenze (
      tenant_id TEXT PRIMARY KEY,
      colonna_dismessa INTEGER NOT NULL DEFAULT 1,
      default_llm_provider TEXT
    );
    INSERT INTO preferenze (tenant_id, colonna_dismessa, default_llm_provider)
    VALUES ('t1', 0, 'openai');
  `);
  return db;
}

describe('dropColumnIfPresent', () => {
  it('toglie la colonna e lascia intatte le righe', () => {
    const db = databaseVecchio();
    dropColumnIfPresent(db, 'preferenze', 'colonna_dismessa');

    expect(colonne(db, 'preferenze')).toEqual(['tenant_id', 'default_llm_provider']);
    expect(db.prepare('SELECT * FROM preferenze').all()).toEqual([
      { tenant_id: 't1', default_llm_provider: 'openai' },
    ]);
  });

  it('non fa niente se la colonna non c’è già più: si può chiamare a ogni avvio', () => {
    const db = databaseVecchio();
    dropColumnIfPresent(db, 'preferenze', 'colonna_dismessa');
    expect(() => {
      dropColumnIfPresent(db, 'preferenze', 'colonna_dismessa');
    }).not.toThrow();
    expect(colonne(db, 'preferenze')).toEqual(['tenant_id', 'default_llm_provider']);
  });

  it('non fa niente se la tabella non esiste', () => {
    const db = new Database(':memory:');
    expect(() => {
      dropColumnIfPresent(db, 'tabella_che_non_esiste', 'colonna');
    }).not.toThrow();
  });

  it('rifiuta nomi che non sono identificatori: finiscono dentro l’SQL', () => {
    const db = databaseVecchio();
    expect(() => {
      dropColumnIfPresent(db, 'preferenze; DROP TABLE preferenze', 'x');
    }).toThrow(/identificatore SQL/u);
    expect(() => {
      dropColumnIfPresent(db, 'preferenze', 'x; --');
    }).toThrow(/identificatore SQL/u);
    expect(colonne(db, 'preferenze')).toContain('colonna_dismessa');
  });
});
