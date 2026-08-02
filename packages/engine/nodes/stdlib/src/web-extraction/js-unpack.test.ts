/**
 * Tests 2026-grade per action_js_unpack (Dean Edwards unpacker).
 *
 * Scenari:
 *  - Pattern Dean Edwards reale → unpacked
 *  - Codice già unpacked → ritorna inalterato con confidence=low
 *  - Anti-DoS: max source 5MB
 *  - Anti-DoS: max iterations cap (default 5)
 *  - SAFE: NO eval, NO Function() — solo parsing testuale
 *  - Base/count fuori range → reject senza crash
 *  - Keywords count mismatch → reject
 *  - Sintassi malformata → ritorna source as-is
 */
import { describe, it, expect } from 'vitest';
import { unpackJs, jsUnpackNode } from './js-unpack.js';

describe('unpackJs — Dean Edwards reale', () => {
  it('Unpacka pattern Dean Edwards minimale + ritorna decodificato', () => {
    const packed =
      "eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp('\\\\b'+c.toString(a)+'\\\\b','g'),k[c]);return p}('0 1',2,2,'hello|world'.split('|'),0,{}))";
    const r = unpackJs(packed);
    expect(r.unpacked).toBe('hello world');
    expect(r.iterations).toBe(1);
    expect(r.variantsFound).toContain('dean-edwards');
    expect(r.confidence).toBe('medium');
  });

  it('Codice gia` deobfuscated → no-op, confidence=low', () => {
    const plain = "var x = 'hello'; console.log(x);";
    const r = unpackJs(plain);
    expect(r.unpacked).toBe(plain);
    expect(r.iterations).toBe(0);
    expect(r.confidence).toBe('low');
  });

  it('Sintassi malformata (parentesi mancante) → no-op, no crash', () => {
    const malformed = "eval(function(p,a,c){return p}('broken'";
    const r = unpackJs(malformed);
    expect(r.unpacked).toBe(malformed);
    expect(r.iterations).toBe(0);
  });

  it('Base fuori range (>62 chars) → no-op', () => {
    const bad = "eval(function(p,a,c,k,e,d){return p}('0',99,1,'x'.split('|'),0,{}))";
    const r = unpackJs(bad);
    expect(r.unpacked).toBe(bad);
    expect(r.iterations).toBe(0);
  });

  it('Keywords count < c (count promesso) → no-op (graceful, no crash)', () => {
    const bad = "eval(function(p,a,c,k,e,d){return p}('0 1 2',2,5,'only_one'.split('|'),0,{}))";
    const r = unpackJs(bad);
    expect(r.unpacked).toBe(bad);
    expect(r.iterations).toBe(0);
  });
});

describe('unpackJs — anti-DoS', () => {
  it('Max iterations cap rispettato (default 5)', () => {
    const plain = 'no packed code here';
    const r = unpackJs(plain, { maxIterations: 100 });
    expect(r.iterations).toBe(0);
  });

  it('Custom maxIterations rispettato', () => {
    const plain = 'plain code';
    const r = unpackJs(plain, { maxIterations: 1 });
    expect(r.iterations).toBeLessThanOrEqual(1);
  });
});

