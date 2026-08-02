/**
 * Test cross-surface-context su SQLite reale in-memory (come conversation.service.test).
 *
 * Garanzie bug-bounty:
 *  - una voce per surface (la più recente), etichette leggibili, ordine per recency
 *  - ESCLUDE la conversazione corrente (excludeConversationId)
 *  - salta conversazioni vuote (messageCount=0)
 *  - usa il SUMMARY se presente, altrimenti gli ULTIMI turni (fallback)
 *  - cap per voce + cap numero surface
 *  - isolamento per (user, workspace): NON pesca da altri utenti/workspace
 *  - fail-soft: workspace assente → stringa vuota
 *
 * @module services/ai-conversations/cross-surface-context.test
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
        transaction: <T extends unknown[], R>(fn: (...a: T) => R) =>
          conn.transaction(fn) as unknown as (...a: T) => R,
      },
    };
  },
}));
vi.mock('@/lib/logger.js');

import { conversationService } from './conversation.service.js';
import { buildCrossSurfaceContext } from './cross-surface-context.js';
import type { Surface } from './types.js';

beforeEach(() => {
  const conn = new SqliteDatabase(':memory:');
  conn.pragma('foreign_keys = ON');
  conn.exec(SCHEMA_SQL);
  dbConnections.push(conn);
});
afterEach(() => {
  const conn = dbConnections.pop();
  if (conn) conn.close();
});

/** Crea una conversazione con N messaggi (e opzionale summary). */
function seed(opts: {
  userId: string;
  workspaceId: string;
  surface: Surface;
  messages?: [string, string][];
  summary?: string;
}): string {
  const conv = conversationService.create({
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    surface: opts.surface,
  });
  for (const [role, content] of opts.messages ?? []) {
    conversationService.appendMessage({
      conversationId: conv.id,
      role: role as 'user' | 'assistant',
      content,
    });
  }
  if (opts.summary)
    conversationService.applySummary(conv.id, opts.summary, new Date().toISOString());
  return conv.id;
}

describe('buildCrossSurfaceContext', () => {
  it('aggrega le altre surface del workspace con etichette leggibili', () => {
    seed({
      userId: 'u',
      workspaceId: 'ws',
      surface: 'editor_chat',
      messages: [['user', 'crea un workflow che monitora i prezzi']],
      summary: 'Workflow di monitoraggio prezzi con scraping orario',
    });
    seed({
      userId: 'u',
      workspaceId: 'ws',
      surface: 'help_chat',
      messages: [
        ['user', 'come funziona il nodo http?'],
        ['assistant', 'fa richieste HTTP'],
      ],
    });
    const ctx = buildCrossSurfaceContext('u', 'ws');
    expect(ctx).toContain('CONTESTO DA ALTRE SCHEDE');
    expect(ctx).toContain('• Workflow editor: Workflow di monitoraggio prezzi con scraping orario');
    expect(ctx).toContain('• Aiuto:'); // fallback ai turni (no summary)
    expect(ctx).toContain('come funziona il nodo http');
  });

  it('usa il SUMMARY se presente, altrimenti gli ultimi turni', () => {
    seed({
      userId: 'u',
      workspaceId: 'ws',
      surface: 'editor_chat',
      messages: [
        ['user', 'ignorami'],
        ['assistant', 'ok'],
      ],
      summary: 'RIEPILOGO UFFICIALE',
    });
    const ctx = buildCrossSurfaceContext('u', 'ws');
    expect(ctx).toContain('Workflow editor: RIEPILOGO UFFICIALE');
    expect(ctx).not.toContain('ignorami'); // il summary vince sui turni
  });

  it('ESCLUDE la conversazione corrente (excludeConversationId)', () => {
    const cur = seed({
      userId: 'u',
      workspaceId: 'ws',
      surface: 'editor_chat',
      messages: [['user', 'corrente']],
      summary: 'CORRENTE',
    });
    seed({
      userId: 'u',
      workspaceId: 'ws',
      surface: 'help_chat',
      messages: [['user', 'altra']],
      summary: 'ALTRA',
    });
    const ctx = buildCrossSurfaceContext('u', 'ws', { excludeConversationId: cur });
    expect(ctx).toContain('ALTRA');
    expect(ctx).not.toContain('CORRENTE');
  });

  it('salta le conversazioni VUOTE (messageCount = 0)', () => {
    conversationService.create({ userId: 'u', workspaceId: 'ws', surface: 'editor_chat' }); // vuota
    seed({
      userId: 'u',
      workspaceId: 'ws',
      surface: 'help_chat',
      messages: [['user', 'piena']],
      summary: 'PIENA',
    });
    const ctx = buildCrossSurfaceContext('u', 'ws');
    expect(ctx).toContain('PIENA');
    expect(ctx).not.toContain('Workflow editor'); // la vuota non compare
  });

  it('una sola voce per surface (la più recente)', () => {
    seed({
      userId: 'u',
      workspaceId: 'ws',
      surface: 'editor_chat',
      messages: [['user', 'vecchia']],
      summary: 'VECCHIA',
    });
    const nuovaId = seed({
      userId: 'u',
      workspaceId: 'ws',
      surface: 'editor_chat',
      messages: [['user', 'nuova']],
      summary: 'NUOVA',
    });
    // Ms distinti deterministici (in prod sono naturalmente distinti): NUOVA più recente.
    dbConnections[dbConnections.length - 1]!.prepare(
      'UPDATE ai_conversations SET last_message_at = ? WHERE id = ?',
    ).run(new Date(Date.now() + 5000).toISOString(), nuovaId);
    const ctx = buildCrossSurfaceContext('u', 'ws');
    expect(ctx).toContain('NUOVA');
    expect(ctx).not.toContain('VECCHIA');
    expect(ctx.match(/Workflow editor/gu)?.length).toBe(1);
  });

  it('isolamento: NON pesca da altri utenti o altri workspace', () => {
    seed({
      userId: 'altro',
      workspaceId: 'ws',
      surface: 'editor_chat',
      messages: [['user', 'x']],
      summary: 'ALTRO_UTENTE',
    });
    seed({
      userId: 'u',
      workspaceId: 'ws-2',
      surface: 'editor_chat',
      messages: [['user', 'y']],
      summary: 'ALTRO_WS',
    });
    seed({
      userId: 'u',
      workspaceId: 'ws',
      surface: 'help_chat',
      messages: [['user', 'z']],
      summary: 'MIO',
    });
    const ctx = buildCrossSurfaceContext('u', 'ws');
    expect(ctx).toContain('MIO');
    expect(ctx).not.toContain('ALTRO_UTENTE');
    expect(ctx).not.toContain('ALTRO_WS');
  });

  it('cap caratteri per voce', () => {
    seed({
      userId: 'u',
      workspaceId: 'ws',
      surface: 'editor_chat',
      messages: [['user', 'x']],
      summary: 'A'.repeat(500),
    });
    const ctx = buildCrossSurfaceContext('u', 'ws', { maxCharsPerEntry: 50 });
    const line = ctx.split('\n').find((l) => l.startsWith('• Workflow editor'))!;
    expect(line.length).toBeLessThan(80); // 50 + etichetta + ellissi
    expect(line).toContain('…');
  });

  it('workspace assente o nessuna conversazione → stringa vuota', () => {
    expect(buildCrossSurfaceContext('u', undefined)).toBe('');
    expect(buildCrossSurfaceContext('u', 'ws-vuoto')).toBe('');
  });
});
