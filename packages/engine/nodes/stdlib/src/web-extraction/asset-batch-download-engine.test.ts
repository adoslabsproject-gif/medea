/**
 * Test del confine path dell'asset-batch-download (H4 — path-traversal su dir sorella).
 *
 * Il bug: il caller usava `derived.startsWith(baseAbs)` SENZA boundary di separatore →
 * una dir SORELLA (`/data/t1-evil`) inizia per `/data/t1` e passava il check → un
 * `item.savePath` ostile (`../t1-evil/x`) scriveva FUORI dalla dir autorizzata.
 * Fix: helper PURO `isPathWithinBase` (boundary con separatore) condiviso col caller.
 */
import { describe, it, expect } from 'vitest';
import { isPathWithinBase, deriveLocalPath } from './asset-batch-download-engine.js';
import * as pathPosix from 'node:path/posix';

describe('isPathWithinBase — H4 boundary anti dir-sorella', () => {
  it('uguale a baseAbs → dentro', () => {
    expect(isPathWithinBase('/data/t1', '/data/t1', '/')).toBe(true);
  });
  it('sotto-dir legittima → dentro', () => {
    expect(isPathWithinBase('/data/t1/sub/x.png', '/data/t1', '/')).toBe(true);
  });
  it('🚨 dir SORELLA con prefisso comune → FUORI (era il bug: startsWith senza sep)', () => {
    expect(isPathWithinBase('/data/t1-evil/x', '/data/t1', '/')).toBe(false);
    expect(isPathWithinBase('/data/t1-evil', '/data/t1', '/')).toBe(false);
  });
  it('path completamente fuori → FUORI', () => {
    expect(isPathWithinBase('/etc/passwd', '/data/t1', '/')).toBe(false);
  });
});

describe('deriveLocalPath — traversal rifiutato (usa lo stesso helper)', () => {
  it('URL normale → path dentro la base', () => {
    const p = deriveLocalPath('https://ex.com/img/a.png', '/data/t1', pathPosix);
    expect(p).toBe('/data/t1/img/a.png');
  });
  it('🚨 null byte nel path (decodeURIComponent %00) → null (no path-truncation tricks)', () => {
    // NB: `new URL` normalizza i `..` (anche %2e%2e) → la risalita via URL è impossibile;
    // il vettore H4 reale era il ramo `item.savePath` (coperto dai test isPathWithinBase).
    // Qui copro l'altra guardia di deriveLocalPath: il null byte.
    expect(deriveLocalPath('https://ex.com/a%00b/c', '/data/t1', pathPosix)).toBeNull();
  });
  it('trailing slash → index.html dentro la base', () => {
    expect(deriveLocalPath('https://ex.com/dir/', '/data/t1', pathPosix)).toBe(
      '/data/t1/dir/index.html',
    );
  });
});