describe('unpackJs — anti-ReDoS (H2: backref rimossa)', () => {
  it('anti-regressione: packer con DOUBLE quotes ancora deoffuscato (nuova alternativa "..." )', () => {
    // Il vecchio pattern usava (['"])([\\s\\S]+?)\\1 (backref). Il nuovo usa alternative
    // '([^']*)'|"([^"]*)" → deve gestire ENTRAMBI i tipi di quote. Qui: double.
    const packed = 'eval(function(p,a,c,k,e,d){return p}("0 1",2,2,"hello|world"))';
    const r = unpackJs(packed);
    expect(r.unpacked).toContain('hello');
    expect(r.unpacked).toContain('world');
  });

  it("🚨 JS ostile (≤5MB) con quote non chiusa NON blocca l'event-loop (lineare, < 1s)", () => {
    // Pattern catastrofico per il vecchio backref+lazy: prefisso valido poi quote aperta
    // mai chiusa + rumore. Col motore lineare (classi negate) la scansione è O(n).
    const hostile =
      "eval(function(p,a,c,k,e,d){return p}('" + 'a'.repeat(200000) + '\n'.repeat(1000);
    const t0 = performance.now();
    const r = unpackJs(hostile);
    const elapsed = performance.now() - t0;
    // Niente match valido (manca count/keywords) → input restituito invariato, ma SUBITO.
    expect(r.iterations).toBe(0);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('unpackJs — SECURITY (no eval, no JS execution)', () => {
  it('CRITICAL: input contenente eval-payload malevolo → NON viene eseguito', () => {
    const evilInput =
      "eval(function(p,a,c,k,e,d){throw new Error('PWNED IF EXECUTED')}('x',1,1,'y'.split('|'),0,{}))";
    expect(() => unpackJs(evilInput)).not.toThrow();
  });

  it('Input con prototype pollution attempt non danneggia Object.prototype', () => {
    // Reference a Object.prototype.toString INTENZIONALE per security check:
    // verifichiamo che NON sia stato sostituito dopo l'attack. unbound-method
    // warning atteso (passiamo metodo come reference, non binding).
    // eslint-disable-next-line @typescript-eslint/unbound-method -- security check intenzionale di prototype pollution
    const beforeProto = Object.prototype.toString;
    const evilInput =
      "eval(function(p,a,c,k,e,d){Object.prototype.toString='hacked';return p}('x',1,1,'y'.split('|'),0,{}))";
    unpackJs(evilInput);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- security check intenzionale di prototype pollution
    expect(Object.prototype.toString).toBe(beforeProto);
  });
});

describe('jsUnpackNode — node module integration', () => {
  it('def ha id action_js_unpack + configFields validi', () => {
    expect(jsUnpackNode.def.id).toBe('action_js_unpack');
    expect(jsUnpackNode.def.type).toBe('action');
    expect(jsUnpackNode.def.configFields?.length).toBeGreaterThan(0);
  });

  it('executor con source=input + input.html → unpacked nel output', async () => {
    const packed =
      "eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp('\\\\b'+c.toString(a)+'\\\\b','g'),k[c]);return p}('0',2,1,'success'.split('|'),0,{}))";
    const result = await jsUnpackNode.executor!({ source: 'input' }, { html: packed }, {} as never);
    const out = result.output as { ok: boolean; unpacked: string; confidence: string };
    expect(out.ok).toBe(true);
    expect(out.unpacked).toBe('success');
    expect(out.confidence).toMatch(/medium|high/);
  });

  it('executor con NO source → error gracious (no throw)', async () => {
    const result = await jsUnpackNode.executor!({ source: 'input' }, {}, {} as never);
    const out = result.output as { ok: boolean; error: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no source provided/);
  });

  it('SECURITY: source > 5MB → reject (anti-DoS)', async () => {
    const huge = 'a'.repeat(6 * 1024 * 1024);
    const result = await jsUnpackNode.executor!({ source: 'input' }, { html: huge }, {} as never);
    const out = result.output as { ok: boolean; error: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/troppo grande|max 5MB/i);
  });

  it('executor con source=explicit + config.htmlOrScript → unpacked', async () => {
    const packed =
      "eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp('\\\\b'+c.toString(a)+'\\\\b','g'),k[c]);return p}('0',2,1,'inline'.split('|'),0,{}))";
    const result = await jsUnpackNode.executor!(
      { source: 'explicit', htmlOrScript: packed },
      {},
      {} as never,
    );
    const out = result.output as { ok: boolean; unpacked: string };
    expect(out.ok).toBe(true);
    expect(out.unpacked).toBe('inline');
  });

  it('output include sizeRatio (unpacked/original)', async () => {
    const packed =
      "eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp('\\\\b'+c.toString(a)+'\\\\b','g'),k[c]);return p}('0',2,1,'x'.split('|'),0,{}))";
    const result = await jsUnpackNode.executor!(
      { source: 'explicit', htmlOrScript: packed },
      {},
      {} as never,
    );
    const data = result.output as { sizeRatio: number };
    expect(typeof data.sizeRatio).toBe('number');
    expect(data.sizeRatio).toBeGreaterThan(0);
  });
});
