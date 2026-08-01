/**
 * Test — resolveServerExecutor: dispatch SICURO (no prototype-pollution).
 * Un defId del workflow (controllato dall'autore) come `constructor`/`toString`/
 * `__proto__` NON deve risolvere a una funzione del prototype di Object → solo
 * own-property di serverExecutors valgono (guard Object.hasOwn).
 */
import { describe, it, expect } from 'vitest';
import { resolveServerExecutor } from './registry.js';

describe('resolveServerExecutor — no prototype-pollution dispatch', () => {
  it('🚨🚨 chiavi del prototype di Object → undefined (mai chiamate come executor)', () => {
    for (const evil of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
      expect(resolveServerExecutor(evil), `"${evil}" non deve risolvere`).toBeUndefined();
    }
  });

  it('✅ un defId reale risolve a una funzione executor', () => {
    const exec = resolveServerExecutor('community_twilio');
    expect(typeof exec).toBe('function');
  });

  it('defId sconosciuto e non-community/custom → undefined', () => {
    expect(resolveServerExecutor('def_inesistente_xyz')).toBeUndefined();
  });
});
