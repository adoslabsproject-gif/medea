import { describe, it, expect, beforeEach } from 'vitest';
import {
  hostOf,
  getHostBreaker,
  executeWithHostBreaker,
  clearBreakerRegistry,
  listBreakers,
} from './host-circuit-breaker.js';
import { CircuitOpenError } from './node-error.js';

describe('host-circuit-breaker', () => {
  beforeEach(() => {
    clearBreakerRegistry();
  });

  describe('hostOf', () => {
    it('extracts host from valid URL', () => {
      expect(hostOf('https://api.stripe.com/v1/charges')).toBe('api.stripe.com');
      expect(hostOf('http://10.0.0.1:8080/foo')).toBe('10.0.0.1:8080');
    });

    it('returns "unknown" for invalid URL', () => {
      expect(hostOf('not a url')).toBe('unknown');
      expect(hostOf('')).toBe('unknown');
    });
  });

  describe('getHostBreaker', () => {
    it('returns same breaker instance for same host (singleton)', () => {
      const b1 = getHostBreaker('api.x.com');
      const b2 = getHostBreaker('api.x.com');
      expect(b1).toBe(b2);
    });

    it('different hosts get different breakers', () => {
      const b1 = getHostBreaker('a.com');
      const b2 = getHostBreaker('b.com');
      expect(b1).not.toBe(b2);
    });

    it('default name uses "http:" prefix', () => {
      const b = getHostBreaker('a.com');
      expect(b.name).toBe('http:a.com');
    });

    it('custom prefix is honored', () => {
      const b = getHostBreaker('a.com', { prefix: 'smtp' });
      expect(b.name).toBe('smtp:a.com');
    });
  });

  describe('executeWithHostBreaker', () => {
    it('passes through successful calls', async () => {
      const r = await executeWithHostBreaker('https://api.x.com/u', async () => 'ok');
      expect(r).toBe('ok');
    });

    it('propagates non-CircuitOpen errors', async () => {
      const r = executeWithHostBreaker('https://api.x.com/u', async () => {
        throw new Error('500 internal');
      });
      await expect(r).rejects.toThrow('500 internal');
    });

    it('opens breaker after threshold failures + throws CircuitOpenError', async () => {
      const url = 'https://flaky.com/x';
      // 5 default failures → open
      for (let i = 0; i < 5; i += 1) {
        await expect(
          executeWithHostBreaker(url, async () => {
            throw new Error('flaky');
          }),
        ).rejects.toThrow();
      }
      // 6th call should fast-fail with our NodeCircuitOpenError
      await expect(
        executeWithHostBreaker(url, async () => 'should-not-run'),
      ).rejects.toBeInstanceOf(CircuitOpenError);
    });

    it('CircuitOpenError carries breakerName + nextProbeAt', async () => {
      const url = 'https://flaky2.com/x';
      for (let i = 0; i < 5; i += 1) {
        await expect(
          executeWithHostBreaker(url, async () => {
            throw new Error('e');
          }),
        ).rejects.toThrow();
      }
      try {
        await executeWithHostBreaker(url, async () => 'x');
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(CircuitOpenError);
        if (e instanceof CircuitOpenError) {
          expect(e.context.breakerName).toBe('http:flaky2.com');
          expect(e.context.nextProbeAt).toBeTypeOf('number');
        }
      }
    });

    it('different hosts have independent state', async () => {
      const goodUrl = 'https://good.com/x';
      const badUrl = 'https://bad.com/x';
      for (let i = 0; i < 5; i += 1) {
        await expect(
          executeWithHostBreaker(badUrl, async () => {
            throw new Error('e');
          }),
        ).rejects.toThrow();
      }
      // bad opens, good is unaffected
      await expect(executeWithHostBreaker(badUrl, async () => 'ok')).rejects.toBeInstanceOf(
        CircuitOpenError,
      );
      const r = await executeWithHostBreaker(goodUrl, async () => 'still-works');
      expect(r).toBe('still-works');
    });
  });

  describe('listBreakers', () => {
    it('returns empty when none registered', () => {
      expect(listBreakers()).toEqual([]);
    });

    it('lists all registered with state', async () => {
      getHostBreaker('a.com');
      getHostBreaker('b.com');
      const list = listBreakers();
      expect(list).toHaveLength(2);
      expect(list.every((b) => b.state === 'closed')).toBe(true);
    });
  });
});
