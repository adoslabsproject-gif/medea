/**
 * Custom Node Editor — server-side compile pipeline (esbuild + security scan).
 *
 * Steps eseguiti in ordine (fail-fast):
 *   1. Security scan AST-light: regex per pattern proibiti (require, eval,
 *      Function(), child_process, node:fs, __proto__, ecc.). Defense layer 1.
 *   2. esbuild transform TS→JS (IIFE format, no externals, no imports da
 *      `node:*`). Defense layer 2: l'output non puo\` avere require/import.
 *   3. Round-trip parse: il bundle output va eseguito in isolated-vm
 *      preview (timeout 1s) per validare syntax + entry point export.
 *      Solo se preview OK, persistiamo.
 *
 * Pattern enterprise: il sandbox isolated-vm runtime gia\` esiste
 * (executors/community-node-sandbox.ts). Qui validiamo PRIMA di salvare
 * per UX rapida (utente vede errori in editor invece di runtime failure).
 *
 * @module services/custom-nodes/compile.service
 */

import * as esbuild from 'esbuild';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CustomNodeCompileError, CustomNodeSecurityViolationError } from './errors.js';
import { astSecurityScan } from './ast-security-scan.js';
import { persistCompileResult } from './service.js';
import type { CompileDiagnostic } from './types.js';

/**
 * resolveDir per i moduli virtuali: fa risolvere a esbuild i bare import
 * REALI da bundlare (zod) dai node_modules dell'app runtime — sia in dev/test
 * (src/) sia nel container (dist/main.js → walk-up a /app/node_modules).
 */
const NODE_RESOLVE_DIR = dirname(fileURLToPath(import.meta.url));

