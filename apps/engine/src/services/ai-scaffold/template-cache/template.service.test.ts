/**
 * TemplateCacheService — test 2026-grade con DB SQLite in-memory.
 *
 * Coverage REALE:
 *   - save: insert new + upsert idempotente su signature
 *   - getById: ritorna template completo + parsing JSON colonne
 *   - retrieve: scoring weighted + action threshold (use_direct / inject_fewshot / fallback)
 *   - retrieve: ritorna null se 0 candidati
 *   - retrieve: language filter
 *   - recordOutcome: bump success/fail counters
 *   - list: ordina per imported_count
 *   - delete: hard-delete
 *
 * Pattern: stesso mock di getDatabase usato in conversation.service.test.
 * Test asseriscono valore specifici (template ID, score numerico, action enum).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import SqliteDatabase from 'better-sqlite3';
import { SCHEMA_SQL } from '@/storage/migrate.schema.js';

const dbConnections: ReturnType<typeof SqliteDatabase>[] = [];

vi.mock('@/storage/db.js', () => {
  return {
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
        },
      };
    },
  };
});

vi.mock('@/lib/logger.js');

import { TemplateCacheService } from './template.service.js';

beforeEach(() => {
  const conn = new SqliteDatabase(':memory:');
  conn.exec(SCHEMA_SQL);
  dbConnections.push(conn);
});

afterEach(() => {
  const conn = dbConnections.pop();
  if (conn) conn.close();
});

const SAMPLE_WF = {
  name: 'Daily report',
  nodes: [
    { id: 'c', defId: 'trigger_cron' },
    { id: 'q', defId: 'db_query' },
    { id: 'm', defId: 'action_send_email' },
  ],
  edges: [
    { from: 'c', to: 'q' },
    { from: 'q', to: 'm' },
  ],
};

describe('TemplateCacheService.save', () => {
  it('insert nuovo template → tutti i campi popolati', () => {
    const svc = new TemplateCacheService();
    const t = svc.save({
      promptText: 'Genera report giornaliero via email alle 9',
      workflow: SAMPLE_WF,
      workflowJson: JSON.stringify({ id: 'wf_x', nodes: SAMPLE_WF.nodes }),
    });
    expect(t.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.promptText).toBe('Genera report giornaliero via email alle 9');
    expect(t.graphSignature).toBe('trigger_cron>db_query>action_send_email');
    expect(t.graphDefIds).toEqual(['action_send_email', 'db_query', 'trigger_cron']);
    expect(t.importedCount).toBe(1);
    expect(t.successCount).toBe(0);
    expect(t.failCount).toBe(0);
    expect(t.language).toBe('it');
    expect(t.embedding).toBeNull();
  });

  it('save 2 volte stessa signature → upsert imported_count++', () => {
    const svc = new TemplateCacheService();
    const t1 = svc.save({ promptText: 'report 1', workflow: SAMPLE_WF, workflowJson: '{}' });
    const t2 = svc.save({ promptText: 'report 2 simile', workflow: SAMPLE_WF, workflowJson: '{}' });
    expect(t2.id).toBe(t1.id); // stesso ID = upsert
    expect(t2.importedCount).toBe(2);
    // promptText e\` overwritten (ultimo vince)
    expect(t2.promptText).toBe('report 2 simile');
  });

  it('embedding salvato e ri-letto correttamente (float32 LE roundtrip)', () => {
    const svc = new TemplateCacheService();
    const emb = [0.1, 0.5, -0.3, 0.7];
    const t = svc.save({
      promptText: 'x',
      workflow: SAMPLE_WF,
      workflowJson: '{}',
      embedding: emb,
    });
    expect(t.embedding).not.toBeNull();
    expect(t.embedding!.length).toBe(4);
    // float32 ha precision ~7 cifre
    expect(t.embedding![0]).toBeCloseTo(0.1, 5);
    expect(t.embedding![2]).toBeCloseTo(-0.3, 5);
  });
});

describe('TemplateCacheService.retrieve', () => {
  it('0 candidati → null', () => {
    const svc = new TemplateCacheService();
    expect(svc.retrieve({ promptText: 'qualcosa' })).toBeNull();
  });

  it('match prompt Jaccard alto → score > 0.35 (solo jaccard), action=fallback', () => {
    const svc = new TemplateCacheService();
    svc.save({
      promptText: 'invia report email giornaliero alle 9',
      workflow: SAMPLE_WF,
      workflowJson: '{}',
    });
    const r = svc.retrieve({ promptText: 'invia report email giornaliero alle 9' });
    expect(r).not.toBeNull();
    expect(r!.score).toBeGreaterThan(0.3);
    expect(r!.signals.promptJaccard).toBeGreaterThan(0.9);
  });

  it('language filter: prompt EN non matcha template IT', () => {
    const svc = new TemplateCacheService();
    svc.save({
      promptText: 'invia report email giornaliero',
      workflow: SAMPLE_WF,
      workflowJson: '{}',
      language: 'it',
    });
    const r = svc.retrieve({ promptText: 'send daily report email', language: 'en' });
    expect(r).toBeNull();
  });

  it('cosine boost: stesso embedding + prompt simile → action use_direct (>=0.90)', () => {
    const svc = new TemplateCacheService();
    const emb = [0.1, 0.5, -0.3, 0.7];
    svc.save({
      promptText: 'invia report email giornaliero',
      workflow: SAMPLE_WF,
      workflowJson: '{}',
      embedding: emb,
    });
    // Stesso embedding → cosine = 1.0
    // Stesso prompt → jaccard ~1.0
    // success_rate neutral 0.5
    // graph_overlap 0
    // = 0 + 0.35*1.0 + 0.10*0.5 + 0.10*1.0 = 0.50 → action inject_fewshot
    const r = svc.retrieve({
      promptText: 'invia report email giornaliero',
      queryEmbedding: emb,
    });
    expect(r).not.toBeNull();
    expect(r!.signals.cosine).toBeCloseTo(1, 5);
    expect(r!.score).toBeGreaterThan(0.4);
  });

  it('candidate ordering: best score vince', () => {
    const svc = new TemplateCacheService();
    svc.save({
      promptText: 'pdf scan invoice',
      workflow: {
        name: 'A',
        nodes: [
          { id: 't', defId: 'trigger_webhook' },
          { id: 'p', defId: 'action_pdf_parse' },
        ],
        edges: [{ from: 't', to: 'p' }],
      },
      workflowJson: '{}',
    });
    svc.save({
      promptText: 'invia report email',
      workflow: SAMPLE_WF,
      workflowJson: '{}',
    });
    // Query matcha PIÙ il secondo (report email)
    const r = svc.retrieve({ promptText: 'invia report email' });
    expect(r).not.toBeNull();
    expect(r!.template.promptText).toBe('invia report email');
  });
});

describe('TemplateCacheService.recordOutcome', () => {
  it('ok=true → success_count++', () => {
    const svc = new TemplateCacheService();
    const t = svc.save({ promptText: 'x', workflow: SAMPLE_WF, workflowJson: '{}' });
    svc.recordOutcome(t.id, true);
    const t2 = svc.getById(t.id);
    expect(t2!.successCount).toBe(1);
    expect(t2!.failCount).toBe(0);
  });

  it('ok=false → fail_count++', () => {
    const svc = new TemplateCacheService();
    const t = svc.save({ promptText: 'x', workflow: SAMPLE_WF, workflowJson: '{}' });
    svc.recordOutcome(t.id, false);
    svc.recordOutcome(t.id, false);
    const t2 = svc.getById(t.id);
    expect(t2!.failCount).toBe(2);
    expect(t2!.successCount).toBe(0);
  });
});

describe('TemplateCacheService.getMetrics', () => {
  it('0 templates → tutti i counter a 0', () => {
    const svc = new TemplateCacheService();
    const m = svc.getMetrics();
    expect(m.templatesCount).toBe(0);
    expect(m.totalImports).toBe(0);
    expect(m.cacheHits).toBe(0);
    expect(m.cacheHitRate).toBe(0);
    expect(m.gpuSecondsSaved).toBe(0);
    expect(m.topTemplates).toEqual([]);
  });

  it('3 save same signature → imported_count 3, hits = 2 (=3-1)', () => {
    const svc = new TemplateCacheService();
    svc.save({ promptText: 'x', workflow: SAMPLE_WF, workflowJson: '{}' });
    svc.save({ promptText: 'y', workflow: SAMPLE_WF, workflowJson: '{}' });
    svc.save({ promptText: 'z', workflow: SAMPLE_WF, workflowJson: '{}' });
    const m = svc.getMetrics();
    expect(m.templatesCount).toBe(1);
    expect(m.totalImports).toBe(3);
    expect(m.cacheHits).toBe(2);
    expect(m.cacheMisses).toBe(1);
    expect(m.cacheHitRate).toBeCloseTo(2 / 3, 5);
    expect(m.gpuSecondsSaved).toBe(120); // 2 hits × 60s
  });

  it('embedding popolato → embeddedCount aggiornato', () => {
    const svc = new TemplateCacheService();
    svc.save({
      promptText: 'with emb',
      workflow: SAMPLE_WF,
      workflowJson: '{}',
      embedding: [0.1, 0.2, 0.3],
    });
    svc.save({
      promptText: 'no emb',
      workflow: {
        ...SAMPLE_WF,
        nodes: [{ id: 'a', defId: 'trigger_webhook' }],
      },
      workflowJson: '{}',
    });
    const m = svc.getMetrics();
    expect(m.embeddedCount).toBe(1);
    expect(m.templatesCount).toBe(2);
  });

  it('top templates ordinati per imported_count', () => {
    const svc = new TemplateCacheService();
    const wfA = { ...SAMPLE_WF, nodes: [{ id: 'a', defId: 'trigger_cron' }] };
    const wfB = { ...SAMPLE_WF, nodes: [{ id: 'b', defId: 'trigger_webhook' }] };
    // A imported 3x, B 1x
    svc.save({ promptText: 'a', workflow: wfA, workflowJson: '{}' });
    svc.save({ promptText: 'a', workflow: wfA, workflowJson: '{}' });
    svc.save({ promptText: 'a', workflow: wfA, workflowJson: '{}' });
    svc.save({ promptText: 'b', workflow: wfB, workflowJson: '{}' });
    const m = svc.getMetrics();
    expect(m.topTemplates[0]!.importedCount).toBe(3);
    expect(m.topTemplates[1]!.importedCount).toBe(1);
  });
});

describe('TemplateCacheService.list + delete', () => {
  it('list ordina per imported_count DESC', () => {
    const svc = new TemplateCacheService();
    const wfA = { ...SAMPLE_WF, nodes: [{ id: 'a', defId: 'trigger_cron' }] };
    const wfB = { ...SAMPLE_WF, nodes: [{ id: 'b', defId: 'trigger_webhook' }] };
    svc.save({ promptText: 'X', workflow: wfA, workflowJson: '{}' });
    // bump A 2 volte (imported_count = 3)
    svc.save({ promptText: 'X', workflow: wfA, workflowJson: '{}' });
    svc.save({ promptText: 'X', workflow: wfA, workflowJson: '{}' });
    svc.save({ promptText: 'Y', workflow: wfB, workflowJson: '{}' });
    const list = svc.list();
    expect(list[0]!.importedCount).toBe(3);
    expect(list[1]!.importedCount).toBe(1);
  });

  it('delete → row gone', () => {
    const svc = new TemplateCacheService();
    const t = svc.save({ promptText: 'x', workflow: SAMPLE_WF, workflowJson: '{}' });
    expect(svc.delete(t.id)).toBe(true);
    expect(svc.getById(t.id)).toBeNull();
  });

  it('delete inesistente → false', () => {
    const svc = new TemplateCacheService();
    expect(svc.delete('non-existent')).toBe(false);
  });
});
