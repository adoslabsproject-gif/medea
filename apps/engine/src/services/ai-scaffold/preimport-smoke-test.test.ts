/**
 * Pre-import smoke test — coverage 2026-grade per Step 5.
 *
 * Verifica i pattern principali: HTTP / Email / DB / Agent + edge cases:
 * placeholder, secret hardcoded, SQL destructive, URL invalid, missing field.
 */
import { describe, it, expect } from 'vitest';
import { smokeTestWorkflow, type Workflow } from './preimport-smoke-test.js';

const mkNode = (id: string, defId: string, config: Record<string, unknown> = {}): Workflow['nodes'][number] => ({
  id, defId, config,
});

describe('smokeTestWorkflow — HTTP', () => {
  it('URL valido + Authorization → pass', () => {
    const wf: Workflow = {
      nodes: [mkNode('a', 'action_http', { url: 'https://api.x.com/v1', headers: { Authorization: 'Bearer x' } })],
      edges: [],
    };
    const r = smokeTestWorkflow(wf);
    expect(r.counts.pass).toBe(1);
    expect(r.overall).toBe('pass');
    expect(r.nodes[0]!.simulatedOutputShape).toMatchObject({ status: 200 });
  });

  it('URL "api." senza header auth → warn', () => {
    const wf: Workflow = {
      nodes: [mkNode('a', 'action_http', { url: 'https://api.x.com/v1' })],
      edges: [],
    };
    const r = smokeTestWorkflow(wf);
    expect(r.counts.warn).toBe(1);
    expect(r.overall).toBe('warn');
  });

  it('URL mancante → fail', () => {
    const wf: Workflow = { nodes: [mkNode('a', 'action_http', {})], edges: [] };
    const r = smokeTestWorkflow(wf);
    expect(r.counts.fail).toBe(1);
    expect(r.overall).toBe('fail');
  });

  it('placeholder YOUR_API_KEY → fail', () => {
    const wf: Workflow = {
      nodes: [mkNode('a', 'action_http', { url: 'https://x.com', apiKey: 'YOUR_API_KEY' })],
      edges: [],
    };
    const r = smokeTestWorkflow(wf);
    expect(r.counts.fail).toBe(1);
    expect(r.nodes[0]!.reason).toMatch(/placeholder/i);
  });

  it('🚨 [bug owner 2026-06-17] URL templato {{secrets.BASE}}/path → NON è un errore (risolto a runtime)', () => {
    const wf: Workflow = {
      nodes: [mkNode('a', 'action_http', {
        url: '{{secrets.HUBSPOT_API_URL}}/contacts/{{$node.valida.json.email}}',
        authMode: 'apikey-header',
      })],
      edges: [],
    };
    const r = smokeTestWorkflow(wf);
    expect(r.nodes[0]!.status).not.toBe('fail'); // mut: prima era fail "URL non valido"
    expect(r.nodes[0]!.reason ?? '').not.toMatch(/non è un URL valido/u);
  });

  it('🚨 URL letterale ROTTO (niente template) → resta fail (non allentiamo troppo)', () => {
    const wf: Workflow = {
      nodes: [mkNode('a', 'action_http', { url: 'ftp:/bad url con spazi', authMode: 'none' })],
      edges: [],
    };
    const r = smokeTestWorkflow(wf);
    expect(r.nodes[0]!.status).toBe('fail');
    expect(r.nodes[0]!.reason).toMatch(/non è un URL valido/u);
  });
});

describe('smokeTestWorkflow — Email', () => {
  it('to + subject + body → pass', () => {
    const wf: Workflow = {
      nodes: [mkNode('a', 'action_send_email', { to: 'u@x.it', subject: 'Test', body: 'Ciao' })],
      edges: [],
    };
    const r = smokeTestWorkflow(wf);
    expect(r.counts.pass).toBe(1);
  });

  it('to invalido → fail', () => {
    const wf: Workflow = {
      nodes: [mkNode('a', 'action_send_email', { to: 'invalid', subject: 'X' })],
      edges: [],
    };
    const r = smokeTestWorkflow(wf);
    expect(r.counts.fail).toBe(1);
  });

  it('subject vuoto → warn', () => {
    const wf: Workflow = {
      nodes: [mkNode('a', 'action_send_email', { to: 'u@x.it', subject: '', body: 'x' })],
      edges: [],
    };
    const r = smokeTestWorkflow(wf);
    expect(r.counts.warn).toBe(1);
  });

  it('to via template {{...}} → pass (skip email format check)', () => {
    const wf: Workflow = {
      nodes: [mkNode('a', 'action_send_email', { to: '{{trigger.email}}', subject: 'X', body: 'y' })],
      edges: [],
    };
    const r = smokeTestWorkflow(wf);
    expect(r.counts.pass).toBe(1);
  });
});

