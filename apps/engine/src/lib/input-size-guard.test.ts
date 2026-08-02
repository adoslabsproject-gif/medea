import { describe, it, expect } from 'vitest';
import { assertInputSizeWithinCap } from './input-size-guard.js';

describe('🚨 assertInputSizeWithinCap — cap input anti-OOM (PURO, no alloc)', () => {
  it('entro il cap → non lancia', () => {
    expect(() => {
      assertInputSizeWithinCap(10 * 1024 * 1024, 32 * 1024 * 1024, 'PDF');
    }).not.toThrow();
  });
  it('esattamente al cap → non lancia (>, non >=)', () => {
    expect(() => {
      assertInputSizeWithinCap(32 * 1024 * 1024, 32 * 1024 * 1024, 'PDF');
    }).not.toThrow();
  });
  it('🚨 oltre il cap → lancia con label + Max MB (testa 33MB SENZA allocare nulla)', () => {
    expect(() => {
      assertInputSizeWithinCap(33 * 1024 * 1024, 32 * 1024 * 1024, 'PDF');
    }).toThrow(/PDF troppo grande.*Max 32 MB/);
  });
  it('🚨 label diverso (File 50MB) propagato', () => {
    expect(() => {
      assertInputSizeWithinCap(51 * 1024 * 1024, 50 * 1024 * 1024, 'File');
    }).toThrow(/File troppo grande.*Max 50 MB/);
  });
});
