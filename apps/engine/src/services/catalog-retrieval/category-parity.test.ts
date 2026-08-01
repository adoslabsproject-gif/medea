/**
 * PARITY cross-app — la categoria del runtime (inferCategory) DEVE restare
 * allineata all'euristica del portal (sync-node-defs.mjs). Se una delle due
 * diverge, le tassonomie si scollano in silenzio. Questo test legge il SORGENTE
 * del portal e verifica che gli override espliciti coincidano.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPLICIT_CATEGORY, inferCategory } from './category.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const portalSyncSrc = readFileSync(
  join(__dirname, '../../../../portal/scripts/sync-node-defs.mjs'),
  'utf-8',
);

describe('category parity runtime ↔ portal', () => {
  it('ogni override EXPLICIT_CATEGORY del runtime esiste identico nel portal', () => {
    const block = /const EXPLICIT_CATEGORY = \{([\s\S]*?)\};/.exec(portalSyncSrc);
    expect(block, 'EXPLICIT_CATEGORY non trovato nel portal sync script').toBeTruthy();
    const portalBody = block![1]!;
    const mismatches: string[] = [];
    for (const [id, cat] of Object.entries(EXPLICIT_CATEGORY)) {
      // cerca `id: 'cat'` nel sorgente portal
      const re = new RegExp(`${id}:\\s*'([^']+)'`);
      const m = portalBody.match(re);
      if (!m) mismatches.push(`${id}: assente nel portal`);
      else if (m[1] !== cat) mismatches.push(`${id}: runtime='${cat}' portal='${m[1]!}'`);
    }
    expect(mismatches, mismatches.join('; ')).toEqual([]);
  });

  it('le fallback per-substring del runtime coincidono coi casi noti del portal', () => {
    // I rami chiave dell'euristica devono dare lo stesso esito.
    expect(inferCategory('integration_x', 'action')).toBe('integrations');
    expect(inferCategory('italia_x', 'action')).toBe('italia');
    expect(inferCategory('x_pdf_y', 'action')).toBe('files');
    expect(inferCategory('x_db_y', 'action')).toBe('database');
    expect(portalSyncSrc).toContain("if (id.startsWith('integration_')) return 'integrations';");
    expect(portalSyncSrc).toContain("if (id.includes('db_'))            return 'database';");
  });
});
