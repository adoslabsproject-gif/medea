/**
 * Tests per CircuitBreakerRegistry — singleton manager dei breaker.
 * Coverage target: 100%.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { CircuitBreakerRegistry } from '../circuit-breaker-registry.js';
import { CircuitBreaker } from '../circuit-breaker.js';

const opts = { failureThreshold: 3, resetTimeout: 100, successThreshold: 2 };

describe('CircuitBreakerRegistry', () => {
  afterEach(() => {
    CircuitBreakerRegistry.resetInstance();
  });

  describe('singleton', () => {
    it('getInstance() ritorna sempre la stessa istanza', () => {
      const a = CircuitBreakerRegistry.getInstance();
      const b = CircuitBreakerRegistry.getInstance();
      expect(a).toBe(b);
    });

    it('resetInstance() crea una nuova istanza al prossimo getInstance()', () => {
      const a = CircuitBreakerRegistry.getInstance();
      CircuitBreakerRegistry.resetInstance();
      const b = CircuitBreakerRegistry.getInstance();
      expect(a).not.toBe(b);
    });

    it('resetInstance() su instance null non lancia', () => {
      CircuitBreakerRegistry.resetInstance();
      expect(() => CircuitBreakerRegistry.resetInstance()).not.toThrow();
    });
  });

  describe('register / get / has', () => {
    it('register + get round-trip', () => {
      const reg = CircuitBreakerRegistry.getInstance();
      const cb = new CircuitBreaker('foo', opts);
      reg.register('foo', cb);
      expect(reg.get('foo')).toBe(cb);
    });

    it('has(name) restituisce true se registrato', () => {
      const reg = CircuitBreakerRegistry.getInstance();
      reg.register('foo', new CircuitBreaker('foo', opts));
      expect(reg.has('foo')).toBe(true);
      expect(reg.has('bar')).toBe(false);
    });

    it('register di nome duplicato → sostituzione idempotente (no throw, hot-reload safe)', () => {
      // Behavior cambiato 2026-06-03: il throw bloccava ogni request fino al
      // restart in caso di re-istanziazione modulare (hot-reload dev / re-import
      // dinamico). La sostituzione e\` fail-safe: la vecchia istanza viene
      // destroy()ata per non leakare timer, la nuova prende il suo posto.
      const reg = CircuitBreakerRegistry.getInstance();
      const cb1 = new CircuitBreaker('foo', opts);
      reg.register('foo', cb1);
      const cb2 = new CircuitBreaker('foo', opts);
      expect(() => reg.register('foo', cb2)).not.toThrow();
      expect(reg.get('foo')).toBe(cb2);
    });

    it('get(name) di nome non registrato → null (no throw, null-safe)', () => {
      // Behavior cambiato 2026-06-03: throw obbligava ogni caller in try/catch
      // anche per probe legittimi ("esiste questo breaker?"). Ora ritorna null,
      // semantica simil-Map.get JS standard.
      const reg = CircuitBreakerRegistry.getInstance();
      expect(reg.get('inesistente')).toBeNull();
    });
  });

  describe('getHealthReport', () => {
    it('vuoto se nessun breaker registrato', () => {
      const reg = CircuitBreakerRegistry.getInstance();
      const report = reg.getHealthReport();
      expect(Object.keys(report)).toHaveLength(0);
    });

    it('contiene tutti i breaker registrati', () => {
      const reg = CircuitBreakerRegistry.getInstance();
      reg.register('a', new CircuitBreaker('a', opts));
      reg.register('b', new CircuitBreaker('b', opts));
      const report = reg.getHealthReport();
      expect(Object.keys(report).sort()).toEqual(['a', 'b']);
      expect(report.a?.state).toBe('closed');
      expect(report.b?.state).toBe('closed');
    });

    it('Date objects sono clonati (immutabilità snapshot)', async () => {
      const reg = CircuitBreakerRegistry.getInstance();
      const cb = new CircuitBreaker('foo', opts);
      reg.register('foo', cb);
      await cb.execute(async () => 'ok');
      const report = reg.getHealthReport();
      const lastSuccess1 = report.foo!.stats.lastSuccess;
      // Mutare il Date nel report NON deve modificare il breaker interno
      if (lastSuccess1) {
        lastSuccess1.setTime(0);
      }
      const report2 = reg.getHealthReport();
      const lastSuccess2 = report2.foo!.stats.lastSuccess;
      expect(lastSuccess2?.getTime()).not.toBe(0);
    });
  });

  describe('destroyAll', () => {
    it('destroyAll svuota il registry e chiama destroy() su ogni breaker', () => {
      const reg = CircuitBreakerRegistry.getInstance();
      reg.register('a', new CircuitBreaker('a', opts));
      reg.register('b', new CircuitBreaker('b', opts));
      reg.destroyAll();
      expect(reg.has('a')).toBe(false);
      expect(reg.has('b')).toBe(false);
      expect(Object.keys(reg.getHealthReport())).toHaveLength(0);
    });
  });
});
