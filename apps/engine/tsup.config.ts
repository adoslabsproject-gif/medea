/**
 * tsup config — bundle Single File per Docker runtime.
 *
 * Build context: dentro l'immagine Docker Linux. Risolve TUTTI i problemi
 * che avevo localmente (Mac vs Linux native bindings, type:module conflicts,
 * ecc.) perché siamo in ambiente Linux uniforme dal Dockerfile.
 *
 * Strategia minimal:
 *   - noExternal [/^@medea\/engine-/]: bundla le workspace deps interne
 *   - Tutte le altre npm restano external → installate da pnpm install
 *     nell'immagine Docker (linux x64 native bindings build OK)
 */

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/main.ts',
    // Worker thread per community-node sandbox (Cappella Sistina, 2026-06-08).
    // Bundle separato dist/community-node-sandbox.worker.js — caricato via
    // new Worker(path) dal main.js. Senza questo entry, il main bundle
    // non avrebbe accanto a se\` il worker file e l'esecuzione custom-node
    // farebbe MODULE_NOT_FOUND.
    'src/executors/community-node-sandbox.worker.ts',
  ],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  outDir: 'dist',
  shims: false,
  // Banner: createRequire(import.meta.url) per supportare CJS deps interne
  // al bundle ESM (sql-escaper, mysql2, alcuni transitive che fanno
  // `require('buffer')` runtime). Senza, Dynamic require throw error.
  banner: {
    js:
      "import { createRequire as __medea_createRequire } from 'node:module';\n" +
      "const require = __medea_createRequire(import.meta.url);",
  },
  // Bundla le dipendenze interne del workspace, cioè tutto `@medea/engine-*`
  // (per esempio @medea/engine-shared = maskEmail, circuit-breaker, ecc.).
  // Se restassero fuori, il bundle ESM farebbe `import '@medea/engine-shared'`
  // a runtime, ma quel pacchetto non sta in node_modules dell'immagine finale
  // → MODULE_NOT_FOUND all'avvio del motore.
  //
  // Il pattern deve restare allineato ai nomi veri dei pacchetti: fino al
  // 2026-08-02 diceva `@flowforge/` e `@zeliai/`, e dopo la rinomina non
  // avrebbe più corrisposto a niente — silenziosamente, senza errori di build.
  //
  // OTel: bundlato per coerenza versione (sdk-node 0.217 + resources 2.x richiedono
  // allineamento inter-package che pnpm prod install nell'image potrebbe non garantire).
  noExternal: [/^@medea\/engine-/, /^@opentelemetry\//],
  external: [
    // ⚠️ esbuild: MAI bundlare (FIX 2026-06-13 "esbuild compile failed:
    // __filename is not defined"). esbuild usa __filename internamente per
    // localizzare il suo binario nativo; bundlato in ESM → __filename undefined
    // → OGNI compile di custom node falliva. External = caricato da node_modules
    // (CJS, __filename definito) + binario nativo risolto. Richiede esbuild in
    // `dependencies` (non devDependencies) così l'install prod dell'image lo include.
    'esbuild',
    // Native bindings — non bundlable, restano require() runtime via node_modules.
    'better-sqlite3',
    'isolated-vm',
    'argon2',
    'bindings',
    'node-gyp-build',
    '@duckdb/node-api',
    '@duckdb/node-bindings',
    '@duckdb/node-bindings-linux-x64',
    '@duckdb/node-bindings-linux-x64-musl',
    '@duckdb/node-bindings-linux-arm64',
    '@duckdb/node-bindings-linux-arm64-musl',
    '@duckdb/node-bindings-darwin-x64',
    '@duckdb/node-bindings-darwin-arm64',
    '@duckdb/node-bindings-win32-x64',
    '@duckdb/node-bindings-win32-arm64',
  ],
});
