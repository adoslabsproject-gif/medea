import { describe, it, expect } from 'vitest';
import {
  validateDataflow,
  healDataflowReachability,
  type DfNode,
  type DfEdge,
} from './dataflow-validator.js';

const N = (id: string, defId: string, config: Record<string, unknown> = {}): DfNode => ({
  id,
  defId,
  config,
});

describe('validateDataflow — REACHABILITY', () => {
  it('riferimento a un nodo A MONTE (predecessore raggiungibile) → OK', () => {
    const nodes = [
      N('a', 'trigger_manual'),
      N('b', 'action_http', { url: '{{$node.a.json.url}}' }),
    ];
    const edges: DfEdge[] = [{ from: 'a', to: 'b' }];
    expect(validateDataflow(nodes, edges)).toEqual([]);
  });

  it('riferimento transitivo (a→b→c, c usa a) → OK (a è raggiungibile)', () => {
    const nodes = [
      N('a', 'trigger_manual'),
      N('b', 'action_http'),
      N('c', 'action_send_email', { body: '{{$node.a.json.x}}' }),
    ];
    const edges: DfEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ];
    expect(validateDataflow(nodes, edges)).toEqual([]);
  });

  it('riferimento a un nodo NON a monte (scollegato) → fail', () => {
    const nodes = [
      N('a', 'trigger_manual'),
      N('b', 'action_http', { url: '{{$node.orphan.json}}' }),
      N('orphan', 'action_http'),
    ];
    const edges: DfEdge[] = [{ from: 'a', to: 'b' }];
    const issues = validateDataflow(nodes, edges);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.status).toBe('fail');
    expect(issues[0]!.reason).toMatch(/non è a monte/i);
  });

  it('riferimento a un nodo DOWNSTREAM (gira dopo) → fail', () => {
    // b referenzia c, ma c viene DOPO b (b→c) → i dati di c non esistono in b
    const nodes = [N('b', 'action_http', { url: '{{$node.c.json}}' }), N('c', 'action_http')];
    const edges: DfEdge[] = [{ from: 'b', to: 'c' }];
    const issues = validateDataflow(nodes, edges);
    expect(issues.some((i) => i.nodeId === 'b' && i.status === 'fail')).toBe(true);
  });

  it('sintassi {{node.X.json}} (senza $) riconosciuta come $node.X.json', () => {
    // ghost è un nodo REALE ma disconnesso (non a monte di b) → fail reachability
    const nodes = [
      N('a', 'trigger_manual'),
      N('b', 'action_http', { url: '{{node.ghost.json}}' }),
      N('ghost', 'action_http'),
    ];
    const edges: DfEdge[] = [{ from: 'a', to: 'b' }];
    const issues = validateDataflow(nodes, edges);
    expect(issues.some((i) => i.nodeId === 'b' && i.reason.includes('ghost'))).toBe(true);
  });
});

describe('validateDataflow — CATENA json_extract (caso reale IMAP CRM email→dominio)', () => {
  it("estrai .domain dall'output di un json_extract che ha estratto .email → WARN", () => {
    const nodes = [
      N('trig', 'trigger_imap'),
      N('sender', 'action_json_extract', {
        sourceExpression: '$node.trig.json[0].from',
        path: '$.email',
      }),
      N('domain', 'action_json_extract', {
        sourceExpression: '$node.sender.json',
        path: '$.domain',
      }),
    ];
    const edges: DfEdge[] = [
      { from: 'trig', to: 'sender' },
      { from: 'sender', to: 'domain' },
    ];
    const issues = validateDataflow(nodes, edges);
    const warn = issues.find((i) => i.nodeId === 'domain' && i.status === 'warn');
    expect(warn, 'il mismatch email→dominio deve essere beccato').toBeDefined();
    expect(warn!.reason).toMatch(/valore estratto/i);
  });

  it('json_extract che legge da un nodo NON-json_extract → nessun warn catena', () => {
    const nodes = [
      N('http', 'action_http'),
      N('ext', 'action_json_extract', { sourceExpression: '$node.http.json', path: '$.domain' }),
    ];
    const edges: DfEdge[] = [{ from: 'http', to: 'ext' }];
    const issues = validateDataflow(nodes, edges).filter((i) => i.status === 'warn');
    expect(issues).toEqual([]); // http può produrre un oggetto con .domain → non sospetto
  });

  it('json_extract che estrae un OGGETTO (path root $) → nessun warn', () => {
    const nodes = [
      N('a', 'action_json_extract', { sourceExpression: '$node.x.json', path: '$.email' }),
      N('b', 'action_json_extract', { sourceExpression: '$node.a.json', path: '$' }),
      N('x', 'trigger_manual'),
    ];
    const edges: DfEdge[] = [
      { from: 'x', to: 'a' },
      { from: 'a', to: 'b' },
    ];
    const warns = validateDataflow(nodes, edges).filter((i) => i.status === 'warn');
    expect(warns).toEqual([]); // path $ (root) non è un accesso a campo nested
  });
});

