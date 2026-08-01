/**
 * Tests 2026-grade per ConversationService — fondamenta della Phase 1
 * AI-SCALING-100-TENANTS architecture.
 *
 * Coverage:
 *  - create / getById / findOrCreate (resume vs new)
 *  - listForUser (filtri surface + workspace + ordering)
 *  - appendMessage (counters + token estimation + transaction atomica)
 *  - getRecentMessages (in_summary filter, ordering)
 *  - buildContext (sliding window: maxTurns + maxTokens cap)
 *  - needsCompaction / applySummary (in_summary marking)
 *  - softDelete (ownership check)
 *  - hardPurgeExpired (cascade)
 *  - Isolation: utenti diversi NON vedono conversazioni altrui
 *  - REGRESSION: stale conversationId con userId mismatch → new conversation
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import SqliteDatabase from 'better-sqlite3';
import { SCHEMA_SQL } from '@/storage/migrate.schema.js';

const dbConnections: ReturnType<typeof SqliteDatabase>[] = [];

// Mock getDatabase to return a fresh in-memory SQLite per test, simulating
// the per-tenant container isolation in production.
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
          exec: (sql: string) => { conn.exec(sql); },
          transaction: <T extends unknown[], R>(fn: (...args: T) => R) => conn.transaction(fn) as unknown as (...args: T) => R,
        },
      };
    },
  };
});

vi.mock('@/lib/logger.js');

import { ConversationService } from './conversation.service.js';

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

describe('ConversationService.create + getById', () => {
  it('crea una conversazione con default counter = 0', () => {
    const svc = new ConversationService();
    const conv = svc.create({
      userId: 'u-1',
      workspaceId: 'ws-1',
      surface: 'editor_chat',
    });
    expect(conv.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(conv.userId).toBe('u-1');
    expect(conv.workspaceId).toBe('ws-1');
    expect(conv.surface).toBe('editor_chat');
    expect(conv.messageCount).toBe(0);
    expect(conv.totalInputTokens).toBe(0);
    expect(conv.summary).toBeNull();
    expect(conv.deletedAt).toBeNull();
  });

  it('getById ritorna la conversazione', () => {
    const svc = new ConversationService();
    const a = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    const b = svc.getById(a.id);
    expect(b?.id).toBe(a.id);
  });

  it('getById su soft-deleted → null', () => {
    const svc = new ConversationService();
    const a = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    svc.softDelete(a.id, 'u-1');
    expect(svc.getById(a.id)).toBeNull();
  });

  it('getById su id inesistente → null (no throw)', () => {
    const svc = new ConversationService();
    expect(svc.getById('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('ConversationService.findOrCreate', () => {
  it('senza conversationId → crea nuova', () => {
    const svc = new ConversationService();
    const conv = svc.findOrCreate(undefined, { userId: 'u-1', surface: 'editor_chat' });
    expect(conv.userId).toBe('u-1');
    expect(svc.getById(conv.id)?.id).toBe(conv.id);
  });

  it('con conversationId valido + same user → resume esistente', () => {
    const svc = new ConversationService();
    const a = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    const b = svc.findOrCreate(a.id, { userId: 'u-1', surface: 'editor_chat' });
    expect(b.id).toBe(a.id);
  });

  it('REGRESSION: conversationId di un ALTRO user → crea nuova (NO cross-user leak)', () => {
    const svc = new ConversationService();
    const ofUser1 = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    const resumed = svc.findOrCreate(ofUser1.id, { userId: 'u-2', surface: 'editor_chat' });
    expect(resumed.id).not.toBe(ofUser1.id);
    expect(resumed.userId).toBe('u-2');
  });

  it('REGRESSION: conversationId soft-deleted → crea nuova', () => {
    const svc = new ConversationService();
    const a = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    svc.softDelete(a.id, 'u-1');
    const b = svc.findOrCreate(a.id, { userId: 'u-1', surface: 'editor_chat' });
    expect(b.id).not.toBe(a.id);
  });
});

describe('ConversationService.appendMessage + counters', () => {
  it('appendMessage incrementa message_count + token counters', () => {
    const svc = new ConversationService();
    const conv = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    svc.appendMessage({ conversationId: conv.id, role: 'user', content: 'Ciao Liara' });
    svc.appendMessage({ conversationId: conv.id, role: 'assistant', content: 'Ciao!' });
    const updated = svc.getById(conv.id);
    expect(updated?.messageCount).toBe(2);
    expect(updated?.totalInputTokens).toBeGreaterThan(0);
    expect(updated?.totalOutputTokens).toBeGreaterThan(0);
  });

  it('token count fornito esplicitamente → preferito su estimate', () => {
    const svc = new ConversationService();
    const conv = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    svc.appendMessage({ conversationId: conv.id, role: 'user', content: 'X', tokens: 999 });
    const updated = svc.getById(conv.id);
    expect(updated?.totalInputTokens).toBe(999);
  });

  it('appendMessage aggiorna last_message_at', async () => {
    const svc = new ConversationService();
    const conv = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    const initialTs = conv.lastMessageAt;
    await new Promise((r) => setTimeout(r, 12));
    svc.appendMessage({ conversationId: conv.id, role: 'user', content: 'next' });
    const updated = svc.getById(conv.id);
    expect(new Date(updated!.lastMessageAt).getTime()).toBeGreaterThan(
      new Date(initialTs).getTime(),
    );
  });
});

describe('ConversationService.buildContext sliding window', () => {
  it('senza messaggi → returns empty messages + null summary', () => {
    const svc = new ConversationService();
    const conv = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    const ctx = svc.buildContext(conv.id);
    expect(ctx.summary).toBeNull();
    expect(ctx.messages).toEqual([]);
  });

  it('maxTurns=3 + 5 messaggi → tail di 3', () => {
    const svc = new ConversationService();
    const conv = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    for (let i = 0; i < 5; i++) {
      svc.appendMessage({ conversationId: conv.id, role: 'user', content: `msg${i.toString()}` });
    }
    const ctx = svc.buildContext(conv.id, { maxTurns: 3 });
    expect(ctx.messages.length).toBe(3);
    expect(ctx.messages[2]?.content).toBe('msg4');
  });

  it('maxTokens=10 → cap before maxTurns', () => {
    const svc = new ConversationService();
    const conv = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    // Each "X".repeat(28) ~ 8 tokens (28 chars / 3.5).
    for (let i = 0; i < 10; i++) {
      svc.appendMessage({ conversationId: conv.id, role: 'user', content: 'X'.repeat(28) });
    }
    const ctx = svc.buildContext(conv.id, { maxTurns: 100, maxTokens: 10 });
    // Should include only 1 message (8 tokens fit; adding another > 10 cap).
    expect(ctx.messages.length).toBe(1);
  });

  it('ordering è chronological per LLM input (oldest first nel result)', () => {
    const svc = new ConversationService();
    const conv = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    svc.appendMessage({ conversationId: conv.id, role: 'user', content: 'first' });
    svc.appendMessage({ conversationId: conv.id, role: 'assistant', content: 'second' });
    svc.appendMessage({ conversationId: conv.id, role: 'user', content: 'third' });
    const ctx = svc.buildContext(conv.id, { maxTurns: 10 });
    expect(ctx.messages.map((m) => m.content)).toEqual(['first', 'second', 'third']);
  });
});

describe('ConversationService.needsCompaction + applySummary', () => {
  it('needsCompaction false sotto threshold 50', () => {
    const svc = new ConversationService();
    const conv = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    for (let i = 0; i < 10; i++) {
      svc.appendMessage({ conversationId: conv.id, role: 'user', content: `m${i.toString()}` });
    }
    expect(svc.needsCompaction(conv.id)).toBe(false);
  });

  it('needsCompaction true a >= 50 nuovi turni da ultima summary', () => {
    const svc = new ConversationService();
    const conv = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    for (let i = 0; i < 50; i++) {
      svc.appendMessage({ conversationId: conv.id, role: 'user', content: `m${i.toString()}` });
    }
    expect(svc.needsCompaction(conv.id)).toBe(true);
  });

  it('applySummary marca old messages in_summary=1 + reset summary_message_count', async () => {
    const svc = new ConversationService();
    const conv = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    for (let i = 0; i < 5; i++) {
      svc.appendMessage({ conversationId: conv.id, role: 'user', content: `m${i.toString()}` });
      // Small delay to ensure distinct ISO timestamps (ms-resolution).
      await new Promise((r) => setTimeout(r, 3));
    }
    const allBefore = svc.getRecentMessages(conv.id);
    const cutTs = allBefore[2]?.createdAt ?? new Date().toISOString();
    svc.applySummary(conv.id, 'User discussed configuration.', cutTs);
    const updated = svc.getById(conv.id);
    expect(updated?.summary).toBe('User discussed configuration.');
    expect(updated?.summaryMessageCount).toBe(5);
    // First 3 messages (≤ cutTs) folded → excluded from getRecentMessages
    const remaining = svc.getRecentMessages(conv.id);
    expect(remaining.length).toBe(2); // m3, m4 NOT folded
  });
});

describe('ConversationService.liveContextTokens', () => {
  it('somma i token provider-reported dei messaggi non-foldati', () => {
    const svc = new ConversationService();
    const conv = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    svc.appendMessage({ conversationId: conv.id, role: 'user', content: 'a', tokens: 100 });
    svc.appendMessage({ conversationId: conv.id, role: 'assistant', content: 'b', tokens: 250 });
    expect(svc.liveContextTokens(conv.id)).toBe(350);
  });

  it('include il summary e ESCLUDE i messaggi foldati (in_summary=1)', async () => {
    const svc = new ConversationService();
    const conv = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    svc.appendMessage({ conversationId: conv.id, role: 'user', content: 'old', tokens: 500 });
    await new Promise((r) => setTimeout(r, 3));
    const cut = svc.getRecentMessages(conv.id)[0]!.createdAt;
    svc.appendMessage({ conversationId: conv.id, role: 'user', content: 'new', tokens: 40 });
    // summary "X".repeat(35) → ceil(35/3.5) = 10 token stimati.
    svc.applySummary(conv.id, 'X'.repeat(35), cut);
    // 40 (msg vivo) + 10 (summary) = 50; il msg foldato (500) NON conta.
    expect(svc.liveContextTokens(conv.id)).toBe(50);
  });

  it('conversazione inesistente → 0 (no throw)', () => {
    const svc = new ConversationService();
    expect(svc.liveContextTokens('nope')).toBe(0);
  });
});

describe('ConversationService.needsCompaction TOKEN-based', () => {
  it('false quando i token vivi sono sotto la soglia', () => {
    const svc = new ConversationService();
    const conv = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    for (let i = 0; i < 25; i++) {
      svc.appendMessage({ conversationId: conv.id, role: 'user', content: `m${i.toString()}`, tokens: 10 });
    }
    // 25 * 10 = 250 token, soglia 1000 → no compaction.
    expect(svc.needsCompaction(conv.id, { maxContextTokens: 1000 })).toBe(false);
  });

  it('true quando i token vivi superano la soglia (oltre i 20 turni di finestra)', () => {
    const svc = new ConversationService();
    const conv = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    for (let i = 0; i < 25; i++) {
      svc.appendMessage({ conversationId: conv.id, role: 'user', content: `m${i.toString()}`, tokens: 100 });
    }
    // 25 * 100 = 2500 ≥ soglia 1000 → compaction.
    expect(svc.needsCompaction(conv.id, { maxContextTokens: 1000 })).toBe(true);
  });

  it('POCHE ma PESANTI → COMPRIME (no più short-circuit a conteggio: era il bug → 413)', () => {
    const svc = new ConversationService();
    const conv = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    // Solo 4 messaggi, ma enormi → token vivi sopra soglia: DEVE comprimere.
    for (let i = 0; i < 4; i++) {
      svc.appendMessage({ conversationId: conv.id, role: 'user', content: `m${i.toString()}`, tokens: 100000 });
    }
    expect(svc.needsCompaction(conv.id, { maxContextTokens: 1000 })).toBe(true);
  });

  it('guard minimo: < 3 messaggi → false (niente da foldare oltre la finestra viva)', () => {
    const svc = new ConversationService();
    const conv = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    svc.appendMessage({ conversationId: conv.id, role: 'user', content: 'enorme', tokens: 100000 });
    svc.appendMessage({ conversationId: conv.id, role: 'assistant', content: 'pure', tokens: 100000 });
    expect(svc.needsCompaction(conv.id, { maxContextTokens: 1000 })).toBe(false); // 2 < 3
  });

  it('MUTATION: token-based scatta a 21 turni dove il fallback-a-turni (≥50) NON scatterebbe', () => {
    const svc = new ConversationService();
    const conv = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    for (let i = 0; i < 21; i++) {
      svc.appendMessage({ conversationId: conv.id, role: 'user', content: `m${i.toString()}`, tokens: 100 });
    }
    // Soglia token bassa → true; la regola a turni (50) a 21 msg darebbe false.
    expect(svc.needsCompaction(conv.id, { maxContextTokens: 500 })).toBe(true);
    expect(svc.needsCompaction(conv.id)).toBe(false); // fallback a turni: 21 < 50
  });

  it('senza opts: mantiene il fallback storico a turni (≥50)', () => {
    const svc = new ConversationService();
    const conv = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    for (let i = 0; i < 50; i++) {
      svc.appendMessage({ conversationId: conv.id, role: 'user', content: `m${i.toString()}` });
    }
    expect(svc.needsCompaction(conv.id)).toBe(true);
    expect(svc.needsCompaction(conv.id, {})).toBe(true);
  });
});

describe('ConversationService.softDelete + listForUser isolation', () => {
  it('softDelete con ownership check → richiede match user_id', () => {
    const svc = new ConversationService();
    const conv = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    expect(svc.softDelete(conv.id, 'u-2')).toBe(false); // wrong user
    expect(svc.softDelete(conv.id, 'u-1')).toBe(true);
    expect(svc.getById(conv.id)).toBeNull();
  });

  it('listForUser ritorna SOLO conversazioni di quel user (isolation)', () => {
    const svc = new ConversationService();
    svc.create({ userId: 'u-1', surface: 'editor_chat' });
    svc.create({ userId: 'u-2', surface: 'editor_chat' });
    svc.create({ userId: 'u-2', surface: 'editor_chat' });
    expect(svc.listForUser('u-1').length).toBe(1);
    expect(svc.listForUser('u-2').length).toBe(2);
  });

  it('listForUser filtra per surface', () => {
    const svc = new ConversationService();
    svc.create({ userId: 'u-1', surface: 'editor_chat' });
    svc.create({ userId: 'u-1', surface: 'help_chat' });
    svc.create({ userId: 'u-1', surface: 'wizard_scaffold' });
    expect(svc.listForUser('u-1', { surface: 'editor_chat' }).length).toBe(1);
    expect(svc.listForUser('u-1', { surface: 'help_chat' }).length).toBe(1);
    expect(svc.listForUser('u-1').length).toBe(3);
  });

  it('listForUser esclude soft-deleted', () => {
    const svc = new ConversationService();
    const a = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    svc.create({ userId: 'u-1', surface: 'editor_chat' });
    svc.softDelete(a.id, 'u-1');
    expect(svc.listForUser('u-1').length).toBe(1);
  });

  it('hardPurgeExpired → DELETE row + cascade messages', () => {
    const svc = new ConversationService();
    const a = svc.create({ userId: 'u-1', surface: 'editor_chat' });
    svc.appendMessage({ conversationId: a.id, role: 'user', content: 'hi' });
    svc.softDelete(a.id, 'u-1');
    const purged = svc.hardPurgeExpired(new Date(Date.now() + 60_000).toISOString());
    expect(purged).toBe(1);
    expect(svc.getById(a.id)).toBeNull();
  });
});