describe('smokeTestWorkflow — DB', () => {
  it('SELECT parametrized → pass', () => {
    const wf: Workflow = {
      nodes: [mkNode('a', 'db_sql_query', { sql: 'SELECT * FROM t WHERE id = $1' })],
      edges: [],
    };
    const r = smokeTestWorkflow(wf);
    expect(r.counts.pass).toBe(1);
  });

  it('DROP TABLE → fail', () => {
    const wf: Workflow = {
      nodes: [mkNode('a', 'db_sql_query', { sql: 'DROP TABLE users' })],
      edges: [],
    };
    const r = smokeTestWorkflow(wf);
    expect(r.counts.fail).toBe(1);
    expect(r.nodes[0]!.reason).toMatch(/DROP TABLE|TRUNCATE/);
  });

  it('INSERT senza parametri via db_query (sql raw) → warn (SQL injection risk)', () => {
    // NB: db_insert usa table+rowJson (parametrizzato by design). Il rischio SQL
    // injection raw vale per db_query/db_sql_query (sql grezzo).
    const wf: Workflow = {
      nodes: [mkNode('a', 'db_sql_query', { sql: "INSERT INTO t VALUES ('x')" })],
      edges: [],
    };
    const r = smokeTestWorkflow(wf);
    expect(r.counts.warn).toBe(1);
  });
});

describe('smokeTestWorkflow — Agent', () => {
  it('prompt + apiKey via secrets → pass', () => {
    const wf: Workflow = {
      nodes: [mkNode('a', 'agent_summarizer', { prompt: 'Summarize: {{input}}', apiKey: '{{secrets.OPENAI_API_KEY}}' })],
      edges: [],
    };
    const r = smokeTestWorkflow(wf);
    expect(r.counts.pass).toBe(1);
  });

  it('apiKey hardcoded → fail', () => {
    const wf: Workflow = {
      nodes: [mkNode('a', 'agent_summarizer', { prompt: 'x', apiKey: 'sk-real-leaked-key' })],
      edges: [],
    };
    const r = smokeTestWorkflow(wf);
    expect(r.counts.fail).toBe(1);
    expect(r.nodes[0]!.reason).toMatch(/hard-?coded|secrets/i);
  });

  it('prompt mancante → fail', () => {
    const wf: Workflow = {
      nodes: [mkNode('a', 'agent_summarizer', {})],
      edges: [],
    };
    const r = smokeTestWorkflow(wf);
    expect(r.counts.fail).toBe(1);
  });

  // BUG owner 2026-06-12 (goal SEO keyword density): agent_data_analyst è
  // PRE-ISTRUITO (systemPrompt nel def) → senza campo prompt nel config era
  // un FALSO POSITIVO "Agente senza istruzioni". Con prePromptedDefIds passa.
  it('agent pre-istruito SENZA campo prompt + defId in prePromptedDefIds → PASS', () => {
    const wf: Workflow = {
      nodes: [mkNode('a', 'agent_data_analyst', { provider: 'liara', extraContext: '{{$node.x.json}}' })],
      edges: [],
    };
    const rosso = smokeTestWorkflow(wf); // senza set = vecchio comportamento
    expect(rosso.counts.fail, 'senza il set resta il vecchio falso positivo').toBe(1);

    const verde = smokeTestWorkflow(wf, { prePromptedDefIds: new Set(['agent_data_analyst']) });
    expect(verde.counts.fail, 'col set il falso positivo sparisce').toBe(0);
    expect(verde.counts.pass).toBe(1);
  });

  it('agent NON pre-istruito (generico) senza prompt → resta FAIL anche col set', () => {
    const wf: Workflow = {
      nodes: [mkNode('a', 'agent_chat', { provider: 'liara' })],
      edges: [],
    };
    const r = smokeTestWorkflow(wf, { prePromptedDefIds: new Set(['agent_data_analyst']) });
    expect(r.counts.fail).toBe(1);
  });
});

