import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cadenzato } from './cadenza';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('cadenzato', () => {
  it('il primo valore passa subito', () => {
    const f = vi.fn();
    cadenzato(f, 100)('a');
    expect(f).toHaveBeenCalledWith('a');
  });

  it('una raffica diventa poche chiamate', () => {
    const f = vi.fn();
    const c = cadenzato(f, 100);
    for (let i = 0; i < 50; i++) {
      c(`testo-${String(i)}`);
      vi.advanceTimersByTime(4);
    }
    // 200 ms di raffica a un intervallo di 100: una manciata, non cinquanta.
    expect(f.mock.calls.length).toBeLessThanOrEqual(4);
    expect(f.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  /** Se l'ultimo pezzo si perdesse, la risposta resterebbe monca a schermo. */
  it('l’ultimo valore arriva sempre, anche se era a ridosso del precedente', () => {
    const f = vi.fn();
    const c = cadenzato(f, 100);
    c('primo');
    vi.advanceTimersByTime(10);
    c('secondo');
    vi.advanceTimersByTime(10);
    c('ultimo');
    expect(f).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    expect(f).toHaveBeenCalledTimes(2);
    expect(f).toHaveBeenLastCalledWith('ultimo');
  });

  it('passato l’intervallo, il valore successivo passa di nuovo subito', () => {
    const f = vi.fn();
    const c = cadenzato(f, 100);
    c('a');
    vi.advanceTimersByTime(150);
    c('b');
    expect(f).toHaveBeenLastCalledWith('b');
    expect(f).toHaveBeenCalledTimes(2);
  });
});
