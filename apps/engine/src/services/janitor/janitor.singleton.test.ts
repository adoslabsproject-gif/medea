/**
 * Bug-bounty UNIT — services/janitor/janitor.singleton.ts (audit coverage
 * 2026-06-12: 27%). Accessor singleton set-once. Pinniamo: getJanitor PRIMA
 * dell'init → throw con messaggio diagnostico (non null silenzioso),
 * set→get ritorna l'istanza, reset pulisce, set sovrascrive.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setJanitor, getJanitor, resetJanitorSingleton } from './janitor.singleton.js';
import type { JanitorRuntime } from './infrastructure/janitor.factory.js';

const fakeRuntime = (tag: string) => ({ __tag: tag }) as unknown as JanitorRuntime;

beforeEach(() => {
  resetJanitorSingleton();
});

describe('janitor singleton', () => {
  it('getJanitor PRIMA di setJanitor → throw con messaggio che indica boot mancante', () => {
    expect(() => getJanitor()).toThrow(/non inizializzato.*setJanitor.*main\.ts/s);
  });

  it('set → get ritorna ESATTAMENTE l istanza settata', () => {
    const r = fakeRuntime('a');
    setJanitor(r);
    expect(getJanitor()).toBe(r);
  });

  it('set sovrascrive (l ultima vince)', () => {
    setJanitor(fakeRuntime('a'));
    const second = fakeRuntime('b');
    setJanitor(second);
    expect(getJanitor()).toBe(second);
  });

  it('reset → getJanitor torna a lanciare (stato pulito tra i test)', () => {
    setJanitor(fakeRuntime('a'));
    resetJanitorSingleton();
    expect(() => getJanitor()).toThrow(/non inizializzato/);
  });
});
