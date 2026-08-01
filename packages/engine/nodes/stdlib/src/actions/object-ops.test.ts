/**
 * Test bug-bounty — object-ops (action_set_fields + action_coalesce).
 * Era SENZA test (gap gate). Copre dot-path, keepOnly, rename/remove, no-mutazione,
 * coalesce con 0/false (non-nullish), default, treatEmptyAsMissing + l'ANTI-CORRUZIONE
 * dati: gli zeri iniziali (CAP/telefono/P.IVA) NON vengono convertiti a numero.
 */
import { describe, it, expect } from 'vitest';
import { setFieldsNode, coalesceNode } from './object-ops.js';

const setF = setFieldsNode.executor!;
const coal = coalesceNode.executor!;
const ctx = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} } as never;
const out = async (exec: typeof setF, cfg: Record<string, unknown>, input?: unknown) =>
  (await exec(cfg, input, ctx)).output as Record<string, unknown>;

describe('action_set_fields', () => {
  it('imposta dot-path creando oggetti intermedi', async () => {
    const r = await out(setF, { assignments: { 'cliente.stato': 'attivo' } }, {});
    expect((r.result as { cliente: { stato: string } }).cliente.stato).toBe('attivo');
  });
  it.each([
    ['__proto__', { '__proto__.polluted': 'yes' }],
    ['constructor.prototype', { 'constructor.prototype.polluted': 'yes' }],
    ['prototype', { 'prototype.polluted': 'yes' }],
  ])('🚨 SECURITY: assignment via %s NON inquina Object.prototype (CWE-1321)', async (_l, assignments) => {
    // MUTATION: senza il guard FORBIDDEN_PATH_KEYS, setPath naviga fino a
    // Object.prototype e ({}).polluted diventerebbe 'yes' globalmente → rosso.
    await out(setF, { assignments }, {});
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // cleanup difensivo nel caso (improbabile) il guard fallisse durante lo sviluppo
    delete (Object.prototype as Record<string, unknown>).polluted;
  });
  it('🚨 SECURITY: removeFields con __proto__ è no-op safe (no pollution/crash)', async () => {
    const r = await out(setF, { removeFields: '__proto__.x,constructor.prototype.y' }, { keep: 1 });
    expect((r.result as { keep: number }).keep).toBe(1);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
  it('🚨 NON muta l\'input (deep-clone difensivo)', async () => {
    const input = { a: { b: 1 } };
    await out(setF, { assignments: { 'a.b': 2 } }, input);
    expect(input.a.b).toBe(1);
  });
  it('keepOnly = whitelist (parte da oggetto vuoto)', async () => {
    const r = await out(setF, { keepOnly: 'true', assignments: { nome: 'X' } }, { nome: 'X', segreto: 'Y' });
    expect(r.result).toEqual({ nome: 'X' });
  });
  it('rename + remove', async () => {
    const r = await out(setF, { renameFields: { Email: 'email' }, removeFields: 'tmp' }, { Email: 'a@b.it', tmp: 1 });
    expect(r.result).toEqual({ email: 'a@b.it' });
  });
  it('coerceTypes ON: "42"→42, "true"→true, JSON→obj', async () => {
    const r = await out(setF, { assignments: { n: '42', b: 'true', o: '{"x":1}' } }, {});
    expect(r.result).toMatchObject({ n: 42, b: true, o: { x: 1 } });
  });
  it('🚨 ANTI-CORRUZIONE: CAP "00184"/telefono "0612345" restano STRINGHE (no perdita zero)', async () => {
    const r = await out(setF, { assignments: { cap: '00184', tel: '0612345' } }, {});
    expect(r.result).toMatchObject({ cap: '00184', tel: '0612345' });
  });
  it('coerceTypes OFF: tutto stringa', async () => {
    const r = await out(setF, { coerceTypes: 'false', assignments: { n: '42' } }, {});
    expect((r.result as { n: unknown }).n).toBe('42');
  });
});

describe('action_coalesce', () => {
  const src = { a: '', b: null, c: 'valore', d: 0 };
  it('salta vuoti/null e prende il primo valido + riporta "from"', async () => {
    const r = await out(coal, { paths: 'a, b, c' }, src);
    expect(r.result).toBe('valore');
    expect(r.from).toBe('c');
    expect(r.found).toBe(true);
  });
  it('🚨 0 e false NON sono "missing" (solo nullish/vuoto)', async () => {
    const r = await out(coal, { paths: 'd' }, src);
    expect(r.result).toBe(0);
    expect(r.found).toBe(true);
  });
  it('default quando nessuna sorgente valida', async () => {
    const r = await out(coal, { paths: 'a, b', default: 'Cliente' }, src);
    expect(r.result).toBe('Cliente');
    expect(r.from).toBe('(default)');
    expect(r.found).toBe(false);
  });
  it('treatEmptyAsMissing=false → "" è un valore valido', async () => {
    const r = await out(coal, { paths: 'a, c', treatEmptyAsMissing: 'false' }, src);
    expect(r.result).toBe('');
    expect(r.from).toBe('a');
  });
});
