/**
 * vector-quota-flag.service — test su SQLite REALE (:memory:): persistenza, cache,
 * precedenza, parse robusto, fail-open. È il valore che l'enforcement della quota
 * (rag_ingest/ingest-text/auto-embed) si fida sia corretto → niente smoke.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const sqlite = new Database(':memory:');
sqlite.exec(
  `CREATE TABLE system_flags (key TEXT PRIMARY KEY, value TEXT NOT NULL,
     updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));`,
);

const m = vi.hoisted(() => ({ recordFailOpen: vi.fn() }));
vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite }) }));
vi.mock('@/lib/logger.js');
vi.mock('@/lib/fail-open-metrics.js', () => ({ recordFailOpen: m.recordFailOpen }));

import {
  getVectorQuotaOverride,
  setVectorQuotaOverride,
  __resetVectorQuotaCacheForTest,
} from './vector-quota-flag.service.js';

beforeEach(() => {
  sqlite.exec('DELETE FROM system_flags');
  __resetVectorQuotaCacheForTest();
  m.recordFailOpen.mockClear();
});

describe('vector-quota-flag — persistenza + cache', () => {
  it('default (nessun flag) → null (nessun override → si usa env)', () => {
    expect(getVectorQuotaOverride()).toBeNull();
  });

  it('set → persistito in sqlite + sopravvive al "restart" (cache reset)', () => {
    setVectorQuotaOverride({ maxVectors: 500, maxDiskMb: 50 });
    __resetVectorQuotaCacheForTest(); // simula restart: rilegge dal disco
    expect(getVectorQuotaOverride()).toEqual({ maxVectors: 500, maxDiskMb: 50 });
    const row = sqlite.prepare('SELECT value FROM system_flags WHERE key = ?').get('vector_quota_override') as { value: string };
    expect(JSON.parse(row.value)).toEqual({ maxVectors: 500, maxDiskMb: 50 });
  });

  it('upsert idempotente: secondo set sovrascrive (downgrade dopo upgrade)', () => {
    setVectorQuotaOverride({ maxVectors: 100000, maxDiskMb: null }); // upgrade
    setVectorQuotaOverride({ maxVectors: 100, maxDiskMb: 10 });       // downgrade
    __resetVectorQuotaCacheForTest();
    expect(getVectorQuotaOverride()).toEqual({ maxVectors: 100, maxDiskMb: 10 });
    expect(sqlite.prepare('SELECT COUNT(*) c FROM system_flags').get()).toEqual({ c: 1 });
  });

  it('null = illimitato (override ESPLICITO a nessun limite, distinto da "non impostato")', () => {
    setVectorQuotaOverride({ maxVectors: null, maxDiskMb: null });
    __resetVectorQuotaCacheForTest();
    // override presente ma illimitato → oggetto con null, NON null (che sarebbe "usa env")
    expect(getVectorQuotaOverride()).toEqual({ maxVectors: null, maxDiskMb: null });
  });

  it('cache: dopo set NON serve query (stesso valore senza rileggere)', () => {
    setVectorQuotaOverride({ maxVectors: 7, maxDiskMb: 7 });
    // cancello la riga ma NON resetto la cache → deve restituire ancora il cached
    sqlite.exec('DELETE FROM system_flags');
    expect(getVectorQuotaOverride()).toEqual({ maxVectors: 7, maxDiskMb: 7 });
  });
});

describe('vector-quota-flag — parse robusto (fail-open)', () => {
  it('JSON corrotto → null (fail-open, usa env), nessun throw, ma STRUMENTATO', () => {
    sqlite.prepare("INSERT INTO system_flags (key, value) VALUES ('vector_quota_override', ?)").run('{not json');
    __resetVectorQuotaCacheForTest();
    expect(getVectorQuotaOverride()).toBeNull();
    // Un flag corrotto è anomalo → deve essere visibile (metrica), non silenzioso.
    expect(m.recordFailOpen).toHaveBeenCalledWith('vector_quota', expect.any(Error));
  });

  it('percorso normale (flag valido o assente) NON emette metrica fail-open', () => {
    setVectorQuotaOverride({ maxVectors: 10, maxDiskMb: 1 });
    __resetVectorQuotaCacheForTest();
    getVectorQuotaOverride();
    expect(m.recordFailOpen).not.toHaveBeenCalled();
  });

  it('il fail-open su DB.prepare che LANCIA è strumentato', () => {
    __resetVectorQuotaCacheForTest();
    const realPrepare = sqlite.prepare.bind(sqlite);
    const spy = vi.spyOn(sqlite, 'prepare').mockImplementationOnce(() => { throw new Error('db locked'); });
    expect(getVectorQuotaOverride()).toBeNull();
    expect(m.recordFailOpen).toHaveBeenCalledWith('vector_quota', expect.any(Error));
    spy.mockRestore();
    void realPrepare;
  });

  it('valore negativo o non-numerico → normalizzato a null (illimitato), non propaga spazzatura', () => {
    sqlite.prepare("INSERT INTO system_flags (key, value) VALUES ('vector_quota_override', ?)")
      .run(JSON.stringify({ maxVectors: -5, maxDiskMb: 'abc' }));
    __resetVectorQuotaCacheForTest();
    expect(getVectorQuotaOverride()).toEqual({ maxVectors: null, maxDiskMb: null });
  });

  it('chiave parziale (solo maxVectors) → l\'altra è null', () => {
    sqlite.prepare("INSERT INTO system_flags (key, value) VALUES ('vector_quota_override', ?)")
      .run(JSON.stringify({ maxVectors: 42 }));
    __resetVectorQuotaCacheForTest();
    expect(getVectorQuotaOverride()).toEqual({ maxVectors: 42, maxDiskMb: null });
  });
});
