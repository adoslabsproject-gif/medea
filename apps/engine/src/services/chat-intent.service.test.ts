/**
 * Tests 2026-grade per chat-intent.service.
 * Coverage: smoke + workflow control + multimodal + regression.
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
        exec: (sql: string) => { conn.exec(sql); },
        transaction: <T extends unknown[], R>(fn: (...args: T) => R) => conn.transaction(fn) as unknown as (...args: T) => R,
      },
    };
  },
}));

vi.mock('@/lib/logger.js');

vi.mock('./web-tools.service.js', () => ({
  fetchUrl: vi.fn(async (url: string) => ({ url, status: 200, title: 'T', content: 'mock', contentType: 'text/html' })),
  webSearch: vi.fn(async (query: string) => ({ query, provider: 'duckduckgo', results: [] })),
}));

vi.mock('./vision-tools.service.js', () => ({
  analyzeImage: vi.fn(async () => ({ ok: true, text: 'mock-img', confidence: 0.9, elapsedMs: 50 })),
  extractDocument: vi.fn(async () => ({ ok: true, text: 'mock-doc', pages: 1, elapsedMs: 50 })),
}));

import * as mod from './chat-intent.service.js';
const { detectIntents, executeIntents, resolveWorkflowName } = mod;

beforeEach(() => {
  const conn = new SqliteDatabase(':memory:');
  conn.pragma('foreign_keys = ON');
  conn.exec(SCHEMA_SQL);
  const now = new Date().toISOString();
  conn.prepare(`INSERT INTO workflows (id, name, description, enabled, nodes_json, edges_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'wf-orders-hot', 'Orders Hot Triage', null, 1,
    JSON.stringify([{ id: 'n1', defId: 'trigger_webhook', config: { path: '/orders' } }]),
    JSON.stringify([]), now, now,
  );
  conn.prepare(`INSERT INTO workflows (id, name, description, enabled, nodes_json, edges_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'wf-email-summary', 'Email Weekly Summary', null, 0,
    JSON.stringify([]), JSON.stringify([]), now, now,
  );
  dbConnections.push(conn);
});

afterEach(() => { const c = dbConnections.pop(); if (c) c.close(); });

describe('smoke', () => {
  it('exports', () => {
    expect(mod.detectIntents).toBeDefined();
    expect(mod.executeIntents).toBeDefined();
    expect(mod.resolveWorkflowName).toBeDefined();
    expect(mod.formatToolResultsForPrompt).toBeDefined();
  });
});

describe('detectIntents — workflow control', () => {
  it('"esegui workflow orders-hot" → run_workflow', () => {
    expect(detectIntents('esegui workflow orders-hot').some((i) => i.type === 'run_workflow')).toBe(true);
  });
  it('"run Orders" (EN) → run_workflow', () => {
    expect(detectIntents('run Orders please').some((i) => i.type === 'run_workflow')).toBe(true);
  });
  it('"attiva orders-hot" → enable', () => {
    expect(detectIntents('attiva orders-hot').some((i) => i.type === 'enable_workflow')).toBe(true);
  });
  it('"disattiva orders-hot" → disable', () => {
    expect(detectIntents('disattiva orders-hot').some((i) => i.type === 'disable_workflow')).toBe(true);
  });
  it('"lista i miei workflow" → list', () => {
    expect(detectIntents('lista i miei workflow').some((i) => i.type === 'list_workflows')).toBe(true);
  });
  it('"show me all workflows" → list', () => {
    expect(detectIntents('show me all workflows').some((i) => i.type === 'list_workflows')).toBe(true);
  });
  it('"configura nodo n1 del workflow orders-hot con path=/new method=POST"', () => {
    const intents = detectIntents('configura nodo n1 del workflow orders-hot con path="/new" method=POST.');
    const ci = intents.find((i) => i.type === 'configure_node');
    expect(ci?.args.nodeId).toBe('n1');
    expect(ci?.args.configPatch).toMatchObject({ path: '/new', method: 'POST' });
  });
});

describe('detectIntents — regression web tools', () => {
  it('URL fetch still works', () => {
    expect(detectIntents('dammi https://example.com').some((i) => i.type === 'fetch_url')).toBe(true);
  });
  it('web_search still works', () => {
    expect(detectIntents('cerca info su quantum').some((i) => i.type === 'web_search')).toBe(true);
  });
  // Bug 2026-06-28: "dove si trova" (= dov'è, domanda UI) scatenava web_search spazzatura.
  it('reflexive "si trova" does NOT trigger web_search (UI location question)', () => {
    expect(detectIntents('e dove si trova?? non vedo i nodi nella lavagna!').some((i) => i.type === 'web_search')).toBe(false);
    expect(detectIntents('dove si trova il pannello impostazioni?').some((i) => i.type === 'web_search')).toBe(false);
  });
  it('imperative "trova/trovami X" still triggers web_search', () => {
    expect(detectIntents('trovami una valvola Parker 3/8').some((i) => i.type === 'web_search')).toBe(true);
    expect(detectIntents('trova le specifiche del CETOP 5').some((i) => i.type === 'web_search')).toBe(true);
  });
  it('bare trigger word only ("cerca") does NOT web_search the whole message', () => {
    // query vuota dopo lo strip → nessun intent (prima faceva fallback al msg intero)
    expect(detectIntents('cerca').some((i) => i.type === 'web_search')).toBe(false);
  });
});

describe('resolveWorkflowName', () => {
  it('exact id → 1.0', () => {
    const r = resolveWorkflowName('wf-orders-hot');
    expect(r?.confidence).toBe(1.0);
  });
  it('exact name → 1.0', () => {
    const r = resolveWorkflowName('Orders Hot Triage');
    expect(r?.confidence).toBe(1.0);
  });
  it('substring → 0.85', () => {
    expect(resolveWorkflowName('orders')?.confidence).toBe(0.85);
  });
  it('not found → null', () => {
    expect(resolveWorkflowName('nope')).toBeNull();
  });
});

describe('executeIntents — end-to-end', () => {
  it('list_workflows returns 2', async () => {
    const r = await executeIntents([{ type: 'list_workflows', args: {}, reason: 't' }]);
    const d = r[0]?.data as { workflows: unknown[] };
    expect(d.workflows).toHaveLength(2);
  });
  it('enable + disable persist', async () => {
    const re = await executeIntents([{ type: 'enable_workflow', args: { workflowName: 'email-summary' }, reason: 't' }]);
    expect((re[0]?.data as { enabled?: boolean }).enabled).toBe(true);
    const rd = await executeIntents([{ type: 'disable_workflow', args: { workflowName: 'orders' }, reason: 't' }]);
    expect((rd[0]?.data as { enabled?: boolean }).enabled).toBe(false);
  });
  it('configure_node merges', async () => {
    const r = await executeIntents([{
      type: 'configure_node',
      args: { workflowName: 'orders', nodeId: 'n1', configPatch: { path: '/new' } },
      reason: 't',
    }]);
    expect((r[0]?.data as { ok: boolean }).ok).toBe(true);
  });
  it('run_workflow not_found error', async () => {
    const r = await executeIntents([{ type: 'run_workflow', args: { workflowName: 'nope' }, reason: 't' }]);
    expect(r[0]?.error).toContain('not_found');
  });
  const VISION_TARGET = { provider: 'liara', apiKey: '', model: '' };
  it('analyze_image dispatched (col provider risolto)', async () => {
    const r = await executeIntents([{ type: 'analyze_image', args: { imageBase64: 'b64' }, reason: 't' }], VISION_TARGET);
    expect((r[0]?.data as { text?: string }).text).toBe('mock-img');
  });
  it('extract_document dispatched (col provider risolto)', async () => {
    const r = await executeIntents([{ type: 'extract_document', args: { documentBase64: 'b64', documentMime: 'application/pdf', documentName: 'a.pdf' }, reason: 't' }], VISION_TARGET);
    expect((r[0]?.data as { text?: string }).text).toBe('mock-doc');
  });
  it('🚨 vision SENZA provider risolto → errore esplicito, nessun dispatch', async () => {
    const r = await executeIntents([{ type: 'analyze_image', args: { imageBase64: 'b64' }, reason: 't' }]);
    expect(r[0]?.error).toBe('no_vision_provider');
    expect((r[0]?.data as { ok: boolean }).ok).toBe(false);
  });
});

describe('🛡️ formatToolResultsForPrompt — allegati immagine/documento (fix 2026-06-22)', () => {
  type R = Parameters<typeof mod.formatToolResultsForPrompt>[0][number];
  const imgIntent = { type: 'analyze_image', args: { imageBase64: 'x' }, reason: 'image attachment: foto.png' };
  const docIntent = { type: 'extract_document', args: { documentBase64: 'x', documentMime: 'application/pdf', documentName: 'a.pdf' }, reason: 'document attachment: a.pdf' };

  it('🚨 analyze_image OK → il testo estratto ENTRA nel prompt (pre-fix: perso, "Query: undefined")', () => {
    const out = mod.formatToolResultsForPrompt([
      { intent: imgIntent, data: { ok: true, text: 'Un gatto rosso su un divano blu', confidence: 0.9, elapsedMs: 10 } } as unknown as R,
    ]);
    expect(out).toContain('Un gatto rosso su un divano blu');
    expect(out).toContain('Analisi dell\'immagine');
    expect(out).not.toContain('undefined'); // mutation: il ramo SearchResponse produceva Query/Risultati undefined
  });

  it('analyze_image con structured → JSON incluso', () => {
    const out = mod.formatToolResultsForPrompt([
      { intent: imgIntent, data: { ok: true, text: 'fattura', structured: { totale: 120 }, elapsedMs: 1 } } as unknown as R,
    ]);
    expect(out).toContain('"totale":120');
  });

  it('🚨 analyze_image KO (ok:false senza throw) → avviso ESPLICITO, NON nega l\'allegato', () => {
    const out = mod.formatToolResultsForPrompt([
      { intent: imgIntent, data: { ok: false, error: 'vision_offline', elapsedMs: 2 } } as unknown as R,
    ]);
    expect(out).toContain('HA allegato un\'immagine');
    expect(out).toContain('NON negare');
    expect(out).toContain('vision_offline');
  });

  it('🚨 extract_document OK → testo del documento nel prompt', () => {
    const out = mod.formatToolResultsForPrompt([
      { intent: docIntent, data: { ok: true, text: 'Contratto di fornitura art. 5', pages: 3, elapsedMs: 7 } } as unknown as R,
    ]);
    expect(out).toContain('Contratto di fornitura art. 5');
    expect(out).toContain('3 pagine');
    expect(out).not.toContain('undefined');
  });

  it('lista vuota → stringa vuota (invariato)', () => {
    expect(mod.formatToolResultsForPrompt([])).toBe('');
  });
});
