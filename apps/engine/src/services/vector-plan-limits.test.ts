/**
 * CONTRATTO Inc.6 — vectorPlanLimitsFromConfig: precedenza override LIVE > env.
 *
 * Il cuore dell'up/downgrade vettoriale: quando il portal SPINGE i nuovi limiti
 * (POST /internal/workspace/vector-quota → setVectorQuotaOverride), l'enforcement al
 * rag_ingest DEVE usarli SUBITO, scavalcando l'env del container (che si aggiorna solo
 * al recreate). Qui: sqlite reale per il flag, loadConfig mockato per l'env, e verifico
 * che la precedenza sia quella giusta — incluso il caso override=illimitato (null) che
 * deve battere un env CON limite (upgrade a Enterprise senza recreate).
 */
import type * as ConfigNS from '@/config.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const sqlite = new Database(':memory:');
sqlite.exec(
  `CREATE TABLE system_flags (key TEXT PRIMARY KEY, value TEXT NOT NULL,
     updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));`,
);

const cfg = { MEDEA_PLAN_VECTOR_MAX_VECTORS: 1000 as number | undefined, MEDEA_PLAN_VECTOR_MAX_DISK_MB: 100 as number | undefined };

vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite }) }));
vi.mock('@/lib/logger.js');
// Preserva il modulo config reale (il logger del grafo importa `config`), override
// solo loadConfig per simulare i limiti env del piano.
vi.mock('@/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigNS>();
  return { ...actual, loadConfig: () => cfg };
});

import { vectorPlanLimitsFromConfig } from './vector-ingest.js';
import { setVectorQuotaOverride, __resetVectorQuotaCacheForTest } from './vector-quota-flag.service.js';

beforeEach(() => {
  sqlite.exec('DELETE FROM system_flags');
  __resetVectorQuotaCacheForTest();
  cfg.MEDEA_PLAN_VECTOR_MAX_VECTORS = 1000;
  cfg.MEDEA_PLAN_VECTOR_MAX_DISK_MB = 100;
});

describe('vectorPlanLimitsFromConfig — precedenza override > env', () => {
  it('nessun override → usa l\'env (limiti del provision)', () => {
    expect(vectorPlanLimitsFromConfig()).toEqual({ maxVectors: 1000, maxDiskMb: 100 });
  });

  it('env assente (Enterprise/BYOK) → illimitato', () => {
    cfg.MEDEA_PLAN_VECTOR_MAX_VECTORS = undefined;
    cfg.MEDEA_PLAN_VECTOR_MAX_DISK_MB = undefined;
    expect(vectorPlanLimitsFromConfig()).toEqual({ maxVectors: null, maxDiskMb: null });
  });

  it('DOWNGRADE: override più basso dell\'env → vince l\'override (effetto immediato)', () => {
    setVectorQuotaOverride({ maxVectors: 50, maxDiskMb: 5 });
    expect(vectorPlanLimitsFromConfig()).toEqual({ maxVectors: 50, maxDiskMb: 5 });
  });

  it('UPGRADE a illimitato: override null batte un env CON limite (senza recreate)', () => {
    // env = piano vecchio con limite; override = nuovo piano Enterprise illimitato
    setVectorQuotaOverride({ maxVectors: null, maxDiskMb: null });
    expect(vectorPlanLimitsFromConfig()).toEqual({ maxVectors: null, maxDiskMb: null });
  });

  it('override sopravvive al "restart" (cache reset → rilegge da sqlite)', () => {
    setVectorQuotaOverride({ maxVectors: 200, maxDiskMb: 20 });
    __resetVectorQuotaCacheForTest();
    expect(vectorPlanLimitsFromConfig()).toEqual({ maxVectors: 200, maxDiskMb: 20 });
  });
});