describe("healDataflowReachability — AUTO-HEAL (l'automazione, non solo detection)", () => {
  it("db_insert referenzia un nodo non-a-monte → AGGIUNGE l'edge che lo collega", () => {
    const nodes = [
      N('a', 'trigger_manual'),
      N('domain', 'action_json_extract', { sourceExpression: '$node.a.json', path: '$' }),
      N('db', 'db_insert', { rowJson: '{"d":"{{$node.domain.json}}"}' }),
    ];
    // db NON è collegato a domain (a→domain, a→db separati)
    const edges: DfEdge[] = [
      { from: 'a', to: 'domain' },
      { from: 'a', to: 'db' },
    ];
    const healed = healDataflowReachability(nodes, edges);
    expect(healed).toContainEqual({ from: 'domain', to: 'db' });
    // dopo l'heal, la reachability è risolta
    const after = validateDataflow(nodes, [...edges, ...healed]).filter((i) => i.status === 'fail');
    expect(after).toEqual([]);
  });

  it('NON crea cicli: se Y è antenato di X, non aggiunge X→Y', () => {
    // a→b, b referenzia a... ma aggiungere a→b è ok (a già monte). Caso ciclo:
    // a→b, a referenzia b (b è DOWNSTREAM di a) → aggiungere b→a creerebbe ciclo.
    const nodes = [N('a', 'action_http', { url: '{{$node.b.json}}' }), N('b', 'action_http')];
    const edges: DfEdge[] = [{ from: 'a', to: 'b' }];
    const healed = healDataflowReachability(nodes, edges);
    expect(healed).toEqual([]); // b→a creerebbe un ciclo a→b→a → NON aggiunto
  });

  it('riferimento già a monte → nessun edge aggiunto (idempotente)', () => {
    const nodes = [N('a', 'trigger_manual'), N('b', 'action_http', { url: '{{$node.a.json}}' })];
    const edges: DfEdge[] = [{ from: 'a', to: 'b' }];
    expect(healDataflowReachability(nodes, edges)).toEqual([]);
  });
});

describe('validateDataflow — catena json_extract con wrapper {{ }} (bug fresh-gen IMAP CRM)', () => {
  it('sourceExpression WRAPPATA {{$node.X.json}} + path nested → WARN (prima sfuggiva)', () => {
    const nodes = [
      N('trig', 'trigger_imap'),
      N('sender', 'action_json_extract', {
        sourceExpression: '{{$node.trig.json}}',
        path: '$.from',
      }),
      N('domain', 'action_json_extract', {
        sourceExpression: '{{$node.sender.json}}',
        path: '$.address',
      }),
    ];
    const edges: DfEdge[] = [
      { from: 'trig', to: 'sender' },
      { from: 'sender', to: 'domain' },
    ];
    const warn = validateDataflow(nodes, edges).find(
      (i) => i.nodeId === 'domain' && i.status === 'warn',
    );
    expect(warn, 'la catena wrappata {{ }} deve essere beccata').toBeDefined();
  });
});