describe('buildPrePromptedAgentDefIds — derivato dal systemPrompt del def', () => {
  it('include gli agent specializzati col systemPrompt, esclude i generici', async () => {
    const { buildPrePromptedAgentDefIds } = await import('./node-catalog.js');
    const set = buildPrePromptedAgentDefIds();
    expect(set.has('agent_data_analyst'), 'data_analyst ha systemPrompt nel def').toBe(true);
    expect(set.has('agent_summarizer')).toBe(true);
    expect(set.has('agent_security_audit') || set.has('security_audit')).toBe(true);
    // un nodo NON-agent non deve finirci
    expect(set.has('action_http')).toBe(false);
    expect(set.size).toBeGreaterThanOrEqual(5);
  });
});

describe('smokeTestWorkflow — Aggregator', () => {
  it('mixed pass/warn/fail → overall=fail', () => {
    const wf: Workflow = {
      nodes: [
        mkNode('http_ok', 'action_http', { url: 'https://x.com', headers: { Authorization: 'Bearer x' } }),
        mkNode('email_warn', 'action_send_email', { to: 'u@x.it', body: 'x' }),
        mkNode('db_fail', 'db_sql_query', { sql: 'DROP TABLE t' }),
      ],
      edges: [],
    };
    const r = smokeTestWorkflow(wf);
    expect(r.counts.pass).toBe(1);
    expect(r.counts.warn).toBe(1);
    expect(r.counts.fail).toBe(1);
    expect(r.overall).toBe('fail');
  });

  it('skipTriggers default true', () => {
    const wf: Workflow = {
      nodes: [
        mkNode('t', 'trigger_webhook', {}),
        mkNode('h', 'action_http', { url: 'https://x.com', headers: { Authorization: 'Bearer x' } }),
      ],
      edges: [{ from: 't', to: 'h' }],
    };
    const r = smokeTestWorkflow(wf);
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0]!.nodeId).toBe('h');
  });

  it('defId non-simulato → notSimulated, non blocca overall', () => {
    const wf: Workflow = {
      nodes: [
        mkNode('h', 'action_http', { url: 'https://x.com', headers: { Authorization: 'Bearer x' } }),
        mkNode('u', 'unknown_node_xyz', {}),
      ],
      edges: [],
    };
    const r = smokeTestWorkflow(wf);
    expect(r.notSimulated).toEqual(['u']);
    expect(r.overall).toBe('pass');
  });

  it('registeredDefIds filter: skip i non registrati', () => {
    const wf: Workflow = {
      nodes: [
        mkNode('a', 'action_http', { url: 'https://x.com', headers: { Authorization: 'Bearer x' } }),
        mkNode('b', 'custom_amazon-search', {}),
      ],
      edges: [],
    };
    const registered = new Set(['action_http']);
    const r = smokeTestWorkflow(wf, { registeredDefIds: registered });
    expect(r.nodes).toHaveLength(1);
    expect(r.notSimulated).toEqual(['b']);
  });
});

