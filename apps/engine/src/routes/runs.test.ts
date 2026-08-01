/**
 * Tests per `routes/runs.ts` — N17 + N18 audit (2026-05-29).
 *
 * Strategia: source inspection — la route Hono wrappa Service+rateLimit
 * middleware, e farne setup completo end-to-end richiede DB+migration.
 * Verifico via regex che le guard siano CABLATE alla route corretta
 * (subworkflowDepth parsing + rateLimit middleware su replay).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runsSource = readFileSync(join(__dirname, 'runs.ts'), 'utf-8');

describe('N17 — POST /workflows/:id/run reads X-Subworkflow-Depth header', () => {
  it('legge header x-subworkflow-depth', () => {
    expect(runsSource).toMatch(/c\.req\.header\(['"]x-subworkflow-depth['"]\)/);
  });

  it('parsing via Number + Number.isFinite guard', () => {
    expect(runsSource).toMatch(/Number\.isFinite/);
  });

  it('clamp a [0, 1_000_000] (anti-forge)', () => {
    expect(runsSource).toMatch(/Math\.max\(0,\s*Math\.min\(1_000_000/);
  });

  it('Math.floor per evitare float injection', () => {
    expect(runsSource).toMatch(/Math\.floor\(depthParsed\)/);
  });

  it('subworkflowDepth passato a input quando definito', () => {
    expect(runsSource).toMatch(/input\.subworkflowDepth\s*=\s*subworkflowDepth/);
  });

  it('depth header missing → undefined (no fallback errato)', () => {
    // Pattern: depthHeader !== undefined ? Number(...) : NaN → Number.isFinite(NaN)=false → undefined
    expect(runsSource).toMatch(/depthHeader\s*!==\s*undefined\s*\?\s*Number\(depthHeader\)\s*:\s*NaN/);
  });
});

describe('N18 — POST /runs/:id/replay rate-limited', () => {
  it('importa rateLimit middleware', () => {
    expect(runsSource).toMatch(/import\s*\{\s*rateLimit\s*\}\s*from\s*['"]@\/middleware\/rate-limit/);
  });

  it('rateLimit applicato direttamente sulla route /runs/:id/replay', () => {
    // Pattern: app.post('/runs/:id/replay', rateLimit({...}), async (c) => {
    expect(runsSource).toMatch(/app\.post\(\s*['"]\/runs\/:id\/replay['"]\s*,\s*rateLimit\(/);
  });

  it('label = run-replay (per metrics labels)', () => {
    expect(runsSource).toMatch(/label:\s*['"]run-replay['"]/);
  });

  it('perUser cap 20/min (10x normale ma cap su rogue script)', () => {
    expect(runsSource).toMatch(/perUser:\s*20/);
  });

  it('perTenant cap 60/min (3x user — supporta team simultaneo)', () => {
    expect(runsSource).toMatch(/perTenant:\s*60/);
  });

  it('windowMs 60_000 (sliding 1min)', () => {
    expect(runsSource).toMatch(/windowMs:\s*60_000/);
  });

  it('REGRESSION: solo replay + ai-debug hanno rateLimit (cancel + run no)', () => {
    // /workflows/:id/run e /runs/:id/cancel non hanno rateLimit applied su questo
    // file (per design — run e\` documented entry, cancel idempotente cheap).
    // Aggiunto /runs/:id/ai-debug (D3 2026-06-06): chiama Liara, va capped.
    const limited = [...runsSource.matchAll(/app\.post\(\s*['"](\/[^'"]+)['"]\s*,\s*rateLimit/g)]
      .map((m) => m[1]);
    expect(limited.sort()).toEqual(['/runs/:id/ai-debug', '/runs/:id/replay']);
  });
});

describe('D3 — POST /runs/:id/ai-debug rate-limited (LLM spend cap)', () => {
  it('ai-debug route è wired con rateLimit middleware', () => {
    expect(runsSource).toMatch(/app\.post\(\s*['"]\/runs\/:id\/ai-debug['"]\s*,\s*rateLimit\(/);
  });

  it('label = run-ai-debug', () => {
    expect(runsSource).toMatch(/label:\s*['"]run-ai-debug['"]/);
  });

  it('perUser cap 5/min (LLM spend cap — più stretto di replay)', () => {
    expect(runsSource).toMatch(/perUser:\s*5/);
  });

  it('perTenant cap 20/min', () => {
    expect(runsSource).toMatch(/perTenant:\s*20/);
  });

  it('chiama debugRunFailureExecutor con tenantId + runId del path', () => {
    expect(runsSource).toMatch(/debugRunFailureExecutor\(/);
    expect(runsSource).toMatch(/runId,\s*\.\.\.\(failedNodeId/);
  });
});

describe('N18 — runId guard (TS safety + 400 explicit)', () => {
  it('runId fallback su "" se param mancante', () => {
    expect(runsSource).toMatch(/c\.req\.param\(['"]id['"]\)\s*\?\?\s*['"]['"]/);
  });

  it('throw 400 con missing run id su path corrotto', () => {
    expect(runsSource).toMatch(/runId === ''[\s\S]{1,40}return c\.json\(\{ error: 'missing run id'/);
  });
});
