import { describe, it, expect } from 'vitest';
import { validateArchitecture } from './validate-architecture.js';

const CAT = [
  { defId: 'trigger_webhook', type: 'trigger' },
  { defId: 'action_http', type: 'action' },
  { defId: 'logic_switch', type: 'logic' },
  { defId: 'community_slack', type: 'action' },
];
const N = (id: string, defId: string, config: Record<string, unknown> = {}) => ({ id, defId, config });

describe('validateArchitecture — 4 check anti-bug', () => {
  it('workflow valido (trigger→action) → nessun issue', () => {
    const issues = validateArchitecture([N('t', 'trigger_webhook'), N('a', 'action_http')], [{ from: 't', to: 'a' }], CAT);
    expect(issues).toEqual([]);
  });

  it('1. edge ENTRANTE in un trigger → issue (i trigger sono root)', () => {
    const issues = validateArchitecture([N('t', 'trigger_webhook'), N('a', 'action_http')], [{ from: 'a', to: 't' }], CAT);
    expect(issues.some((i) => i.includes('TRIGGER (root)'))).toBe(true);
  });

  it('2. nodo non-trigger SENZA edge entrante → orfano', () => {
    const issues = validateArchitecture([N('t', 'trigger_webhook'), N('orphan', 'action_http')], [], CAT);
    expect(issues.some((i) => i.includes('orfano'))).toBe(true);
  });

  it('3. switch con case dichiarato ma SENZA edge fromPort → issue', () => {
    const nodes = [N('t', 'trigger_webhook'), N('sw', 'logic_switch', { cases: [{ case: 'a' }, { case: 'b' }] }), N('x', 'action_http')];
    const edges = [{ from: 't', to: 'sw' }, { from: 'sw', to: 'x', fromPort: 'a' }]; // manca fromPort 'b'
    const issues = validateArchitecture(nodes, edges, CAT);
    expect(issues.some((i) => /case "b".*NESSUN edge/.test(i))).toBe(true);
  });

  it('4. anti-pigrizia: 3+ rami switch TUTTI verso community_slack → issue', () => {
    const nodes = [N('t', 'trigger_webhook'), N('sw', 'logic_switch'), N('s1', 'community_slack'), N('s2', 'community_slack'), N('s3', 'community_slack')];
    const edges = [{ from: 't', to: 'sw' }, { from: 'sw', to: 's1', fromPort: 'a' }, { from: 'sw', to: 's2', fromPort: 'b' }, { from: 'sw', to: 's3', fromPort: 'c' }];
    const issues = validateArchitecture(nodes, edges, CAT);
    expect(issues.some((i) => i.includes('TUTTI verso community_slack'))).toBe(true);
  });
});
