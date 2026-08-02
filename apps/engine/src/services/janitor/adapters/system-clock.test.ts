/**
 * Test 2026-grade — adapters/system-clock.ts (IClock prod impl).
 *
 * 🚨 NOW: Date instance recente. epochMs: number monotonico positivo.
 *    nowIso: ISO 8601 UTC con ms.
 *
 * 🚨 CONSISTENCY: now/epochMs/nowIso entro 1ms tra loro.
 */
import { describe, it, expect } from 'vitest';
import { SystemClock } from './system-clock.js';

describe('🚨 SystemClock — IClock impl', () => {
  it('🚨 now() → Date instance recente', () => {
    const clock = new SystemClock();
    const before = Date.now();
    const now = clock.now();
    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThan(before + 100);
  });

  it('🚨 epochMs() → number positivo', () => {
    const clock = new SystemClock();
    const ms = clock.epochMs();
    expect(typeof ms).toBe('number');
    expect(ms).toBeGreaterThan(0);
  });

  it('🚨 nowIso() → ISO 8601 UTC con ms', () => {
    const clock = new SystemClock();
    const iso = clock.nowIso();
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('🚨 nowIso() parsable as valid Date', () => {
    const clock = new SystemClock();
    const iso = clock.nowIso();
    expect(new Date(iso).toString()).not.toBe('Invalid Date');
  });

  it('🚨 epochMs e now.getTime() consistenti (entro 1ms)', () => {
    const clock = new SystemClock();
    const a = clock.epochMs();
    const b = clock.now().getTime();
    expect(Math.abs(a - b)).toBeLessThanOrEqual(2);
  });

  it('🚨 nowIso e now.toISOString consistenti', () => {
    const clock = new SystemClock();
    const iso1 = clock.nowIso();
    const iso2 = clock.now().toISOString();
    // Stesso secondo
    expect(iso1.slice(0, 19)).toBe(iso2.slice(0, 19));
  });

  it('🚨 IClock contract: monotonic forward', async () => {
    const clock = new SystemClock();
    const a = clock.epochMs();
    await new Promise((r) => setTimeout(r, 5));
    const b = clock.epochMs();
    expect(b).toBeGreaterThan(a);
  });
});
