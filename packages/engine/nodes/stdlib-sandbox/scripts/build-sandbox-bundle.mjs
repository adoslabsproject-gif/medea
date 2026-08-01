/**
 * build-sandbox-bundle.mjs — bundle TUTTI gli helper ff.* in un singolo
 * file ESM, browser-safe, iniettabile in isolated-vm via `ctx.eval(STDLIB_BUNDLE)`.
 *
 * Output:
 *  - dist/sandbox-bundle.js       (bundle ESM bundled+treeshaked+minified, ~10-30KB)
 *  - dist/sandbox-bundle-source.js (export const STDLIB_BUNDLE = '...';)
 *  - dist/sandbox-bundle-source.d.ts
 *
 * Il consumer (runtime sandbox) importa `STDLIB_BUNDLE` come stringa e fa
 * `ctx.eval(STDLIB_BUNDLE)` PRIMA del vendor source → l'isolate vede `ff.*`
 * come global available.
 *
 * Footer customizato: invece di `export const ff = {...}` (che non funziona
 * in isolated-vm senza ESM), aggiunge `globalThis.ff = ff;` per esposizione
 * come global var dentro la sandbox.
 */
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const DIST = resolve(ROOT, 'dist');

await mkdir(DIST, { recursive: true });

// Bundle ESM mono-file via esbuild — pure IIFE per isolated-vm (no ESM module system inside)
const result = await build({
  entryPoints: [resolve(ROOT, 'src/index.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'ffExports',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  treeShaking: true,
  write: false,
  // Stripping references to globalThis.btoa (browser env) — nostra crypto.ts
  // fa fallback automatico a base64 manuale se non disponibile.
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  banner: {
    js: '/* @flowforge/nodes-stdlib-sandbox bundle — DO NOT EDIT (autogen) */',
  },
  // Footer: bind `ff` come global. ffExports.ff e\` esposto dall'IIFE.
  footer: {
    js: 'globalThis.ff = ffExports.ff; globalThis.ffExports = ffExports;',
  },
});

const bundledJs = result.outputFiles[0].text;
const bundlePath = resolve(DIST, 'sandbox-bundle.js');
await writeFile(bundlePath, bundledJs, 'utf-8');
console.log(`✓ wrote ${bundlePath} (${bundledJs.length} bytes)`);

// Source-exporter: TS file che esporta il bundle come stringa per consumer Node
const sourceModule = `/**
 * @flowforge/nodes-stdlib-sandbox/bundle-source — string export del bundle.
 *
 * Usa STDLIB_BUNDLE nel runtime sandbox:
 *   await ctx.eval(STDLIB_BUNDLE);
 *   await ctx.eval(vendorSource);
 *
 * IL FILE E\` AUTOGEN — non editare. Rebuild con \`pnpm run bundle\`.
 */
export const STDLIB_BUNDLE = ${JSON.stringify(bundledJs)};
export const STDLIB_BUNDLE_BYTES = ${bundledJs.length};
export const STDLIB_BUNDLE_GLOBAL_NAME = 'ff';
`;

const sourcePath = resolve(DIST, 'sandbox-bundle-source.js');
await writeFile(sourcePath, sourceModule, 'utf-8');
console.log(`✓ wrote ${sourcePath}`);

const sourceDts = `export declare const STDLIB_BUNDLE: string;
export declare const STDLIB_BUNDLE_BYTES: number;
export declare const STDLIB_BUNDLE_GLOBAL_NAME: 'ff';
`;
await writeFile(resolve(DIST, 'sandbox-bundle-source.d.ts'), sourceDts, 'utf-8');
console.log(`✓ wrote sandbox-bundle-source.d.ts`);

console.log(`\n📦 STDLIB_BUNDLE pronto: ${(bundledJs.length / 1024).toFixed(1)}KB`);
