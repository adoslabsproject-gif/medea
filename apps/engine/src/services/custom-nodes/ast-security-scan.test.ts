/**
 * Test bug-bounty — astSecurityScan. Verifica che l'AST becchi i bypass che la
 * regex-blocklist aggira, SENZA falsi positivi sul codice lecito.
 *
 * astSecurityScan è ASYNC: typescript è caricato LAZY (non a boot) per non far
 * crashare il bundle ESM di produzione (ERR_AMBIGUOUS_MODULE_SYNTAX su Node 22).
 */
import { describe, it, expect } from 'vitest';
import { astSecurityScan } from './ast-security-scan.js';

/** Scansiona uno snippet come file `executor` (gli altri due vuoti). */
async function scan(executor: string): Promise<Awaited<ReturnType<typeof astSecurityScan>>> {
  return astSecurityScan({ executor, definition: '', schema: '' });
}
const codes = async (snippet: string): Promise<string[]> => (await scan(snippet)).map((v) => v.code ?? '');
const blocked = async (snippet: string): Promise<boolean> => (await scan(snippet)).length > 0;

describe('astSecurityScan — bypass della regex-blocklist BECCATI', () => {
  it('🚨 bracket notation: process["env"] → bloccato (la regex cerca process.env)', async () => {
    expect(await blocked("const x = process['env'].SECRET;")).toBe(true);
    expect(await codes("const x = process['env'];")).toContain('SECURITY_AST_FORBIDDEN_GLOBAL');
  });

  it('🚨 aliasing: const p = process; p.env → bloccato al riferimento `process`', async () => {
    expect(await blocked('const p = process;\nconst y = p.env;')).toBe(true);
  });

  it('🚨 global indiretto: globalThis["process"] → bloccato (globalThis vietato)', async () => {
    expect(await blocked('const p = globalThis["process"];')).toBe(true);
  });

  it('🚨 eval(...) → bloccato', async () => {
    expect(await codes('eval("2+2");')).toContain('SECURITY_AST_FORBIDDEN_GLOBAL');
  });

  it('🚨 new Function(code) → bloccato (code injection come eval)', async () => {
    expect(await blocked('const f = new Function("return process");')).toBe(true);
  });

  it('🚨 require(...) → bloccato', async () => {
    expect(await blocked('const fs = require("fs");')).toBe(true);
  });

  it('🚨 import() dinamico → bloccato', async () => {
    expect(await codes('async function f(){ await import("node:fs"); }')).toContain('SECURITY_AST_DYNAMIC_IMPORT');
  });

  it('🚨 import statico node:* → bloccato', async () => {
    expect(await codes('import { readFile } from "node:fs";')).toContain('SECURITY_AST_FORBIDDEN_IMPORT');
  });

  it('🚨 __proto__ (dot e computed) → bloccato (prototype pollution)', async () => {
    expect(await codes('obj.__proto__.polluted = 1;')).toContain('SECURITY_AST_PROTO');
    expect(await codes('obj["__proto__"].polluted = 1;')).toContain('SECURITY_AST_PROTO');
  });

  it('🚨 __dirname / __filename / module / global → bloccati', async () => {
    expect(await blocked('const d = __dirname;')).toBe(true);
    expect(await blocked('const f = __filename;')).toBe(true);
    expect(await blocked('module.exports = {};')).toBe(true);
    expect(await blocked('const g = global;')).toBe(true);
  });
});

describe('astSecurityScan — ANTI-REGRESSIONE: codice lecito NON bloccato', () => {
  it('proprietà di nome "process"/"env" su un oggetto utente → OK (non è il globale)', async () => {
    expect(await blocked('const cfg = { process: "etl", env: "prod" };\nconst a = cfg.process;\nconst b = cfg.env;')).toBe(false);
  });

  it('parametro/variabile locale non collide con globali (nessun uso del globale) → OK', async () => {
    expect(await blocked('function run(input: { id: number }) { return input.id; }')).toBe(false);
  });

  it('tipo `Function` in annotazione → OK (non è il costruttore)', async () => {
    expect(await blocked('function call(cb: Function) { return cb(); }')).toBe(false);
  });

  it('import statico leciti (SDK) → OK', async () => {
    expect(await blocked('import { z } from "zod";\nimport { helper } from "./helper.js";')).toBe(false);
  });

  it('executor realistico (business logic) → 0 violazioni', async () => {
    const exec = `
      import { z } from 'zod';
      export const executor = async (config: { url: string }, input: unknown) => {
        const items = Array.isArray(input) ? input : [input];
        const out = items.map((it) => ({ ...(it as object), tag: config.url }));
        return { output: out, durationMs: 1 };
      };
    `;
    expect(await scan(exec)).toHaveLength(0);
  });
});

describe('astSecurityScan — multi-file + posizione', () => {
  it('riporta file e line corretti per ogni sorgente', async () => {
    const r = await astSecurityScan({
      executor: 'const a = 1;\nconst b = process.env;',
      definition: 'const d = require("x");',
      schema: 'export const schema = {};',
    });
    expect(r.some((v) => v.file === 'executor' && v.line === 2)).toBe(true);
    expect(r.some((v) => v.file === 'definition' && v.line === 1)).toBe(true);
    expect(r.some((v) => v.file === 'schema')).toBe(false);
  });

  it('🚨 LAZY typescript: scan funziona (no crash da import a boot)', async () => {
    // Guard del fix: astSecurityScan carica typescript lazy e ritorna risultati.
    // MUTATION: se l'import tornasse eager top-level, il bundle prod crasherebbe a boot.
    const r = await scan('eval("x");');
    expect(r.length).toBeGreaterThan(0);
  });
});