describe('🔒 [REGRESSION 2026-06-11] NO falsi positivi — campi REALI del NodeDef', () => {
  it('agent_extractor con schema (NON prompt) → pass', () => {
    const wf: Workflow = { nodes: [mkNode('a', 'agent_extractor', { schema: '{"type":"object"}', provider: 'liara' })], edges: [] };
    const r = smokeTestWorkflow(wf);
    expect(r.counts.fail).toBe(0);
    expect(r.nodes[0]!.status).toBe('pass');
  });

  it('agent_translator con targetLanguage (NON prompt) → pass', () => {
    const wf: Workflow = { nodes: [mkNode('a', 'agent_translator', { targetLanguage: 'auto', provider: 'liara' })], edges: [] };
    expect(smokeTestWorkflow(wf).nodes[0]!.status).toBe('pass');
  });

  it('agent SENZA alcuna istruzione → fail (il vero vuoto resta beccato)', () => {
    const wf: Workflow = { nodes: [mkNode('a', 'agent_extractor', { provider: 'liara' })], edges: [] };
    expect(smokeTestWorkflow(wf).nodes[0]!.status).toBe('fail');
  });

  it('db_insert con table+rowJson (NON sql) → pass', () => {
    const wf: Workflow = { nodes: [mkNode('a', 'db_insert', { table: 'audits', rowJson: '{"x":1}', databaseId: '{{secrets.DB}}' })], edges: [] };
    const r = smokeTestWorkflow(wf);
    expect(r.counts.fail).toBe(0);
    expect(r.nodes[0]!.status).toBe('pass');
  });

  it('db_insert SENZA table → fail', () => {
    const wf: Workflow = { nodes: [mkNode('a', 'db_insert', { rowJson: '{"x":1}' })], edges: [] };
    expect(smokeTestWorkflow(wf).nodes[0]!.status).toBe('fail');
  });

  it('db_query con table+selectJson (NON sql, query strutturata) → pass [caso Redirect Chain Audit]', () => {
    const wf: Workflow = { nodes: [mkNode('a', 'db_query', { databaseId: '{{secrets.DB}}', table: 'legacy_urls', selectJson: '["url"]' })], edges: [] };
    const r = smokeTestWorkflow(wf);
    expect(r.counts.fail).toBe(0);
    expect(r.nodes[0]!.status).toBe('pass');
  });

  it('db_query SENZA table → fail (il required è "table", NON "sql")', () => {
    expect(smokeTestWorkflow({ nodes: [mkNode('a', 'db_query', {})], edges: [] }).nodes[0]!.status).toBe('fail');
  });

  it('db_sql_query è l\'UNICO con sql grezzo: con sql → pass, senza → fail', () => {
    expect(smokeTestWorkflow({ nodes: [mkNode('a', 'db_sql_query', { sql: 'SELECT 1' })], edges: [] }).nodes[0]!.status).toBe('pass');
    expect(smokeTestWorkflow({ nodes: [mkNode('a', 'db_sql_query', {})], edges: [] }).nodes[0]!.status).toBe('fail');
  });

  it('action_http con authMode:bearer + bearerToken → NIENTE warning auth (HubSpot)', () => {
    const wf: Workflow = { nodes: [mkNode('a', 'action_http', { url: 'https://api.hubapi.com/contacts', method: 'POST', authMode: 'bearer', bearerToken: '{{secrets.HUBSPOT_API_KEY}}' })], edges: [] };
    const r = smokeTestWorkflow(wf);
    expect(r.counts.warn).toBe(0);
    expect(r.nodes[0]!.status).toBe('pass');
  });
});

describe('🔬 [data-flow nel smoke] il mismatch email→dominio del IMAP CRM emerge nel report', () => {
  it('catena json_extract sospetta → il report smoke la mostra (non più verde cieco)', () => {
    const wf: Workflow = {
      nodes: [
        mkNode('trig', 'trigger_imap', { mailbox: 'x' }),
        mkNode('sender', 'action_json_extract', { sourceExpression: '$node.trig.json[0].from', path: '$.email' }),
        mkNode('domain', 'action_json_extract', { sourceExpression: '$node.sender.json', path: '$.domain' }),
      ],
      edges: [{ from: 'trig', to: 'sender' }, { from: 'sender', to: 'domain' }],
    };
    const r = smokeTestWorkflow(wf);
    const df = r.nodes.find((n) => n.nodeId === 'domain' && n.defId === 'data-flow');
    expect(df, 'la issue data-flow email→dominio nel report').toBeDefined();
    expect(df!.status).toBe('warn');
  });

  it('riferimento a nodo non-a-monte → fail nel report (overall fail)', () => {
    const wf: Workflow = {
      nodes: [mkNode('a', 'action_http', { url: 'https://x.com' }), mkNode('b', 'action_http', { url: '{{$node.later.json.u}}' }), mkNode('later', 'action_http', { url: 'https://y.com' })],
      edges: [{ from: 'a', to: 'b' }],
    };
    const r = smokeTestWorkflow(wf);
    expect(r.counts.fail).toBeGreaterThan(0);
    expect(r.overall).toBe('fail');
  });
});
