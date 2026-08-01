/**
 * GUARD anti-regressione — confine browser/server del catalogo nodi.
 *
 * L'editor importa l'INTERO catalogo nodi (@flowforge/nodes-stdlib) per i
 * metadata (NodeDef): se anche UN nodo importa `node:fs`/`node:crypto`/… a
 * livello value top-level, Vite lo trascina nel bundle browser → warning
 * "externalized for browser" e peso inutile (incident 2026-06-09).
 *
 * Invariante blindato qui (fallisce il build se violato, anche fra mille nodi):
 *  1. Nessun file del catalogo importa un built-in Node a livello VALUE
 *     top-level. Gli executor che fanno I/O devono caricarlo LAZY (await import)
 *     o tenerne solo i tipi (import type, erased dal bundle).
 *  2. Gli engine server-only (allowlist) — che POSSONO usare node:* — sono
 *     importati dal resto del catalogo solo via `await import` o `import type`,
 *     mai eager.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// src/ del package (questo file è in src/web-extraction/).
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Engine server-only: possono importare node:* a top-level PERCHÉ sono caricati
// solo lazy a runtime server (mai nel grafo statico browser).
const SERVER_ONLY_ENGINES = new Set<string>(['asset-batch-download-engine.ts']);

const BUILTINS = 'fs|path|crypto|os|stream|zlib|child_process|net|http|https|tls|dns|worker_threads|readline|cluster|dgram|v8|vm|perf_hooks';
// import VALUE (NON `import type`) di un built-in Node, eventualmente con `node:`.
const VALUE_BUILTIN_IMPORT = new RegExp(
  `^import\\s+(?!type\\b)[^\\n;]*\\bfrom\\s+['"](?:node:)?(?:${BUILTINS})(?:/[^'"]+)?['"]`,
  'm',
);

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('nodi browser-safe — confine browser/server', () => {
  const files = walkTs(SRC_ROOT);

  it('trova un numero plausibile di file (il walk funziona)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('🚨 nessun nodo importa un built-in Node a livello VALUE top-level (solo engine server-only)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (SERVER_ONLY_ENGINES.has(basename(file))) continue;
      const m = VALUE_BUILTIN_IMPORT.exec(readFileSync(file, 'utf8'));
      if (m) offenders.push(`${file.slice(SRC_ROOT.length + 1)} → ${m[0].trim()}`);
    }
    expect(
      offenders,
      `Import VALUE di built-in Node in nodi importati dal browser (usa "await import" o "import type"):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('🚨 gli engine server-only sono importati solo LAZY (await import) o type-only, mai eager', () => {
    const violations: string[] = [];
    for (const engine of SERVER_ONLY_ENGINES) {
      const stem = engine.replace(/\.ts$/, '');
      const eagerRe = new RegExp(`^import\\s+(?!type\\b)[^\\n;]*\\bfrom\\s+['"][^'"]*${stem}\\.js['"]`, 'm');
      for (const file of files) {
        if (basename(file) === engine) continue;
        if (eagerRe.test(readFileSync(file, 'utf8'))) {
          violations.push(`${file.slice(SRC_ROOT.length + 1)} importa ${engine} EAGER — usa await import o import type`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('ogni engine in allowlist esiste davvero (no allowlist stale)', () => {
    const names = new Set(files.map((f) => basename(f)));
    for (const engine of SERVER_ONLY_ENGINES) expect(names.has(engine)).toBe(true);
  });
});
