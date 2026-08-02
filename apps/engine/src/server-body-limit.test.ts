/**
 * AUDIT FIX WE-10 (2026-06-09 HIGH) — REGRESSION GUARD source inspection.
 *
 * Verifica che il server.ts contiene il bodyLimit middleware globale.
 *
 * Pre-fix bug:
 *   c.req.json() / c.req.text() senza limite size → JSON-bomb attack su
 *   POST /workflows/:id/run (triggerInput), PUT /workflows/:id/pins/:nodeId
 *   (output_json TEXT column SQLite senza CHECK → DB bloat), n8n-import,
 *   webhooks. Un user può uploadare GB di JSON → OOM container o disk-full.
 *
 * Post-fix: app.use('*', bodyLimit({ maxSize: 10MB })) middleware globale.
 * Risposta 413 BODY_TOO_LARGE per richieste over-cap.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(join(__dirname, 'server.ts'), 'utf-8');

describe('🚨 [REGRESSION WE-10] server.ts bodyLimit middleware globale', () => {
  it('🚨 importa hono/body-limit', () => {
    expect(serverSource).toMatch(
      /import.*from\s*['"]hono\/body-limit['"]|await import\(['"]hono\/body-limit['"]\)/,
    );
  });

  it("🚨 applica bodyLimit globale (`app.use('*', bodyLimit(...))`)", () => {
    expect(serverSource).toMatch(/app\.use\(\s*['"]\*['"]\s*,\s*bodyLimit\(/);
  });

  it('🚨 maxSize 10MB (10 * 1024 * 1024)', () => {
    expect(serverSource).toMatch(/maxSize:\s*10\s*\*\s*1024\s*\*\s*1024/);
  });

  it('🚨 onError ritorna 413 con code BODY_TOO_LARGE', () => {
    // Pattern: onError: (c) => c.json({ error: { code: 'BODY_TOO_LARGE', ... } }, 413)
    expect(serverSource).toMatch(/code:\s*['"]BODY_TOO_LARGE['"]/);
    expect(serverSource).toMatch(/onError:[\s\S]*?413/);
  });

  it('🚨 bodyLimit montato PRIMA di route mount (timeline guard)', () => {
    // Il bodyLimit deve apparire PRIMA della prima `app.route(` mount in modo
    // che si applichi a TUTTE le route.
    const bodyLimitIdx = serverSource.search(/bodyLimit\(\s*\{/);
    const firstRouteIdx = serverSource.search(/app\.route\(/);
    expect(bodyLimitIdx).toBeGreaterThan(-1);
    expect(firstRouteIdx).toBeGreaterThan(-1);
    expect(bodyLimitIdx, 'bodyLimit deve essere DICHIARATO prima di app.route()').toBeLessThan(
      firstRouteIdx,
    );
  });
});
