import { describe, it, expect } from 'vitest';
import {
  classifyNodeVersionCompat,
  nodeVersionDrift,
  isBreakingNodeVersionDrift,
} from './node-version.js';

describe('classifyNodeVersionCompat', () => {
  it('versioni mancanti o malformate → unversioned (mai falso drift su legacy)', () => {
    expect(classifyNodeVersionCompat(undefined, '1.0.0')).toBe('unversioned');
    expect(classifyNodeVersionCompat('1.0.0', undefined)).toBe('unversioned');
    expect(classifyNodeVersionCompat(undefined, undefined)).toBe('unversioned');
    expect(classifyNodeVersionCompat('1.0', '1.0.0')).toBe('unversioned'); // non-semver
    expect(classifyNodeVersionCompat('', '')).toBe('unversioned');
    expect(classifyNodeVersionCompat('v1.0.0', '1.0.0')).toBe('unversioned'); // prefisso non valido
  });

  it('versioni uguali → current', () => {
    expect(classifyNodeVersionCompat('1.2.3', '1.2.3')).toBe('current');
    expect(classifyNodeVersionCompat('0.0.0', '0.0.0')).toBe('current');
  });

  it('corrente avanti di sola PATCH → patch-behind (safe)', () => {
    expect(classifyNodeVersionCompat('1.2.3', '1.2.4')).toBe('patch-behind');
    expect(classifyNodeVersionCompat('1.0.0', '1.0.9')).toBe('patch-behind');
  });

  it('corrente avanti di MINOR → minor-behind (additivo, safe)', () => {
    expect(classifyNodeVersionCompat('1.2.3', '1.3.0')).toBe('minor-behind');
    expect(classifyNodeVersionCompat('1.2.9', '1.5.0')).toBe('minor-behind');
    // minor bump prevale anche se patch torna indietro
    expect(classifyNodeVersionCompat('1.2.9', '1.3.0')).toBe('minor-behind');
  });

  it('corrente avanti di MAJOR → major-behind (potenziale breaking)', () => {
    expect(classifyNodeVersionCompat('1.2.3', '2.0.0')).toBe('major-behind');
    expect(classifyNodeVersionCompat('1.9.9', '2.0.0')).toBe('major-behind');
    expect(classifyNodeVersionCompat('1.0.0', '3.5.2')).toBe('major-behind');
  });

  it('pinnata più nuova della corrente → ahead (downgrade runtime)', () => {
    expect(classifyNodeVersionCompat('2.0.0', '1.9.9')).toBe('ahead');
    expect(classifyNodeVersionCompat('1.2.4', '1.2.3')).toBe('ahead');
    expect(classifyNodeVersionCompat('1.3.0', '1.2.9')).toBe('ahead');
  });
});

describe('nodeVersionDrift', () => {
  it('mappa la compat sul delta osservabile', () => {
    expect(nodeVersionDrift('major-behind')).toBe('major');
    expect(nodeVersionDrift('minor-behind')).toBe('minor');
    expect(nodeVersionDrift('patch-behind')).toBe('patch');
    expect(nodeVersionDrift('ahead')).toBe('ahead');
  });
  it('nessun delta per current/unversioned', () => {
    expect(nodeVersionDrift('current')).toBeNull();
    expect(nodeVersionDrift('unversioned')).toBeNull();
  });
});

describe('isBreakingNodeVersionDrift', () => {
  it('solo major-behind e ahead sono breaking', () => {
    expect(isBreakingNodeVersionDrift('major-behind')).toBe(true);
    expect(isBreakingNodeVersionDrift('ahead')).toBe(true);
  });
  it('patch/minor/current/unversioned NON sono breaking', () => {
    expect(isBreakingNodeVersionDrift('patch-behind')).toBe(false);
    expect(isBreakingNodeVersionDrift('minor-behind')).toBe(false);
    expect(isBreakingNodeVersionDrift('current')).toBe(false);
    expect(isBreakingNodeVersionDrift('unversioned')).toBe(false);
  });
});
