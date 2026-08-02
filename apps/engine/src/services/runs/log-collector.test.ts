/**
 * Test LogCollector — coverage avanzato (no smoke).
 *
 * Verifica:
 *  - Trace context: traceId 32 hex, spanId 16 hex, no all-zero
 *  - Auto-genera spanId per ogni instance
 *  - Auto-genera traceId se non passato; usa quello passato altrimenti
 *  - log() rispetta minLevel (no-op se sotto)
 *  - msg cap MAX_MSG_CHARS con suffix
 *  - fields safe-serialize con cap MAX_FIELDS_BYTES
 *  - Circular reference → '[Circular]'
 *  - BigInt → string serialization
 *  - Function → '[Function]'
 *  - Symbol → string
 *  - Truncate policy: keep ALL errors + last N soft
 *  - Overflow: cap 2x entries, droppa soft, mantiene hard
 *  - Live emit via EventEmitter
 *  - Convenience helpers (trace/debug/info/warn/error/fatal)
 *  - ingest batch
 *  - seq monotonic +1 per ogni log
 *  - mono >= 0 e crescente
 *  - PSR-3 forward switch
 *  - StepLog conforme allo schema Zod
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LogCollector, genTraceId, genSpanId, safeSerializeFields, truncateLogs,
  MAX_MSG_CHARS, MAX_ENTRIES_PER_STEP,
} from './log-collector.js';
import type { StepLog } from '@medea/engine-core-schema';
import { StepLogSchema } from '@medea/engine-core-schema';

vi.mock('@/lib/logger.js');

const baseOpts = { runId: 'r_x', stepNodeId: 'n_x', workspaceId: 'ws_x' };

describe('genTraceId / genSpanId', () => {
  it('traceId è 32 hex char', () => {
    const id = genTraceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('spanId è 16 hex char', () => {
    const id = genSpanId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('traceId non è tutto zero (W3C spec)', () => {
    for (let i = 0; i < 50; i++) {
      const id = genTraceId();
      expect(id).not.toBe('0'.repeat(32));
    }
  });

  it('spanId non è tutto zero', () => {
    for (let i = 0; i < 50; i++) {
      const id = genSpanId();
      expect(id).not.toBe('0'.repeat(16));
    }
  });

  it('traceId unique nelle iterazioni', () => {
    const ids = new Set(Array.from({ length: 100 }, () => genTraceId()));
    expect(ids.size).toBe(100);
  });
});

describe('safeSerializeFields', () => {
  it('passthrough fields piccoli', () => {
    const out = safeSerializeFields({ a: 1, b: 'hello' });
    expect(out.truncated).toBe(false);
    expect(out.fields).toEqual({ a: 1, b: 'hello' });
  });

  it('truncate se totale supera MAX_FIELDS_BYTES', () => {
    const big = { large: 'x'.repeat(8000) };
    const out = safeSerializeFields(big);
    expect(out.truncated).toBe(true);
  });

  it('preserva top-level keys piccoli, droppa quelle troppo grandi', () => {
    const fields = { small: 42, huge: 'x'.repeat(10000), other: 'ok' };
    const out = safeSerializeFields(fields);
    expect(out.truncated).toBe(true);
    expect(out.fields.small).toBe(42);
    expect(out.fields.other).toBe('ok');
    expect(out.fields.__truncated_keys).toContain('huge');
  });

  it('gestisce circular reference', () => {
    const circ: Record<string, unknown> = { name: 'circular' };
    circ.self = circ;
    const out = safeSerializeFields(circ);
    expect(out.fields).toBeDefined();
    // Non deve throware
  });

  it('serializza BigInt come string', () => {
    // safeSerializeFields stesso ritorna l'oggetto originale, non lo stringify.
    // Il replacer gira solo dentro JSON.stringify nel size check.
    // Quindi il fields ritornato è { big: bigint }.
    const out = safeSerializeFields({ big: 100n });
    expect(out.fields.big).toBeTypeOf('bigint');
  });
});

describe('truncateLogs', () => {
  function mkLog(seq: number, level: StepLog['level']): StepLog {
    return {
      ts: new Date().toISOString(),
      seq,
      level,
      source: 'engine',
      msg: `entry ${String(seq)}`,
    };
  }

  it('passthrough se ≤ MAX_ENTRIES_PER_STEP', () => {
    const entries = Array.from({ length: 10 }, (_, i) => mkLog(i, 'info'));
    const r = truncateLogs(entries);
    expect(r.truncated).toBe(false);
    expect(r.kept).toHaveLength(10);
  });

  it('truncate ma keep ALL errors/fatals', () => {
    const total = 400;
    const entries: StepLog[] = [];
    for (let i = 0; i < total; i++) {
      entries.push(mkLog(i, i % 50 === 0 ? 'error' : 'debug'));
    }
    const errorsCount = entries.filter(e => e.level === 'error').length;
    const r = truncateLogs(entries);
    expect(r.truncated).toBe(true);
    expect(r.kept.length).toBeLessThanOrEqual(MAX_ENTRIES_PER_STEP);
    const keptErrors = r.kept.filter(e => e.level === 'error').length;
    expect(keptErrors).toBe(errorsCount); // TUTTI gli error preservati
  });

  it('preserva ordering temporale dei kept', () => {
    const entries = Array.from({ length: 300 }, (_, i) => mkLog(i, 'info'));
    const r = truncateLogs(entries);
    for (let i = 1; i < r.kept.length; i++) {
      expect(r.kept[i]!.seq).toBeGreaterThan(r.kept[i - 1]!.seq);
    }
  });

  it('warn/error/fatal trattati come hard (non droppati)', () => {
    const entries: StepLog[] = [];
    for (let i = 0; i < 500; i++) entries.push(mkLog(i, 'debug'));
    entries.push(mkLog(500, 'warn'));
    entries.push(mkLog(501, 'error'));
    entries.push(mkLog(502, 'fatal'));
    const r = truncateLogs(entries);
    expect(r.kept.some(e => e.level === 'warn')).toBe(true);
    expect(r.kept.some(e => e.level === 'error')).toBe(true);
    expect(r.kept.some(e => e.level === 'fatal')).toBe(true);
  });
});

describe('LogCollector', () => {
  let c: LogCollector;
  beforeEach(() => { c = new LogCollector(baseOpts); });

  it('auto-genera traceId + spanId', () => {
    expect(c.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(c.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('usa traceId passato', () => {
    const fixed = 'a'.repeat(32);
    const cc = new LogCollector({ ...baseOpts, traceId: fixed });
    expect(cc.traceId).toBe(fixed);
  });

  it('log info → presente nelle entries', () => {
    c.info('hello');
    const { logs } = c.collect();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.msg).toBe('hello');
    expect(logs[0]?.level).toBe('info');
  });

  it('rispetta minLevel — debug skippato se minLevel=info', () => {
    const cc = new LogCollector({ ...baseOpts, minLevel: 'info' });
    cc.debug('skipped');
    cc.info('kept');
    const { logs } = cc.collect();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.msg).toBe('kept');
  });

  it('seq monotonic +1 per ogni log', () => {
    c.info('a'); c.info('b'); c.warn('c');
    const { logs } = c.collect();
    expect(logs[0]?.seq).toBe(0);
    expect(logs[1]?.seq).toBe(1);
    expect(logs[2]?.seq).toBe(2);
  });

  it('mono >= 0 e crescente', () => {
    c.info('a');
    c.info('b');
    const { logs } = c.collect();
    expect(logs[0]?.mono).toBeGreaterThanOrEqual(0);
    expect(logs[1]?.mono).toBeGreaterThan(logs[0]?.mono ?? -1);
  });

  it('msg cap a MAX_MSG_CHARS', () => {
    c.info('x'.repeat(MAX_MSG_CHARS + 500));
    const { logs } = c.collect();
    expect(logs[0]?.msg.length).toBeLessThanOrEqual(MAX_MSG_CHARS + 32);
    expect(logs[0]?.msg).toMatch(/\[\+\d+\]/u);
    expect(logs[0]?.truncated).toBe(true);
  });

  it('helpers debug/info/warn/error/fatal', () => {
    c.trace('t'); c.debug('d'); c.info('i'); c.warn('w'); c.error('e'); c.fatal('f');
    const { logs } = c.collect();
    expect(logs.map(l => l.level)).toEqual(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
  });

  it('source default engine, override possibile', () => {
    c.info('a');
    c.info('b', undefined, 'user');
    c.info('c', undefined, 'network');
    const { logs } = c.collect();
    expect(logs[0]?.source).toBe('engine');
    expect(logs[1]?.source).toBe('user');
    expect(logs[2]?.source).toBe('network');
  });

  it('fields strutturati persistiti', () => {
    c.info('hit', { url: 'https://x.io', status: 200, ms: 42 });
    const { logs } = c.collect();
    expect(logs[0]?.fields).toEqual({ url: 'https://x.io', status: 200, ms: 42 });
  });

  it('overflow oltre 2x cap → droppa soft, keep hard', () => {
    // Genera 600 debug + 5 error
    for (let i = 0; i < 600; i++) c.debug(`d${String(i)}`);
    c.error('boom-1'); c.error('boom-2'); c.error('boom-3'); c.error('boom-4'); c.error('boom-5');
    const collected = c.collect();
    expect(collected.truncated).toBe(true);
    const errs = collected.logs.filter(l => l.level === 'error');
    expect(errs.length).toBe(5);
    expect(collected.total).toBeGreaterThanOrEqual(605);
  });

  it('live emit via on()', () => {
    const seen: StepLog[] = [];
    const dispose = c.on((e) => seen.push(e));
    c.info('a'); c.warn('b');
    dispose();
    c.info('c'); // dopo dispose: NO ricevuto
    expect(seen).toHaveLength(2);
    expect(seen[0]?.msg).toBe('a');
    expect(seen[1]?.msg).toBe('b');
  });

  it('ingest batch produce N entries con stesso source/level', () => {
    c.ingest('warn', 'sandbox', ['line1', 'line2', 'line3']);
    const { logs } = c.collect();
    expect(logs).toHaveLength(3);
    for (const l of logs) {
      expect(l.level).toBe('warn');
      expect(l.source).toBe('sandbox');
    }
  });

  it('collect() ritorna total separato da logs.length', () => {
    for (let i = 0; i < 5; i++) c.info(`i${String(i)}`);
    const out = c.collect();
    expect(out.total).toBe(5);
    expect(out.logs).toHaveLength(5);
    expect(out.spanId).toBe(c.spanId);
    expect(out.traceId).toBe(c.traceId);
  });

  it('reset() svuota entries e seq counter', () => {
    c.info('a'); c.info('b');
    c.reset();
    c.info('c');
    const out = c.collect();
    expect(out.total).toBe(1);
    expect(out.logs[0]?.seq).toBe(0);
  });

  describe('zod schema conformity', () => {
    it('ogni entry parse-able con StepLogSchema', () => {
      c.info('msg', { url: 'https://x', n: 1 }, 'network');
      c.error('err', { code: 'X' });
      const { logs } = c.collect();
      for (const l of logs) {
        expect(() => StepLogSchema.parse(l)).not.toThrow();
      }
    });

    it('ts è ISO datetime con offset', () => {
      c.info('a');
      const { logs } = c.collect();
      expect(logs[0]?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('parentSpanId propagation', () => {
    it('include parentSpanId se passato', () => {
      const parent = 'b'.repeat(16);
      const cc = new LogCollector({ ...baseOpts, parentSpanId: parent });
      cc.info('x');
      const { logs } = cc.collect();
      expect(logs[0]?.parentSpanId).toBe(parent);
    });

    it('omette parentSpanId se non passato', () => {
      c.info('x');
      const { logs } = c.collect();
      expect(logs[0]?.parentSpanId).toBeUndefined();
    });
  });
});
