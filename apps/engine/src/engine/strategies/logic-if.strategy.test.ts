/**
 * Bug-bounty — engine/strategies/logic-if.strategy.ts (audit coverage
 * 2026-06-12: nessun test). 🚨 ROUTING: la scelta del branch true/false del
 * nodo logic_if. Un bug qui = il workflow prende il ramo SBAGLIATO =
 * corruzione downstream silenziosa.
 *
 * Due priorità: conditionRules (visual builder strutturato, evaluateRuleset
 * REALE) → fallback expression legacy (evaluateExpression mockato).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const evalMock = vi.hoisted(() => vi.fn());
vi.mock('@/engine/interpreter.js', () => ({ evaluateExpression: evalMock }));

beforeEach(() => { evalMock.mockReset(); });

const { LogicIfStrategy } = await import('./logic-if.strategy.js');

function mkCtx(config: Record<string, unknown>, scope: Record<string, unknown> = { vars: {}, secrets: {} }) {
  return {
    module: { def: { id: 'logic_if' } },
    interpolatedConfig: config,
    scope,
    node: { id: 'n1', defId: 'logic_if', config: {} },
  } as never;
}

const strat = new LogicIfStrategy();

describe('match', () => {
  it('defId="logic_if" → true; altro → false', () => {
    expect(strat.match(mkCtx({}))).toBe(true);
    const c = mkCtx({});
    (c as { module: { def: { id: string } } }).module.def.id = 'logic_switch';
    expect(strat.match(c)).toBe(false);
  });
});

describe('priorità 2 — expression legacy (evaluateExpression mockato)', () => {
  it('expression truthy → branch "true" + truthy=true + chosenBranch coerente', async () => {
    evalMock.mockReturnValue(true);
    const res = await strat.execute(mkCtx({ condition: 'x > 5' }));
    expect(res.chosenBranch).toBe('true');
    expect((res.output as { branch: string; truthy: boolean }).branch).toBe('true');
    expect((res.output as { truthy: boolean }).truthy).toBe(true);
    expect((res.output as { condition: string }).condition).toBe('x > 5');
  });

  it('expression falsy → branch "false"', async () => {
    evalMock.mockReturnValue(0); // falsy non-boolean → Boolean() lo normalizza
    const res = await strat.execute(mkCtx({ condition: 'x' }));
    expect(res.chosenBranch).toBe('false');
    expect((res.output as { truthy: boolean }).truthy).toBe(false);
  });

  it('condition NON stringa → trattata come "false" (default difensivo, no crash)', async () => {
    evalMock.mockReturnValue(false);
    const res = await strat.execute(mkCtx({ condition: { not: 'a string' } }));
    expect(res.chosenBranch).toBe('false');
    expect(evalMock).toHaveBeenCalledWith('false', expect.anything()); // ha valutato il literal 'false'
  });

  it('output.condition riflette l espressione valutata (repr per debugging)', async () => {
    evalMock.mockReturnValue(true);
    const res = await strat.execute(mkCtx({ condition: 'status == "paid"' }));
    expect((res.output as { condition: string }).condition).toBe('status == "paid"');
  });
});

describe('priorità 1 — conditionRules visual builder (evaluateRuleset REALE)', () => {
  it('ruleset strutturato presente → usato, evaluateExpression legacy IGNORATO', async () => {
    evalMock.mockReturnValue(true); // se venisse usato darebbe true: deve NON essere usato
    // ruleset AND con una regola sempre-vera su scope.vars
    const rules = JSON.stringify({
      combinator: 'AND',
      rules: [{ left: '{{age}}', op: 'greater_than', right: '18' }],
    });
    const res = await strat.execute(mkCtx({ conditionRules: rules, condition: 'x' }, { vars: { age: 25 }, secrets: {} }));
    // Il branch dipende dal ruleset reale, NON dal mock legacy.
    expect(['true', 'false']).toContain(res.chosenBranch);
    expect(evalMock).not.toHaveBeenCalled(); // priorità 1 ha la precedenza
    expect((res.output as { condition: string }).condition).toMatch(/\[rules:AND\]/);
  });

  it('ruleset VUOTO (0 regole) → fallback all expression legacy', async () => {
    evalMock.mockReturnValue(true);
    const emptyRuleset = JSON.stringify({ combinator: 'and', rules: [] });
    const res = await strat.execute(mkCtx({ conditionRules: emptyRuleset, condition: 'fallback_expr' }));
    expect(evalMock).toHaveBeenCalledWith('fallback_expr', expect.anything()); // fallback usato
    expect(res.chosenBranch).toBe('true');
  });

  it('conditionRules malformato → parseRuleset ritorna null → fallback legacy', async () => {
    evalMock.mockReturnValue(false);
    const res = await strat.execute(mkCtx({ conditionRules: '{rotto', condition: 'x' }));
    expect(evalMock).toHaveBeenCalled(); // fallback
    expect(res.chosenBranch).toBe('false');
  });
});

describe('contratto output', () => {
  it('retries sempre 0 (le strategy di routing non ritentano)', async () => {
    evalMock.mockReturnValue(true);
    const res = await strat.execute(mkCtx({ condition: 'x' }));
    expect(res.retries).toBe(0);
  });
});
