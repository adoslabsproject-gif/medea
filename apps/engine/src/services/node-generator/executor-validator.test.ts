/**
 * Test executor-ast + executor-validator — la validazione STATICA del codice
 * generato. Bug-bounty sui BYPASS che la vecchia blacklist regex NON vedeva
 * (bracket-access, spazi/newline, alias) + happy path + sintassi/firma/return.
 */
import { describe, it, expect } from 'vitest';
import { analyzeExecutor } from './executor-ast.js';
import { validateExecutor, hasSecurityViolation } from './executor-validator.js';

const GOOD = 'async function execute(config, input, context) { const r = await fetch(config.url); return { output: await r.text(), durationMs: 1 }; }';

describe('analyzeExecutor — fatti AST', () => {
  it('executor valido → trova execute async, 3 param, return, niente vietati', () => {
    const f = analyzeExecutor(GOOD);
    expect(f.syntaxErrors).toEqual([]);
    expect(f.execute).toMatchObject({ found: true, isAsync: true });
    expect(f.execute.paramNames).toEqual(['config', 'input', 'context']);
    expect(f.hasReturnValue).toBe(true);
    expect(f.forbiddenRefs).toEqual([]);
    expect(f.configKeysUsed).toEqual(['url']);
  });

  it('arrow function assegnata a execute è riconosciuta', () => {
    const f = analyzeExecutor('const execute = async (config, input, context) => { return { ok: true }; };');
    expect(f.execute.found).toBe(true);
    expect(f.execute.isAsync).toBe(true);
  });

  it('🚨 config["chiave"] (bracket) riconosciuta come config key', () => {
    const f = analyzeExecutor('async function execute(c, i, x) { return { v: c["apiKey"] }; }');
    expect(f.configKeysUsed).toEqual(['apiKey']);
  });

  it('🚨 context.secrets["TOKEN"] riconosciuto come secret usato', () => {
    const f = analyzeExecutor('async function execute(c, i, ctx) { return { v: ctx.secrets["TOKEN"] }; }');
    expect(f.secretsUsed).toEqual(['TOKEN']);
  });
});

describe('validateExecutor — violazioni di sicurezza (AST, non regex)', () => {
  it.each([
    ['require()', 'async function execute(c,i,x){ const fs=require("fs"); return {}; }'],
    ['eval', 'async function execute(c,i,x){ eval(c.code); return {}; }'],
    ['process.env', 'async function execute(c,i,x){ return { s: process.env.SECRET }; }'],
    ['new Function', 'async function execute(c,i,x){ new Function("return 1")(); return {}; }'],
    ['globalThis', 'async function execute(c,i,x){ globalThis.process.exit(0); return {}; }'],
    ['fs', 'async function execute(c,i,x){ fs.readFileSync("/etc/passwd"); return {}; }'],
  ])('🚨 reject classico "%s"', (_name, code) => {
    const v = validateExecutor(code);
    expect(hasSecurityViolation(v)).toBe(true);
  });

  // ── I BYPASS che la regex /\b(require|process\.env|...)\b/ NON catturava ──
  it('🚨 BYPASS bracket-access globalThis["process"] → comunque bloccato (flag su globalThis)', () => {
    const v = validateExecutor('async function execute(c,i,x){ const p = globalThis["process"]; return {}; }');
    expect(hasSecurityViolation(v)).toBe(true);
  });

  it('🚨 BYPASS process["env"] (regex cercava "process.env" col punto) → bloccato', () => {
    const v = validateExecutor('async function execute(c,i,x){ return { s: process["env"]["SECRET"] }; }');
    expect(hasSecurityViolation(v)).toBe(true);
  });

  it('🚨 BYPASS spazio: require ("fs") con spazio prima della paren → bloccato', () => {
    const v = validateExecutor('async function execute(c,i,x){ const fs = require ("fs"); return {}; }');
    expect(hasSecurityViolation(v)).toBe(true);
  });

  it('🚨 import statico + import() dinamico → forbidden_import', () => {
    expect(validateExecutor('import fs from "fs"; async function execute(c,i,x){ return {}; }').some((v) => v.kind === 'forbidden_import')).toBe(true);
    expect(validateExecutor('async function execute(c,i,x){ const m = await import("fs"); return {}; }').some((v) => v.kind === 'forbidden_import')).toBe(true);
  });

  it('🚨 NON è un falso positivo: una PROPRIETÀ chiamata `process` su un oggetto utente è ammessa', () => {
    const v = validateExecutor('async function execute(c,i,x){ const o = { process: 1 }; return { v: o.process }; }');
    expect(hasSecurityViolation(v)).toBe(false); // mut: se flaggassimo i property-name, fallirebbe
  });
});

describe('validateExecutor — qualità (sintassi/firma/return)', () => {
  it('🚨 sintassi rotta → syntax_error', () => {
    const v = validateExecutor('async function execute(c,i,x) { return {');
    expect(v.some((x) => x.kind === 'syntax_error')).toBe(true);
  });

  it('🚨 manca execute → missing_execute', () => {
    const v = validateExecutor('async function altro(c,i,x){ return {}; }');
    expect(v.some((x) => x.kind === 'missing_execute')).toBe(true);
  });

  it('🚨 execute non async → not_async', () => {
    const v = validateExecutor('function execute(config, input, context){ return {}; }');
    expect(v.some((x) => x.kind === 'not_async')).toBe(true);
  });

  it('🚨 arità < 3 → bad_arity', () => {
    const v = validateExecutor('async function execute(config){ return {}; }');
    expect(v.some((x) => x.kind === 'bad_arity')).toBe(true);
  });

  it('🚨 nessun return con valore → no_return', () => {
    const v = validateExecutor('async function execute(config, input, context){ const x = 1; }');
    expect(v.some((x) => x.kind === 'no_return')).toBe(true);
  });

  it('executor valido → zero violazioni', () => {
    expect(validateExecutor(GOOD)).toEqual([]);
  });
});
