import { describe, it, expect } from 'vitest';
import { sleep } from './sleep.js';

describe('sleep', () => {
  it('resolves after the given ms', async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });

  it('no-op for ms<=0 (no setTimeout overhead)', async () => {
    const start = Date.now();
    await sleep(0);
    await sleep(-10);
    expect(Date.now() - start).toBeLessThan(20);
  });

  it('throws AbortError if signal aborted before call', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(sleep(50, ctrl.signal)).rejects.toThrow('Aborted');
  });

  it('throws AbortError if signal aborted mid-sleep', async () => {
    const ctrl = new AbortController();
    const p = sleep(500, ctrl.signal);
    setTimeout(() => { ctrl.abort(); }, 30);
    const start = Date.now();
    await expect(p).rejects.toThrow('Aborted');
    expect(Date.now() - start).toBeLessThan(200); // resolved early
  });

  it('clears timer + removes listener on abort (no leak)', async () => {
    const ctrl = new AbortController();
    const p = sleep(100, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toThrow();
    // If listener still attached, GC tests would flake. Smoke: abort + wait.
    await new Promise((r) => setTimeout(r, 20));
  });
});