/** Pattern proibiti — defense layer 1 (regex-based AST-light). */
const FORBIDDEN_PATTERNS: { regex: RegExp; reason: string }[] = [
  { regex: /\brequire\s*\(/, reason: 'CommonJS require() not allowed (use ES modules)' },
  { regex: /\beval\s*\(/, reason: 'eval() is forbidden (security)' },
  { regex: /new\s+Function\s*\(/, reason: 'Function() constructor is forbidden (security)' },
  { regex: /\bchild_process\b/, reason: 'child_process is forbidden (sandbox)' },
  { regex: /\b__proto__\b/, reason: '__proto__ access is forbidden (prototype pollution)' },
  { regex: /\bprocess\s*\.\s*env\b/, reason: 'process.env access is forbidden (use config injection)' },
  { regex: /\bprocess\s*\.\s*exit\b/, reason: 'process.exit() is forbidden' },
  { regex: /\bnode\s*:\s*fs\b/, reason: 'node:fs is forbidden (sandbox)' },
  { regex: /\bnode\s*:\s*net\b/, reason: 'node:net is forbidden (use safeOutboundFetch)' },
  { regex: /\bnode\s*:\s*os\b/, reason: 'node:os is forbidden (info leak)' },
  { regex: /\bnode\s*:\s*worker_threads\b/, reason: 'worker_threads is forbidden (sandbox escape)' },
  { regex: /\bnode\s*:\s*vm\b/, reason: 'node:vm is forbidden (nested sandbox)' },
  { regex: /\bimport\s*\(\s*["'`]/, reason: 'Dynamic import() is forbidden (only static imports)' },
];

/**
 * Esegue il security scan sui 3 source files. Ritorna i violations trovati
 * (mai throw — il caller decide se fare hard fail o solo warn).
 */
export function securityScan(sources: {
  executor: string; definition: string; schema: string;
}): CompileDiagnostic[] {
  const violations: CompileDiagnostic[] = [];
  const files: { name: 'executor' | 'definition' | 'schema'; code: string }[] = [
    { name: 'executor', code: sources.executor },
    { name: 'definition', code: sources.definition },
    { name: 'schema', code: sources.schema },
  ];
  for (const file of files) {
    const lines = file.code.split('\n');
    lines.forEach((line, idx) => {
      for (const { regex, reason } of FORBIDDEN_PATTERNS) {
        const m = regex.exec(line);
        if (m) {
          violations.push({
            severity: 'error',
            line: idx + 1,
            col: (m.index ?? 0) + 1,
            message: reason,
            code: 'SECURITY_FORBIDDEN_PATTERN',
            file: file.name,
          });
        }
      }
    });
  }
  return violations;
}

/**
 * Compila i 3 source TS in un singolo bundle JS IIFE.
 *
 * Strategy:
 *   - esbuild transform 3 file separati (executor, definition, schema)
 *   - Bundle via stdin virtual con import {} relativi → singolo output
 *   - Format IIFE, no externals, target esnext (isolated-vm V8 v12+)
 *   - tsconfig minimal: strict false (l'utente puo\` scrivere TS rilassato)
 *
 * Return: { compiledExecutor, warnings } o throws CompileError con diagnostics.
 */
export async function compileCustomNodeSources(sources: {
  executor: string; definition: string; schema: string;
}): Promise<{ compiledExecutor: string; warnings: CompileDiagnostic[] }> {
  // Layer 1: security scan. DUE reti complementari:
  //  - securityScan (regex): messaggistica veloce riga-per-riga.
  //  - astSecurityScan (AST): rete FINE — becca bracket-notation/aliasing/eval/Function/
  //    import dinamici che la regex aggira (è il gate che decide la pubblicabilità, #7).
  const violations = [...securityScan(sources), ...(await astSecurityScan(sources))];
  const securityErrors = violations.filter((v) => v.severity === 'error');
  if (securityErrors.length > 0) {
    // DX 2026-06-13: prima il messaggio era solo il CONTEGGIO ("1 security
    // violation(s) detected") e le violazioni NON finivano nei diagnostics →
    // l'utente non sapeva COSA togliere. Ora: messaggio con la causa reale +
    // tutte le violazioni nei diagnostics (file:line + motivo, visibili nel pannello).
    const first = securityErrors[0]!;
    const message = securityErrors.length === 1
      ? `${first.file}:${first.line} — ${first.message}`
      : `${securityErrors.length} violazioni di sicurezza: ${securityErrors.map((v) => `${v.file}:${v.line} ${v.message}`).join(' · ')}`;
    throw new CustomNodeSecurityViolationError(
      message,
      { file: first.file, line: first.line, diagnostics: securityErrors },
    );
  }

  // Layer 2: esbuild transform
  // Bundle "in-memory": stdin virtual che esporta i 3 simboli
  const virtualEntry = `
    import { executor } from 'virtual:executor';
    import { definition } from 'virtual:definition';
    import { schema } from 'virtual:schema';
    export { executor, definition, schema };
  `;

  let result: esbuild.BuildResult;
  try {
    result = await esbuild.build({
      stdin: { contents: virtualEntry, loader: 'ts' },
      bundle: true,
      format: 'iife',
      globalName: '__customNode',
      target: 'esnext',
      platform: 'neutral',
      logLevel: 'silent',
      write: false,
      // SDK imports: NIENTE external. Il sandbox isolated-vm NON ha `require`
      // (per design): un external in formato iife diventa `__require(...)`
      // che THROWA a runtime — il vecchio commento prometteva uno "shim
      // injection (Fase 2c)" MAI implementato, e il test-run di QUALUNQUE
      // nodo che usava zod falliva (scovato dall'E2E catena, 2026-06-12).
      //   • zod                          → bundlato DENTRO (puro JS, sandbox-safe)
      //   • @medea/engine-safe-fetch        → modulo virtuale che mappa sulla
      //     fetch del sandbox (l'SSRF guard vive HOST-side nel fetch bridge)
      //   • @medea/engine-community-node-sdk → stub vuoto (solo tipi: erased)
      plugins: [{
        name: 'virtual-loader',
        setup(build) {
          build.onResolve({ filter: /^virtual:/ }, (args) => ({
            path: args.path, namespace: 'virtual',
          }));
          // DX (2026-06-13): import FRATELLI tra i 3 file del nodo. Naturale
          // scrivere `import { schema } from './schema.js'` nell'executor per
          // riusare il proprio schema/definition. Mappa ./schema|./definition|
          // ./executor (con/senza estensione) ai virtual sibling. Gli import
          // RELATIVI ad ALTRI path (../../core/…) restano errore: il custom node
          // è auto-contenuto in 3 file (niente filesystem nel sandbox).
          // NB: filtro esbuild = regex Go (RE2), NIENTE flag 'u' (lo rifiuta).
          build.onResolve({ filter: /^\.\/(executor|definition|schema)(\.[jt]s)?$/ }, (args) => {
            const name = /\/(executor|definition|schema)/u.exec(args.path)![1]!;
            return { path: `virtual:${name}`, namespace: 'virtual' };
          });
          build.onResolve({ filter: /^@medea\/engine-(community-node-sdk|safe-fetch)$/ }, (args) => ({
            path: args.path, namespace: 'sdk-shim',
          }));
          build.onLoad({ filter: /.*/, namespace: 'sdk-shim' }, (args) => {
            if (args.path === '@medea/engine-safe-fetch') {
              // timeoutMs è gestito dal fetch bridge host-side (che ha già
              // timeout + SSRF guard): qui va solo rimosso dall'init.
              return {
                contents: `export async function safeFetch(url, init) {
                  const { timeoutMs, ...rest } = init ?? {};
                  return fetch(url, rest);
                }
                export default { safeFetch };`,
                loader: 'js',
              };
            }
            // community-node-sdk: superficie runtime vuota (import type erased).
            return { contents: 'export default {};', loader: 'js' };
          });
          build.onLoad({ filter: /.*/, namespace: 'virtual' }, (args) => {
            switch (args.path) {
              case 'virtual:executor':
                return { contents: sources.executor, loader: 'ts', resolveDir: NODE_RESOLVE_DIR };
              case 'virtual:definition':
                return { contents: sources.definition, loader: 'ts', resolveDir: NODE_RESOLVE_DIR };
              case 'virtual:schema':
                return { contents: sources.schema, loader: 'ts', resolveDir: NODE_RESOLVE_DIR };
              default:
                return { errors: [{ text: `Unknown virtual: ${args.path}` }] };
            }
          });
        },
      }],
    });
  } catch (err) {
    const { message, diagnostics } = compileFailureFromError(err);
    throw new CustomNodeCompileError(message, { diagnostics });
  }

  const warningsDiag: CompileDiagnostic[] = [
    ...violations.filter((v) => v.severity !== 'error'),
    ...(result.warnings ?? []).map(esbuildMsgToDiagnostic),
  ];

  const output = result.outputFiles?.[0]?.text;
  if (!output || output.length === 0) {
    throw new CustomNodeCompileError('esbuild produced empty output', { diagnostics: [] });
  }

  return { compiledExecutor: output, warnings: warningsDiag };
}

/**
 * Convenience: compila + persiste sul DB in una sola call.
 * Usato dal route POST /custom-nodes/:id/compile.
 */
export async function compileAndPersist(opts: {
  workspaceId: string;
  id: string;
  sources: { executor: string; definition: string; schema: string };
}): Promise<{ compiledExecutor: string; warnings: CompileDiagnostic[] }> {
  const result = await compileCustomNodeSources(opts.sources);
  await persistCompileResult({
    workspaceId: opts.workspaceId,
    id: opts.id,
    compiledExecutor: result.compiledExecutor,
    warnings: result.warnings,
  });
  return result;
}

/**
 * Costruisce messaggio + diagnostics da un errore di esbuild (BuildFailure o no).
 *
 * ⚠️ BUG FIX 2026-06-13 (incidente "Streammy Search Multichannel"): esbuild può
 * fallire SENZA `errors` strutturati — eccezione non-BuildFailure (plugin che
 * throwa, errore interno, OOM…). Prima il messaggio diventava
 * "esbuild compile failed: 0 error(s)" e NASCONDEVA la causa reale. Ora, se non
 * ci sono diagnostics strutturati, sintetizziamo un diagnostic dal messaggio
 * vero dell'errore (visibile in editor) e lo includiamo nel messaggio.
 *
 * Esportato per test diretto (esbuild.build è un export ESM non-spiabile).
 */
export function compileFailureFromError(err: unknown): { message: string; diagnostics: CompileDiagnostic[] } {
  const e = err as { errors?: esbuild.Message[] } | null | undefined;
  const diagnostics = (e?.errors ?? []).map(esbuildMsgToDiagnostic);
  if (diagnostics.length === 0) {
    const realMsg = err instanceof Error && err.message ? err.message : String(err);
    return {
      message: `esbuild compile failed: ${realMsg}`,
      diagnostics: [{ severity: 'error', line: 0, col: 0, message: realMsg, code: 'ESBUILD', file: 'executor' }],
    };
  }
  return {
    message: `esbuild compile failed: ${diagnostics.length} error(s)`,
    diagnostics,
  };
}

function esbuildMsgToDiagnostic(m: esbuild.Message): CompileDiagnostic {
  // Mappa file path → file kind (executor/definition/schema)
  const path = m.location?.file ?? '';
  let file: CompileDiagnostic['file'] = 'executor';
  if (path.includes('virtual:definition')) file = 'definition';
  else if (path.includes('virtual:schema')) file = 'schema';
  return {
    severity: m.location?.line === undefined ? 'info' : 'error',
    line: m.location?.line ?? 0,
    col: m.location?.column ?? 0,
    message: actionableMessage(m.text),
    code: 'ESBUILD',
    file,
  };
}

/**
 * DX (2026-06-13): trasforma "Could not resolve "../x"" in un messaggio
 * AZIONABILE. I custom node sono auto-contenuti (3 file: executor/definition/
 * schema); un import relativo verso ALTRI path non esiste nel sandbox. Spieghiamo
 * cosa fare invece di lasciare l'utente col criptico errore esbuild.
 */
export function actionableMessage(text: string): string {
  const m = /Could not resolve ["']((?:\.\.?\/)[^"']+)["']/u.exec(text);
  if (!m) return text;
  const spec = m[1]!;
  const sibling = /^\.\/(executor|definition|schema)(\.[jt]s)?$/u.test(spec);
  if (sibling) return text; // i fratelli si risolvono (non dovrebbe capitare)
  return `${text} — i custom node sono AUTO-CONTENUTI (solo executor/definition/schema). `
    + `"${spec}" è fuori dal nodo: inlinea quel codice qui dentro, oppure usa solo `
    + `gli import consentiti (zod, @medea/engine-safe-fetch) e le Web API (fetch, crypto). `
    + `Tip: chiedi alla chat Liara "rendi l'executor auto-contenuto, inlinea gli import esterni".`;
}
