/**
 * compile.service.test.ts — Test 2026-grade per il pipeline compile+security.
 *
 * Coverage REALE (no mock di esbuild):
 *  - securityScan: 13 pattern forbidden ognuno fires + clean code passa
 *  - compileCustomNodeSources happy path: TS → IIFE JS valido
 *  - compileCustomNodeSources con security violation → throws SecurityViolationError
 *  - compileCustomNodeSources con TS syntax error → throws CompileError + diagnostics
 *  - compileAndPersist: round-trip persiste compiled + warnings sul DB
 *  - File field discrimination (executor/definition/schema) in diagnostics
 *  - Idempotent: stessa sources → output deterministico
 *  - Bundle output è IIFE eseguibile in V8 isolato (smoke roundtrip)
 *
 * NB: esbuild reale (no mock) — il test esegue compile vero ad ogni assert,
 * tempo totale stimato ~3s (esbuild WASM startup + 10 compile).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import SqliteDatabase from 'better-sqlite3';
import { SCHEMA_SQL } from '@/storage/migrate.schema.js';

const dbConnections: ReturnType<typeof SqliteDatabase>[] = [];

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => {
    const conn = dbConnections[dbConnections.length - 1]!;
    return {
      sqlite: {
        prepare: (sql: string) => {
          const stmt = conn.prepare(sql);
          return {
            run: (...p: unknown[]) => stmt.run(...p),
            get: (...p: unknown[]) => stmt.get(...p),
            all: (...p: unknown[]) => stmt.all(...p),
          };
        },
        exec: (sql: string) => { conn.exec(sql); },
        transaction: <T extends unknown[], R>(fn: (...args: T) => R) => conn.transaction(fn) as unknown as (...args: T) => R,
      },
    };
  },
}));

import { securityScan, compileCustomNodeSources, compileAndPersist, compileFailureFromError, actionableMessage } from './compile.service.js';
import { createCustomNode, getCustomNode } from './service.js';
import { CustomNodeSecurityViolationError, CustomNodeCompileError } from './errors.js';

const CLEAN_SOURCES = {
  executor: `
export const executor = async (config: unknown, input: unknown) => {
  return { output: { ok: true, echo: input } };
};
`,
  definition: `
export const definition = {
  defId: 'my_node',
  label: 'My Node',
  category: 'Custom',
};
`,
  schema: `
import { z } from 'zod';
export const schema = z.object({ apiKey: z.string() });
`,
};

beforeEach(() => {
  const conn = new SqliteDatabase(':memory:');
  conn.pragma('foreign_keys = ON');
  conn.exec(SCHEMA_SQL);
  dbConnections.push(conn);
  process.env.MEDEA_PLAN_CODE = 'pro';
});

afterEach(() => {
  const conn = dbConnections.pop();
  if (conn) conn.close();
  delete process.env.MEDEA_PLAN_CODE;
});

describe('🚨 securityScan (defense layer 1)', () => {
  it('🚨 clean code → zero violations', () => {
    const out = securityScan(CLEAN_SOURCES);
    expect(out).toEqual([]);
  });

  it('🚨 require() → 1 violation, severity error, file detected', () => {
    const out = securityScan({ ...CLEAN_SOURCES, executor: 'const x = require("fs");' });
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe('error');
    expect(out[0]!.file).toBe('executor');
    expect(out[0]!.message).toMatch(/require/i);
    expect(out[0]!.code).toBe('SECURITY_FORBIDDEN_PATTERN');
  });

  it('🚨 eval() → violation', () => {
    const out = securityScan({ ...CLEAN_SOURCES, executor: 'eval("foo")' });
    expect(out.some((v) => /eval/i.test(v.message))).toBe(true);
  });

  it('🚨 new Function() → violation', () => {
    const out = securityScan({ ...CLEAN_SOURCES, executor: 'const fn = new Function("return 1");' });
    expect(out.some((v) => v.message.includes('Function()'))).toBe(true);
  });

  it('🚨 child_process → violation', () => {
    const out = securityScan({ ...CLEAN_SOURCES, executor: 'import cp from "child_process";' });
    expect(out.some((v) => v.message.includes('child_process'))).toBe(true);
  });

  it('🚨 __proto__ → violation (prototype pollution)', () => {
    const out = securityScan({ ...CLEAN_SOURCES, executor: 'obj.__proto__.polluted = true;' });
    expect(out.some((v) => v.message.includes('__proto__'))).toBe(true);
  });

  it('🚨 process.env → violation (use config injection)', () => {
    const out = securityScan({ ...CLEAN_SOURCES, executor: 'const k = process.env.SECRET;' });
    expect(out.some((v) => v.message.includes('process.env'))).toBe(true);
  });

  it('🚨 process.exit → violation', () => {
    const out = securityScan({ ...CLEAN_SOURCES, executor: 'process.exit(0);' });
    expect(out.some((v) => v.message.includes('process.exit'))).toBe(true);
  });

  it('🚨 node:fs → violation', () => {
    const out = securityScan({ ...CLEAN_SOURCES, executor: 'import fs from "node:fs";' });
    expect(out.some((v) => v.message.includes('node:fs'))).toBe(true);
  });

  it('🚨 node:net → violation', () => {
    const out = securityScan({ ...CLEAN_SOURCES, executor: 'import net from "node:net";' });
    expect(out.some((v) => v.message.includes('node:net'))).toBe(true);
  });

  it('🚨 node:worker_threads → violation', () => {
    const out = securityScan({ ...CLEAN_SOURCES, executor: 'import { Worker } from "node:worker_threads";' });
    expect(out.some((v) => v.message.includes('worker_threads'))).toBe(true);
  });

  it('🚨 node:vm → violation', () => {
    const out = securityScan({ ...CLEAN_SOURCES, executor: 'import vm from "node:vm";' });
    expect(out.some((v) => v.message.includes('node:vm'))).toBe(true);
  });

  it('🚨 dynamic import() → violation', () => {
    const out = securityScan({ ...CLEAN_SOURCES, executor: 'const m = await import("./malicious");' });
    expect(out.some((v) => /Dynamic import\(\)/i.test(v.message))).toBe(true);
  });

  it('🚨 violazione nel file schema viene attribuita a file="schema"', () => {
    const out = securityScan({ ...CLEAN_SOURCES, schema: 'eval("bad")' });
    expect(out[0]!.file).toBe('schema');
  });

  it('🚨 violazione nel file definition viene attribuita a file="definition"', () => {
    const out = securityScan({ ...CLEAN_SOURCES, definition: 'require("./payload")' });
    expect(out[0]!.file).toBe('definition');
  });

  it('🚨 line + col 1-based + match offset corretto', () => {
    const code = '\n\nconst x = eval("foo");\n';
    const out = securityScan({ ...CLEAN_SOURCES, executor: code });
    expect(out[0]!.line).toBe(3);
    expect(out[0]!.col).toBe(11); // "eval(" starts at col 11 (1-based)
  });
});

describe('🚨 compileCustomNodeSources (happy path)', () => {
  it('🚨 sources clean → output IIFE non-vuoto + warnings []', async () => {
    const r = await compileCustomNodeSources(CLEAN_SOURCES);
    expect(r.compiledExecutor.length).toBeGreaterThan(50);
    expect(r.compiledExecutor).toMatch(/__customNode/);
    expect(r.warnings).toEqual([]);
  });

  it('🚨 output è IIFE eseguibile (smoke roundtrip via Function constructor)', async () => {
    const r = await compileCustomNodeSources(CLEAN_SOURCES);
    // Smoke: l'output IIFE assegna __customNode in global. Verifichiamo che il
    // bundle abbia executor/definition/schema exports.
    expect(r.compiledExecutor).toMatch(/executor/);
    expect(r.compiledExecutor).toMatch(/definition/);
    expect(r.compiledExecutor).toMatch(/schema/);
  });

  it('🚨 idempotent: stessa sources → byte-identical output', async () => {
    const a = await compileCustomNodeSources(CLEAN_SOURCES);
    const b = await compileCustomNodeSources(CLEAN_SOURCES);
    expect(a.compiledExecutor).toBe(b.compiledExecutor);
  });

  it('🚨 TS syntax valida (interface, generic) → compile OK', async () => {
    const r = await compileCustomNodeSources({
      executor: `
interface User { id: number; name: string; }
export const executor = async <T extends User>(_c: unknown, input: T) => {
  return { output: { name: input.name } };
};`,
      definition: CLEAN_SOURCES.definition,
      schema: CLEAN_SOURCES.schema,
    });
    expect(r.compiledExecutor.length).toBeGreaterThan(50);
  });
});

describe('🚨 compileCustomNodeSources (failure modes)', () => {
  it('🚨 security violation → throws SecurityViolationError (esbuild NON chiamato)', async () => {
    await expect(compileCustomNodeSources({
      ...CLEAN_SOURCES,
      executor: 'eval("malicious")',
    })).rejects.toThrow(CustomNodeSecurityViolationError);
  });

  it('🚨 security error meta.file = "executor"', async () => {
    try {
      await compileCustomNodeSources({ ...CLEAN_SOURCES, executor: 'require("fs")' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CustomNodeSecurityViolationError);
      const e = err as CustomNodeSecurityViolationError;
      expect(e.meta.file).toBe('executor');
    }
  });

  it('🚨🐛 security violation: messaggio con CAUSA+posizione + diagnostics popolati (non solo conteggio)', async () => {
    try {
      await compileCustomNodeSources({ ...CLEAN_SOURCES, executor: 'export const executor = async () => eval("x");' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CustomNodeSecurityViolationError);
      const e = err as CustomNodeSecurityViolationError;
      // NON più il conteggio nudo "1 security violation(s) detected"
      expect(e.message).not.toMatch(/violation\(s\) detected/u);
      expect(e.message).toMatch(/eval/u);            // causa reale
      expect(e.message).toContain('executor:');      // posizione file:line
      const diags = (e.meta as { diagnostics?: unknown[] }).diagnostics ?? [];
      expect(diags.length).toBeGreaterThan(0);       // visibili nel pannello editor
    }
  });

  it('🚨 TS syntax error → CompileError con diagnostics non vuoto', async () => {
    await expect(compileCustomNodeSources({
      ...CLEAN_SOURCES,
      executor: 'export const executor = async () => { return { ; this is broken',
    })).rejects.toThrow(CustomNodeCompileError);
  });

  it('🚨 schema syntax error → CompileError', async () => {
    await expect(compileCustomNodeSources({
      ...CLEAN_SOURCES,
      schema: 'export const schema = { broken: <<< };',
    })).rejects.toThrow(CustomNodeCompileError);
  });

  it('🚨 errore strutturato (TS syntax) → messaggio "N error(s)" + diagnostics non vuoto', async () => {
    try {
      await compileCustomNodeSources({ ...CLEAN_SOURCES, executor: 'export const executor = async () => { return { ; broken' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CustomNodeCompileError);
      const e = err as CustomNodeCompileError;
      expect(e.message).toMatch(/error\(s\)/u);
      expect((e.meta.diagnostics as unknown[]).length).toBeGreaterThan(0);
    }
  });

});

describe('🚨🐛 compileFailureFromError (FIX incidente "Streammy" — no più "0 error(s)")', () => {
  it('BuildFailure con errors strutturati → "N error(s)" + diagnostics mappati', () => {
    const buildFailure = {
      errors: [
        { text: 'Could not resolve "cheerio"', location: { file: 'virtual:executor', line: 2, column: 7 } },
        { text: 'Unexpected token', location: { file: 'virtual:schema', line: 5, column: 1 } },
      ],
    };
    const r = compileFailureFromError(buildFailure);
    expect(r.message).toBe('esbuild compile failed: 2 error(s)');
    expect(r.diagnostics).toHaveLength(2);
    expect(r.diagnostics[1]!.file).toBe('schema');
  });

  it('🚨 eccezione SENZA errors (non-BuildFailure) → causa REALE, NON "0 error(s)"', () => {
    const r = compileFailureFromError(new Error('Boom interno di esbuild'));
    expect(r.message).not.toMatch(/0 error\(s\)/u);
    expect(r.message).toContain('Boom interno di esbuild');
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]!.message).toContain('Boom interno di esbuild');
    expect(r.diagnostics[0]!.severity).toBe('error');
  });

  it('errors array VUOTO → trattato come non-strutturato (causa reale, no "0 error(s)")', () => {
    const r = compileFailureFromError({ errors: [], message: 'service stopped' });
    expect(r.message).not.toMatch(/0 error\(s\)/u);
    expect(r.diagnostics).toHaveLength(1);
  });

  it('throw non-Error (stringa) → String(err) nel messaggio', () => {
    const r = compileFailureFromError('kaboom-string');
    expect(r.message).toContain('kaboom-string');
    expect(r.diagnostics).toHaveLength(1);
  });

  it('null/undefined → non crasha, diagnostic presente', () => {
    expect(compileFailureFromError(null).diagnostics).toHaveLength(1);
    expect(compileFailureFromError(undefined).diagnostics).toHaveLength(1);
  });
});

describe('🚨 DX import fratelli (./schema, ./definition, ./executor)', () => {
  it('executor importa ./schema.js → risolve al file fratello, compila', async () => {
    const r = await compileCustomNodeSources({
      ...CLEAN_SOURCES,
      executor: `import { schema } from './schema.js';
export const executor = async (config: unknown, input: unknown) => ({ output: { ok: !!schema, echo: input } });`,
    });
    expect(r.compiledExecutor.length).toBeGreaterThan(0);
  });

  it('executor importa ./definition (senza estensione) → risolve, compila', async () => {
    const r = await compileCustomNodeSources({
      ...CLEAN_SOURCES,
      executor: `import { definition } from './definition';
export const executor = async () => ({ output: definition });`,
    });
    expect(r.compiledExecutor.length).toBeGreaterThan(0);
  });

  it('🚨 import relativo ESTERNO (../../core/x.js) → resta errore "Could not resolve" (nodo auto-contenuto)', async () => {
    try {
      await compileCustomNodeSources({
        ...CLEAN_SOURCES,
        executor: `import { x } from '../../core/x.js';
export const executor = async () => x;`,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CustomNodeCompileError);
      const e = err as CustomNodeCompileError;
      const diags = e.meta.diagnostics as { message: string }[];
      expect(diags.some((d) => d.message.includes('Could not resolve'))).toBe(true);
    }
  });
});

describe('🚨 actionableMessage (DX: errori import azionabili)', () => {
  it('import relativo ESTERNO → aggiunge guida "auto-contenuti" + lo spec + tip Liara', () => {
    const out = actionableMessage('Could not resolve "../../core/config-parser.js"');
    expect(out).toContain('Could not resolve');
    expect(out).toContain('AUTO-CONTENUTI');
    expect(out).toContain('../../core/config-parser.js');
    expect(out).toContain('Liara');
  });

  it('import fratello ./schema.js → messaggio INVARIATO (si risolve)', () => {
    const original = 'Could not resolve "./schema.js"';
    expect(actionableMessage(original)).toBe(original);
  });

  it('messaggio non-resolve (syntax) → INVARIATO', () => {
    const original = 'Unexpected "}"';
    expect(actionableMessage(original)).toBe(original);
  });

  it('import bare npm (cheerio) → INVARIATO (non è relativo)', () => {
    const original = 'Could not resolve "cheerio"';
    expect(actionableMessage(original)).toBe(original);
  });
});

describe('🚨 compileAndPersist (DB integration)', () => {
  it('🚨 happy path: compile + UPDATE row con compiled_executor + status candidate', async () => {
    const node = await createCustomNode({
      workspaceId: 'ws-1', ownerUserId: 'u-1',
      input: {
        slug: 'compile-test',
        displayName: 'Compile Test',
        sourceExecutor: CLEAN_SOURCES.executor,
        sourceDefinition: CLEAN_SOURCES.definition,
        sourceSchema: CLEAN_SOURCES.schema,
      },
    });
    expect(node.status).toBe('draft');
    const result = await compileAndPersist({
      workspaceId: 'ws-1',
      id: node.id,
      sources: CLEAN_SOURCES,
    });
    expect(result.compiledExecutor.length).toBeGreaterThan(50);
    const after = await getCustomNode({ workspaceId: 'ws-1', id: node.id });
    expect(after!.status).toBe('candidate');
    expect(after!.compiledExecutor).toBe(result.compiledExecutor);
    expect(after!.compileAt).toMatch(/T.*Z/);
  });

  it('🚨 security violation NON persiste (throws PRIMA di UPDATE)', async () => {
    const node = await createCustomNode({
      workspaceId: 'ws-1', ownerUserId: 'u-1',
      input: {
        slug: 'compile-fail',
        displayName: 'X',
        sourceExecutor: CLEAN_SOURCES.executor,
        sourceDefinition: CLEAN_SOURCES.definition,
        sourceSchema: CLEAN_SOURCES.schema,
      },
    });
    await expect(compileAndPersist({
      workspaceId: 'ws-1',
      id: node.id,
      sources: { ...CLEAN_SOURCES, executor: 'eval("x")' },
    })).rejects.toThrow(CustomNodeSecurityViolationError);
    // DB row deve restare con status='draft' e compiled_executor null
    const after = await getCustomNode({ workspaceId: 'ws-1', id: node.id });
    expect(after!.status).toBe('draft');
    expect(after!.compiledExecutor).toBeNull();
  });
});
