/**
 * Quality Gate — test 2026-grade.
 *
 * Coverage: 5 rules (circular ref, mock placeholder, switch no default,
 * dead-end, orphan trigger) + severity classification + result struct.
 *
 * Ogni test asserisce VALORE specifico (issue code + severity + node ID),
 * non boolean smoke. Esempio reale: il workflow "Document Intelligence
 * Pipeline" generato 2026-05-31 da Liara che ha 2 critical (circular ref
 * notion→db_insert, SMTP fittizio) + 1 medium (switch no default).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/logger.js');

import { runQualityGate, type QualityGateInput } from './quality-gate.js';

describe('QualityGate — circular references', () => {
  it('detect: X.config referencia Y MA Y NON è ancestor di X → critical', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 'extract', defId: 'agent_extractor', config: {} },
        { id: 'notion', defId: 'community_notion', config: { databaseId: '{{$node.db_insert.json.id}}' } },
        { id: 'db_insert', defId: 'db_insert', config: { rowJson: '{{$node.extract.json}}' } },
      ],
      edges: [
        { from: 'extract', to: 'notion' },
        { from: 'notion', to: 'db_insert' },
      ],
    };
    const r = runQualityGate(wf);
    expect(r.shouldReject).toBe(true);
    const circ = r.issues.filter((i) => i.code === 'CIRCULAR_REFERENCE');
    expect(circ).toHaveLength(1);
    expect(circ[0]?.nodeId).toBe('notion');
    expect(circ[0]?.field).toBe('databaseId');
    expect(circ[0]?.severity).toBe('critical');
  });

  it('OK: X.config referencia Y E Y È ancestor → no issue', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 'a', defId: 'action_pdf_parse', config: {} },
        { id: 'b', defId: 'agent_extractor', config: { source: '{{$node.a.json.text}}' } },
      ],
      edges: [{ from: 'a', to: 'b' }],
    };
    const r = runQualityGate(wf);
    expect(r.issues.filter((i) => i.code === 'CIRCULAR_REFERENCE')).toHaveLength(0);
  });

  it('detect: referencia a nodo INESISTENTE → critical', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 'a', defId: 'action_http', config: { url: '{{$node.ghost.json.url}}' } },
      ],
      edges: [],
    };
    const r = runQualityGate(wf);
    const c = r.issues.find((i) => i.code === 'CIRCULAR_REFERENCE' && i.nodeId === 'a');
    expect(c?.message).toContain('non esiste');
    expect(c?.severity).toBe('critical');
  });

  it('detect: self-reference $node.X dentro X → critical', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 'x', defId: 'action_http', config: { body: '{{$node.x.json.body}}' } },
      ],
      edges: [],
    };
    const r = runQualityGate(wf);
    expect(r.issues.some((i) => i.code === 'CIRCULAR_REFERENCE' && i.message.includes('se stesso'))).toBe(true);
  });

  it('multi-hop ancestor: A→B→C→D, D referencia A → OK (A è ancestor)', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 'a', defId: 'trigger_webhook', config: {} },
        { id: 'b', defId: 'agent_extractor', config: {} },
        { id: 'c', defId: 'logic_if', config: {} },
        { id: 'd', defId: 'action_send_email', config: { to: '{{$node.a.json.email}}' } },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'd' },
      ],
    };
    const r = runQualityGate(wf);
    expect(r.issues.filter((i) => i.code === 'CIRCULAR_REFERENCE')).toHaveLength(0);
  });
});

describe('QualityGate — mock placeholders', () => {
  it('detect: smtp.example.com → critical', () => {
    const wf: QualityGateInput = {
      nodes: [{ id: 'mail', defId: 'action_send_email', config: { host: 'smtp.example.com', port: 465 } }],
      edges: [],
    };
    const r = runQualityGate(wf);
    const mock = r.issues.find((i) => i.code === 'MOCK_PLACEHOLDER' && i.field === 'host');
    expect(mock?.severity).toBe('critical');
    expect(mock?.message).toMatch(/SMTP|example/i);
  });

  it('detect: noreply@example.com nel from → medium', () => {
    const wf: QualityGateInput = {
      nodes: [{ id: 'mail', defId: 'action_send_email', config: { from: 'noreply@example.com' } }],
      edges: [],
    };
    const r = runQualityGate(wf);
    const m = r.issues.find((i) => i.code === 'MOCK_PLACEHOLDER' && i.field === 'from');
    expect(m).toBeDefined();
    expect(m?.severity).toBe('medium');
  });

  it('detect: bucket "my-bucket" in directory → critical', () => {
    const wf: QualityGateInput = {
      nodes: [{ id: 't', defId: 'trigger_file_watch', config: { directory: 's3://my-bucket/docs', glob: '*.pdf' } }],
      edges: [{ from: 't', to: 't' }], // dummy to avoid orphan
    };
    const r = runQualityGate(wf);
    const m = r.issues.find((i) => i.code === 'MOCK_PLACEHOLDER' && i.field === 'directory');
    expect(m?.severity).toBe('critical');
  });

  it('OK: {{secrets.X}} non triggera mock detection', () => {
    const wf: QualityGateInput = {
      nodes: [{ id: 'h', defId: 'action_http', config: { url: '{{secrets.LEGAL_QUEUE_URL}}', body: 'x' } }],
      edges: [],
    };
    const r = runQualityGate(wf);
    expect(r.issues.filter((i) => i.code === 'MOCK_PLACEHOLDER')).toHaveLength(0);
  });

  it('detect: TODO/FIXME/your-api-key/change_me', () => {
    const cases: [string, string][] = [
      ['TODO sostituire', 'TODO'],
      ['FIXME urgent', 'FIXME'],
      ['your-api-key', 'your-api-key'],
      ['change_me', 'change_me'],
    ];
    for (const [val, marker] of cases) {
      const wf: QualityGateInput = {
        nodes: [{ id: 'n', defId: 'action_http', config: { url: val } }],
        edges: [],
      };
      const r = runQualityGate(wf);
      expect(r.issues.some((i) => i.code === 'MOCK_PLACEHOLDER' && i.message.toLowerCase().includes(marker.toLowerCase()))).toBe(true);
    }
  });
});

describe('QualityGate — switch defaultCase', () => {
  it('detect: logic_switch con cases ma senza defaultCase → medium', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 'sw', defId: 'logic_switch', config: {
          expression: '{{$node.cls.json.label}}',
          cases: '{"contratto":"a","fattura":"b"}',
        } },
      ],
      edges: [],
    };
    const r = runQualityGate(wf);
    const s = r.issues.find((i) => i.code === 'SWITCH_NO_DEFAULT');
    expect(s?.severity).toBe('medium');
    expect(s?.nodeId).toBe('sw');
  });

  it('OK: logic_switch con defaultCase definito', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 'sw', defId: 'logic_switch', config: {
          cases: { x: 'a', y: 'b' },
          defaultCase: 'fallback',
        } },
      ],
      edges: [],
    };
    const r = runQualityGate(wf);
    expect(r.issues.filter((i) => i.code === 'SWITCH_NO_DEFAULT')).toHaveLength(0);
  });
});

describe('QualityGate — orphan triggers', () => {
  it('detect: trigger_cron senza edges out → critical', () => {
    const wf: QualityGateInput = {
      nodes: [{ id: 'cron', defId: 'trigger_cron', config: { cronExpression: '0 9 * * *' } }],
      edges: [],
    };
    const r = runQualityGate(wf);
    const o = r.issues.find((i) => i.code === 'ORPHAN_TRIGGER' && i.nodeId === 'cron');
    expect(o?.severity).toBe('critical');
    expect(r.shouldReject).toBe(true);
  });

  it('OK: trigger con edges out', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 'cron', defId: 'trigger_cron', config: {} },
        { id: 'http', defId: 'action_http', config: {} },
      ],
      edges: [{ from: 'cron', to: 'http' }],
    };
    const r = runQualityGate(wf);
    expect(r.issues.filter((i) => i.code === 'ORPHAN_TRIGGER')).toHaveLength(0);
  });
});

describe('QualityGate — dead-end branches', () => {
  it('detect: agent_extractor sink (non in KNOWN_SINKS) → medium', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 't', defId: 'trigger_webhook', config: {} },
        { id: 'x', defId: 'agent_extractor', config: {} },
      ],
      edges: [{ from: 't', to: 'x' }],
    };
    const r = runQualityGate(wf);
    const d = r.issues.find((i) => i.code === 'DEAD_END_BRANCH' && i.nodeId === 'x');
    expect(d).toBeDefined();
    expect(d?.severity).toBe('medium');
  });

  it('OK: action_send_email come sink legittimo', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 't', defId: 'trigger_webhook', config: {} },
        { id: 'm', defId: 'action_send_email', config: {} },
      ],
      edges: [{ from: 't', to: 'm' }],
    };
    const r = runQualityGate(wf);
    expect(r.issues.filter((i) => i.code === 'DEAD_END_BRANCH')).toHaveLength(0);
  });

  it('OK: db_insert come sink', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 't', defId: 'trigger_webhook', config: {} },
        { id: 'db', defId: 'db_insert', config: {} },
      ],
      edges: [{ from: 't', to: 'db' }],
    };
    const r = runQualityGate(wf);
    expect(r.issues.filter((i) => i.code === 'DEAD_END_BRANCH')).toHaveLength(0);
  });
});

describe('QualityGate — Document Intelligence Pipeline (real bug case)', () => {
  it('riproduce i 2 bug del workflow generato 2026-05-31 da Liara', () => {
    // Sub-set realistico: notion ha circular ref a db_insert + email
    // ha SMTP fittizio + switch senza default.
    const wf: QualityGateInput = {
      nodes: [
        { id: 'trigger_file', defId: 'trigger_file_watch', config: { directory: 's3://my-bucket/documents', glob: '*.pdf', events: 'add' } },
        { id: 'extract', defId: 'agent_extractor', config: { schema: '{}' } },
        { id: 'cls', defId: 'agent_classifier', config: { labels: '["contratto","fattura"]' } },
        { id: 'sw', defId: 'logic_switch', config: { expression: '{{$node.cls.json.label}}', cases: '{"contratto":"a","fattura":"b"}' } },
        { id: 'notion', defId: 'community_notion', config: { databaseId: '{{$node.db_insert.json.id}}' } },
        { id: 'db_insert', defId: 'db_insert', config: { rowJson: '{{$node.extract.json}}' } },
        { id: 'mail', defId: 'action_send_email', config: { host: 'smtp.example.com', from: 'noreply@example.com' } },
      ],
      edges: [
        { from: 'trigger_file', to: 'extract' },
        { from: 'extract', to: 'cls' },
        { from: 'cls', to: 'sw' },
        { from: 'sw', to: 'notion' },
        { from: 'notion', to: 'db_insert' },
        { from: 'db_insert', to: 'mail' },
      ],
    };
    const r = runQualityGate(wf);
    expect(r.shouldReject).toBe(true);
    const codes = r.issues.map((i) => i.code);
    expect(codes).toContain('CIRCULAR_REFERENCE');
    expect(codes).toContain('MOCK_PLACEHOLDER');
    expect(codes).toContain('SWITCH_NO_DEFAULT');
    // Almeno 4 issues totali (notion circular + bucket mock + smtp mock + switch + email mock)
    expect(r.issues.length).toBeGreaterThanOrEqual(4);
  });
});

describe('QualityGate — extended MOCK_PATTERNS (2026-05-31 bug fix)', () => {
  it('detect: bucket-name in directory → critical', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 't', defId: 'trigger_file_watch', config: { directory: 's3://bucket-name/docs', glob: '*.pdf' } },
        { id: 'h', defId: 'action_http', config: {} },
      ],
      edges: [{ from: 't', to: 'h' }],
    };
    const r = runQualityGate(wf);
    const m = r.issues.find((i) => i.code === 'MOCK_PLACEHOLDER' && i.field === 'directory');
    expect(m?.severity).toBe('critical');
    expect(m?.message).toContain('placeholder');
  });

  it('detect: noreply@company.com → critical (config field "from")', () => {
    const wf: QualityGateInput = {
      nodes: [{ id: 'm', defId: 'action_send_email', config: { from: 'noreply@company.com', host: 'smtp.gmail.com' } }],
      edges: [],
    };
    const r = runQualityGate(wf);
    const m = r.issues.find((i) => i.code === 'MOCK_PLACEHOLDER' && i.field === 'from');
    expect(m).toBeDefined();
    expect(m?.severity).toBe('medium'); // email NON ha keyword critical in field name "from"
  });

  it('detect: management@company.com destinatario → medium', () => {
    const wf: QualityGateInput = {
      nodes: [{ id: 'm', defId: 'action_send_email', config: { to: 'management@company.com' } }],
      edges: [],
    };
    const r = runQualityGate(wf);
    expect(r.issues.some((i) => i.code === 'MOCK_PLACEHOLDER')).toBe(true);
  });

  it('detect: yourcompany.com / yourdomain.com', () => {
    const wf: QualityGateInput = {
      nodes: [{ id: 'h', defId: 'action_http', config: { url: 'https://api.yourcompany.com/x' } }],
      edges: [],
    };
    const r = runQualityGate(wf);
    expect(r.issues.some((i) => i.code === 'MOCK_PLACEHOLDER')).toBe(true);
  });

  it('detect: angular brackets <NAME_VAR>', () => {
    const wf: QualityGateInput = {
      nodes: [{ id: 'h', defId: 'action_http', config: { body: 'Hello <USER_NAME>' } }],
      edges: [],
    };
    const r = runQualityGate(wf);
    expect(r.issues.some((i) => i.code === 'MOCK_PLACEHOLDER')).toBe(true);
  });

  it('detect: shell ${VAR} non risolto', () => {
    const wf: QualityGateInput = {
      nodes: [{ id: 'h', defId: 'action_http', config: { url: 'https://${API_HOST}/x' } }],
      edges: [],
    };
    const r = runQualityGate(wf);
    expect(r.issues.some((i) => i.code === 'MOCK_PLACEHOLDER')).toBe(true);
  });

  it('OK: {{secrets.X}} NON triggera (template engine valido)', () => {
    const wf: QualityGateInput = {
      nodes: [{ id: 'h', defId: 'action_http', config: { url: '{{secrets.API_URL}}', body: '{{secrets.API_TOKEN}}' } }],
      edges: [],
    };
    const r = runQualityGate(wf);
    expect(r.issues.filter((i) => i.code === 'MOCK_PLACEHOLDER')).toHaveLength(0);
  });

  it('suggest field popolato (suggerimento sostituzione)', () => {
    const wf: QualityGateInput = {
      nodes: [{ id: 'm', defId: 'action_send_email', config: { host: 'smtp.example.com' } }],
      edges: [],
    };
    const r = runQualityGate(wf);
    const m = r.issues.find((i) => i.code === 'MOCK_PLACEHOLDER');
    expect(m?.message).toContain('suggerito');
  });
});

describe('QualityGate — SWITCH_INVALID_CASE_KEY (rule 8, workflow-killer 2026-05-31)', () => {
  it('case keys con "<" operatore → critical (caso reale SEO Audit Settimanale)', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 'cron', defId: 'trigger_cron', config: { cronExpression: '0 7 * * 1' } },
        { id: 'sw', defId: 'logic_switch', config: {
          expression: '{{$node.audit.json.score}}',
          cases: '{"score < 90":"branch_alert","score >= 90":"branch_ok"}',
        } },
      ],
      edges: [{ from: 'cron', to: 'sw' }],
    };
    const r = runQualityGate(wf);
    const s = r.issues.find((i) => i.code === 'SWITCH_INVALID_CASE_KEY');
    expect(s).toBeDefined();
    expect(s?.severity).toBe('critical');
    expect(s?.message).toContain('equality match');
    expect(s?.message).toContain('logic_if');
    expect(r.shouldReject).toBe(true);
  });

  it('case keys con operatori &&, ||, == → critical', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 'cron', defId: 'trigger_cron', config: {} },
        { id: 'sw', defId: 'logic_switch', config: {
          expression: 'x',
          cases: '{"name == \\"admin\\" && active": "a","x || y": "b"}',
        } },
      ],
      edges: [{ from: 'cron', to: 'sw' }],
    };
    const r = runQualityGate(wf);
    expect(r.issues.some((i) => i.code === 'SWITCH_INVALID_CASE_KEY')).toBe(true);
  });

  it('case keys VALORI DISCRETI (corretto) → NO issue', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 'cron', defId: 'trigger_cron', config: {} },
        { id: 'sw', defId: 'logic_switch', config: {
          expression: '{{$node.cls.json.label}}',
          cases: '{"contratto":"branch_a","fattura":"branch_b","preventivo":"branch_c"}',
          defaultCase: 'branch_d',
        } },
      ],
      edges: [{ from: 'cron', to: 'sw' }],
    };
    const r = runQualityGate(wf);
    expect(r.issues.filter((i) => i.code === 'SWITCH_INVALID_CASE_KEY')).toHaveLength(0);
  });

  it('forma array [{case,output}] con operatori → critical', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 'cron', defId: 'trigger_cron', config: {} },
        { id: 'sw', defId: 'logic_switch', config: {
          expression: 'x',
          cases: [{ case: 'x < 5', output: 'low' }, { case: 'x >= 5', output: 'high' }],
        } },
      ],
      edges: [{ from: 'cron', to: 'sw' }],
    };
    const r = runQualityGate(wf);
    expect(r.issues.some((i) => i.code === 'SWITCH_INVALID_CASE_KEY')).toBe(true);
  });
});

describe('QualityGate — AGGREGATION_INSIDE_LOOP (rule 9, workflow-killer 2026-05-31)', () => {
  it('agent_data_analyst con keyword "report" downstream di logic_loop → critical (caso reale Keyword Density)', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 't', defId: 'trigger_manual', config: {} },
        { id: 'loop', defId: 'logic_loop', config: { itemsExpression: '{{$node.x.json.urls}}' } },
        { id: 'fetch', defId: 'action_fetch_url', config: { url: '{{$node.loop.json.item}}' } },
        { id: 'analyst', defId: 'agent_data_analyst', config: { provider: 'openai', extraContext: 'Genera un report aggregato keyword density' } },
      ],
      edges: [{ from: 't', to: 'loop' }, { from: 'loop', to: 'fetch' }, { from: 'fetch', to: 'analyst' }],
    };
    const r = runQualityGate(wf);
    const a = r.issues.find((i) => i.code === 'AGGREGATION_INSIDE_LOOP');
    expect(a).toBeDefined();
    expect(a?.severity).toBe('critical');
    expect(a?.message).toContain('logic_loop');
    expect(a?.message).toContain('DOPO la chiusura del loop');
  });

  it('action_send_email con subject "Report" downstream → critical', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 't', defId: 'trigger_manual', config: {} },
        { id: 'loop', defId: 'logic_loop', config: { itemsExpression: '{{$x}}' } },
        { id: 'mail', defId: 'action_send_email', config: { subject: 'Report giornaliero', to: 'a@b.io' } },
      ],
      edges: [{ from: 't', to: 'loop' }, { from: 'loop', to: 'mail' }],
    };
    const r = runQualityGate(wf);
    expect(r.issues.some((i) => i.code === 'AGGREGATION_INSIDE_LOOP')).toBe(true);
  });

  it('email transazionale "Conferma ordine" downstream di loop → NO issue (per-item OK)', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 't', defId: 'trigger_manual', config: {} },
        { id: 'loop', defId: 'logic_loop', config: { itemsExpression: '{{$x}}' } },
        { id: 'mail', defId: 'action_send_email', config: { subject: 'Conferma ordine', to: 'a@b.io' } },
      ],
      edges: [{ from: 't', to: 'loop' }, { from: 'loop', to: 'mail' }],
    };
    const r = runQualityGate(wf);
    expect(r.issues.filter((i) => i.code === 'AGGREGATION_INSIDE_LOOP')).toHaveLength(0);
  });

  it('NO logic_loop → NO issue', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 't', defId: 'trigger_manual', config: {} },
        { id: 'a', defId: 'agent_data_analyst', config: { extraContext: 'Genera report' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    };
    const r = runQualityGate(wf);
    expect(r.issues.filter((i) => i.code === 'AGGREGATION_INSIDE_LOOP')).toHaveLength(0);
  });
});

describe('QualityGate — IT placeholders extended (Keyword Density Multi-Articolo 2026-05-31)', () => {
  it('detect: miosito.com → medium', () => {
    const wf: QualityGateInput = {
      nodes: [{ id: 's', defId: 'action_sitemap_crawler', config: { url: 'https://miosito.com/sitemap.xml' } }],
      edges: [],
    };
    const r = runQualityGate(wf);
    const m = r.issues.find((i) => i.code === 'MOCK_PLACEHOLDER');
    expect(m).toBeDefined();
    expect(m?.message).toContain('miosito');
  });

  it('detect: tuosito.it → medium', () => {
    const wf: QualityGateInput = {
      nodes: [{ id: 's', defId: 'action_web_fetch_advanced', config: { url: 'https://tuosito.it/api' } }],
      edges: [],
    };
    const r = runQualityGate(wf);
    expect(r.issues.some((i) => i.code === 'MOCK_PLACEHOLDER')).toBe(true);
  });

  it('OK: dominio reale zeli.it → NO issue', () => {
    const wf: QualityGateInput = {
      nodes: [{ id: 's', defId: 'action_web_fetch_advanced', config: { url: 'https://zeli.it' } }],
      edges: [],
    };
    const r = runQualityGate(wf);
    expect(r.issues.filter((i) => i.code === 'MOCK_PLACEHOLDER')).toHaveLength(0);
  });
});

describe('QualityGate — DUPLICATE_NODES (rule 6)', () => {
  it('4 nodi stesso defId + stessa config → 1 issue medium', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 't', defId: 'trigger_webhook', config: {} },
        { id: 'db1', defId: 'db_insert', config: { table: 'logs', rowJson: '{"x":1}' } },
        { id: 'db2', defId: 'db_insert', config: { table: 'logs', rowJson: '{"x":1}' } },
        { id: 'db3', defId: 'db_insert', config: { table: 'logs', rowJson: '{"x":1}' } },
        { id: 'db4', defId: 'db_insert', config: { table: 'logs', rowJson: '{"x":1}' } },
      ],
      edges: [{ from: 't', to: 'db1' }, { from: 't', to: 'db2' }, { from: 't', to: 'db3' }, { from: 't', to: 'db4' }],
    };
    const r = runQualityGate(wf);
    const d = r.issues.find((i) => i.code === 'DUPLICATE_NODES');
    expect(d).toBeDefined();
    expect(d?.severity).toBe('medium');
    expect(d?.message).toContain('4 nodi');
    expect(d?.message).toContain('db_insert');
  });

  it('config DIVERSE → NO duplicate', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 't', defId: 'trigger_webhook', config: {} },
        { id: 'db1', defId: 'db_insert', config: { table: 'logs', rowJson: '{"x":1}' } },
        { id: 'db2', defId: 'db_insert', config: { table: 'logs', rowJson: '{"x":2}' } },
      ],
      edges: [{ from: 't', to: 'db1' }, { from: 't', to: 'db2' }],
    };
    const r = runQualityGate(wf);
    expect(r.issues.filter((i) => i.code === 'DUPLICATE_NODES')).toHaveLength(0);
  });
});

describe('QualityGate — SUSPICIOUS_RESOURCE_ID (rule 7)', () => {
  it('detect: databaseId="db_opportunities" (non hash-like) → critical', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 't', defId: 'trigger_webhook', config: {} },
        { id: 'n', defId: 'community_notion', config: { databaseId: 'db_opportunities' } },
      ],
      edges: [{ from: 't', to: 'n' }],
    };
    const r = runQualityGate(wf);
    const s = r.issues.find((i) => i.code === 'SUSPICIOUS_RESOURCE_ID');
    expect(s?.severity).toBe('critical');
    expect(s?.message).toContain('db_opportunities');
  });

  it('detect: systemAccountId="email-account-1" → critical', () => {
    const wf: QualityGateInput = {
      nodes: [{ id: 'm', defId: 'action_send_email', config: { systemAccountId: 'email-account-1' } }],
      edges: [],
    };
    const r = runQualityGate(wf);
    expect(r.issues.some((i) => i.code === 'SUSPICIOUS_RESOURCE_ID')).toBe(true);
  });

  it('OK: databaseId UUID reale', () => {
    const wf: QualityGateInput = {
      nodes: [{ id: 'n', defId: 'db_insert', config: { databaseId: 'd43e6f82-b056-4481-8284-8b812f499b77', table: 'logs' } }],
      edges: [],
    };
    const r = runQualityGate(wf);
    expect(r.issues.filter((i) => i.code === 'SUSPICIOUS_RESOURCE_ID')).toHaveLength(0);
  });

  it('OK: databaseId nanoid (hash-like 21 char)', () => {
    const wf: QualityGateInput = {
      nodes: [{ id: 'n', defId: 'db_insert', config: { databaseId: 'QhktHRtIKHL5aniYhgRvz', table: 'logs' } }],
      edges: [],
    };
    const r = runQualityGate(wf);
    expect(r.issues.filter((i) => i.code === 'SUSPICIOUS_RESOURCE_ID')).toHaveLength(0);
  });

  it('OK: {{secrets.X}} template skipped (resolved at runtime)', () => {
    const wf: QualityGateInput = {
      nodes: [{ id: 'n', defId: 'db_insert', config: { databaseId: '{{secrets.DB_ID}}', table: 'logs' } }],
      edges: [],
    };
    const r = runQualityGate(wf);
    expect(r.issues.filter((i) => i.code === 'SUSPICIOUS_RESOURCE_ID')).toHaveLength(0);
  });

  it('detect: word "placeholder" dentro un ID alfanumerico → critical', () => {
    const wf: QualityGateInput = {
      nodes: [{ id: 'n', defId: 'db_insert', config: { databaseId: 'db_placeholder_12345' } }],
      edges: [],
    };
    const r = runQualityGate(wf);
    expect(r.issues.some((i) => i.code === 'SUSPICIOUS_RESOURCE_ID')).toBe(true);
  });
});

describe('QualityGate — result struct', () => {
  it('issues vuoti → ok=true shouldReject=false', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 't', defId: 'trigger_webhook', config: {} },
        { id: 'm', defId: 'action_send_email', config: { host: 'smtp.gmail.com', from: 'a@real.io' } },
      ],
      edges: [{ from: 't', to: 'm' }],
    };
    const r = runQualityGate(wf);
    expect(r.ok).toBe(true);
    expect(r.shouldReject).toBe(false);
    expect(r.issues).toEqual([]);
  });

  it('issues ordinate per severity: critical PRIMA di medium', () => {
    const wf: QualityGateInput = {
      nodes: [
        { id: 'cron', defId: 'trigger_cron', config: {} }, // critical (orphan)
        { id: 'sw', defId: 'logic_switch', config: { cases: '{"x":"a"}' } }, // medium (no default)
      ],
      edges: [],
    };
    const r = runQualityGate(wf);
    expect(r.issues[0]?.severity).toBe('critical');
    expect(r.issues[r.issues.length - 1]?.severity).toBe('medium');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Cappella Sistina batch 2026-06-07 — 4 nuove rule semantiche
// ────────────────────────────────────────────────────────────────────────────

describe('Quality gate — ARRAY_TO_SCALAR_WITHOUT_LOOP (rule 2026-06-07)', () => {
  it('sitemap_crawler → seo_audit senza loop → critical', () => {
    const r = runQualityGate({
      nodes: [
        { id: 't', defId: 'trigger_manual', config: {} },
        { id: 'crawl', defId: 'action_sitemap_crawler', config: { url: 'https://x.it/sitemap.xml' } },
        { id: 'seo', defId: 'action_seo_audit', config: {} },
      ],
      edges: [
        { from: 't', to: 'crawl' },
        { from: 'crawl', to: 'seo' },
      ],
    });
    const critical = r.issues.filter((i) => i.code === 'ARRAY_TO_SCALAR_WITHOUT_LOOP');
    expect(critical).toHaveLength(1);
    expect(critical[0]?.severity).toBe('critical');
    expect(critical[0]?.nodeId).toBe('seo');
    expect(r.shouldReject).toBe(true);
  });

  it('sitemap_crawler → logic_loop → seo_audit → no issue (loop iterativo)', () => {
    const r = runQualityGate({
      nodes: [
        { id: 't', defId: 'trigger_manual', config: {} },
        { id: 'crawl', defId: 'action_sitemap_crawler', config: { url: 'https://x.it/sitemap.xml' } },
        { id: 'loop', defId: 'logic_loop', config: { strategy: 'naive' } },
        { id: 'seo', defId: 'action_seo_audit', config: {} },
      ],
      edges: [
        { from: 't', to: 'crawl' },
        { from: 'crawl', to: 'loop' },
        { from: 'loop', to: 'seo' },
      ],
    });
    expect(r.issues.some((i) => i.code === 'ARRAY_TO_SCALAR_WITHOUT_LOOP')).toBe(false);
  });

  it('db_query → db_insert senza loop → critical', () => {
    const r = runQualityGate({
      nodes: [
        { id: 't', defId: 'trigger_cron', config: { cron: '0 * * * *' } },
        { id: 'q', defId: 'db_query', config: { databaseId: '__USE_PICKER__', table: 'orders' } },
        { id: 'i', defId: 'db_insert', config: { databaseId: '__USE_PICKER__', table: 'archive' } },
      ],
      edges: [
        { from: 't', to: 'q' },
        { from: 'q', to: 'i' },
      ],
    });
    expect(r.issues.some((i) => i.code === 'ARRAY_TO_SCALAR_WITHOUT_LOOP')).toBe(true);
  });

  it('unknown defId → no false positive', () => {
    const r = runQualityGate({
      nodes: [
        { id: 't', defId: 'trigger_manual', config: {} },
        { id: 'fancy', defId: 'community_fancy_node', config: {} },
        { id: 'seo', defId: 'action_seo_audit', config: {} },
      ],
      edges: [
        { from: 't', to: 'fancy' },
        { from: 'fancy', to: 'seo' },
      ],
    });
    expect(r.issues.some((i) => i.code === 'ARRAY_TO_SCALAR_WITHOUT_LOOP')).toBe(false);
  });
});

describe('Quality gate — FAN_IN_WITHOUT_MERGE (rule 2026-06-07)', () => {
  it('4 edge → consumer non-aggregator → critical', () => {
    const r = runQualityGate({
      nodes: [
        { id: 't', defId: 'trigger_manual', config: {} },
        { id: 'a', defId: 'action_http', config: { url: 'x' } },
        { id: 'b', defId: 'action_http', config: { url: 'y' } },
        { id: 'c', defId: 'action_http', config: { url: 'z' } },
        { id: 'd', defId: 'action_http', config: { url: 'w' } },
        { id: 'sink', defId: 'action_send_email', config: { to: 'a@b.io', from: 'c@d.io', subject: 's', body: 'b' } },
      ],
      edges: [
        { from: 't', to: 'a' }, { from: 't', to: 'b' }, { from: 't', to: 'c' }, { from: 't', to: 'd' },
        { from: 'a', to: 'sink' }, { from: 'b', to: 'sink' }, { from: 'c', to: 'sink' }, { from: 'd', to: 'sink' },
      ],
    });
    expect(r.issues.some((i) => i.code === 'FAN_IN_WITHOUT_MERGE' && i.nodeId === 'sink')).toBe(true);
  });

  it('4 edge → agent_data_analyst (aggregator) → no issue', () => {
    const r = runQualityGate({
      nodes: [
        { id: 't', defId: 'trigger_manual', config: {} },
        { id: 'a', defId: 'action_http', config: { url: 'x' } },
        { id: 'b', defId: 'action_http', config: { url: 'y' } },
        { id: 'agg', defId: 'agent_data_analyst', config: { provider: 'liara' } },
      ],
      edges: [
        { from: 't', to: 'a' }, { from: 't', to: 'b' },
        { from: 'a', to: 'agg' }, { from: 'b', to: 'agg' },
      ],
    });
    expect(r.issues.some((i) => i.code === 'FAN_IN_WITHOUT_MERGE')).toBe(false);
  });

  it('logic_switch riceve N edge → no issue (pick-one)', () => {
    const r = runQualityGate({
      nodes: [
        { id: 't', defId: 'trigger_manual', config: {} },
        { id: 'a', defId: 'action_http', config: { url: 'x' } },
        { id: 'b', defId: 'action_http', config: { url: 'y' } },
        { id: 'sw', defId: 'logic_switch', config: { cases: '{"x":"a"}', default: 'a' } },
      ],
      edges: [
        { from: 't', to: 'a' }, { from: 't', to: 'b' },
        { from: 'a', to: 'sw' }, { from: 'b', to: 'sw' },
      ],
    });
    expect(r.issues.some((i) => i.code === 'FAN_IN_WITHOUT_MERGE')).toBe(false);
  });

  it('1 solo edge → no issue (non e\\` fan-in)', () => {
    const r = runQualityGate({
      nodes: [
        { id: 't', defId: 'trigger_manual', config: {} },
        { id: 'sink', defId: 'action_send_email', config: { to: 'a@b.io', from: 'c@d.io', subject: 's', body: 'b' } },
      ],
      edges: [{ from: 't', to: 'sink' }],
    });
    expect(r.issues.some((i) => i.code === 'FAN_IN_WITHOUT_MERGE')).toBe(false);
  });
});

describe('Quality gate — DB_TABLE_NOT_IN_SCHEMA (rule 2026-06-07)', () => {
  it('db_query con table non in schema → critical', () => {
    const r = runQualityGate({
      nodes: [
        { id: 't', defId: 'trigger_manual', config: {} },
        { id: 'q', defId: 'db_query', config: { databaseId: 'db-xyz', table: 'orders' } },
      ],
      edges: [{ from: 't', to: 'q' }],
      databases: [{ id: 'db-xyz', tables: ['users', 'sessions'] }],
    });
    const issue = r.issues.find((i) => i.code === 'DB_TABLE_NOT_IN_SCHEMA');
    expect(issue?.severity).toBe('critical');
    expect(issue?.message).toContain('"orders"');
    expect(issue?.message).toContain('"users"');
  });

  it('db_query con table esistente → no issue', () => {
    const r = runQualityGate({
      nodes: [
        { id: 't', defId: 'trigger_manual', config: {} },
        { id: 'q', defId: 'db_query', config: { databaseId: 'db-xyz', table: 'users' } },
      ],
      edges: [{ from: 't', to: 'q' }],
      databases: [{ id: 'db-xyz', tables: ['users', 'sessions'] }],
    });
    expect(r.issues.some((i) => i.code === 'DB_TABLE_NOT_IN_SCHEMA')).toBe(false);
  });

  it('placeholder __USE_PICKER__ → rule skip (user configurera\\` post-import)', () => {
    const r = runQualityGate({
      nodes: [
        { id: 't', defId: 'trigger_manual', config: {} },
        { id: 'q', defId: 'db_query', config: { databaseId: '__USE_PICKER__', table: 'whatever' } },
      ],
      edges: [{ from: 't', to: 'q' }],
      databases: [{ id: 'db-xyz', tables: ['users'] }],
    });
    expect(r.issues.some((i) => i.code === 'DB_TABLE_NOT_IN_SCHEMA')).toBe(false);
  });

  it('template expression in table → rule skip', () => {
    const r = runQualityGate({
      nodes: [
        { id: 't', defId: 'trigger_manual', config: {} },
        { id: 'q', defId: 'db_query', config: { databaseId: 'db-xyz', table: '{{vars.target}}' } },
      ],
      edges: [{ from: 't', to: 'q' }],
      databases: [{ id: 'db-xyz', tables: ['users'] }],
    });
    expect(r.issues.some((i) => i.code === 'DB_TABLE_NOT_IN_SCHEMA')).toBe(false);
  });

  it('databases vuoto/undefined → rule skip (no context)', () => {
    const r = runQualityGate({
      nodes: [
        { id: 't', defId: 'trigger_manual', config: {} },
        { id: 'q', defId: 'db_query', config: { databaseId: 'db-xyz', table: 'orders' } },
      ],
      edges: [{ from: 't', to: 'q' }],
    });
    expect(r.issues.some((i) => i.code === 'DB_TABLE_NOT_IN_SCHEMA')).toBe(false);
  });
});

describe('Quality gate — OBSOLETE_MODEL (rule 2026-06-07)', () => {
  it('agent_data_analyst con anthropic + claude-3-haiku-20240307 → medium warning', () => {
    const r = runQualityGate({
      nodes: [
        { id: 't', defId: 'trigger_manual', config: {} },
        { id: 'a', defId: 'agent_data_analyst', config: { provider: 'anthropic', model: 'claude-3-haiku-20240307' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    const issue = r.issues.find((i) => i.code === 'OBSOLETE_MODEL');
    expect(issue?.severity).toBe('medium');
    expect(issue?.field).toBe('model');
    // Medium ≠ critical → non blocca import
    expect(r.shouldReject).toBe(false);
  });

  it('modello corrente claude-sonnet-4-5 → no issue', () => {
    const r = runQualityGate({
      nodes: [
        { id: 't', defId: 'trigger_manual', config: {} },
        { id: 'a', defId: 'agent_summarizer', config: { provider: 'anthropic', model: 'claude-sonnet-4-5' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    expect(r.issues.some((i) => i.code === 'OBSOLETE_MODEL')).toBe(false);
  });

  it('openai gpt-3.5-turbo-0613 → medium warning', () => {
    const r = runQualityGate({
      nodes: [
        { id: 't', defId: 'trigger_manual', config: {} },
        { id: 'a', defId: 'agent_classifier', config: { provider: 'openai', model: 'gpt-3.5-turbo-0613' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    expect(r.issues.some((i) => i.code === 'OBSOLETE_MODEL')).toBe(true);
  });

  it('non-agent node con model field → ignorato', () => {
    const r = runQualityGate({
      nodes: [
        { id: 't', defId: 'trigger_manual', config: {} },
        { id: 'a', defId: 'action_http', config: { provider: 'openai', model: 'gpt-3.5-turbo-0613' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    expect(r.issues.some((i) => i.code === 'OBSOLETE_MODEL')).toBe(false);
  });
});

describe('QualityGate — CODE_NODE_LANG_MISMATCH (bug user 2026-06-09)', () => {
  const PYTHON_CODE = 'import json, os\ndata = json.loads(os.environ.get("FLOWFORGE_INPUT", "{}"))\nprint(data)';
  const JS_CODE = 'const x = input.items || [];\nreturn { n: x.length };';

  it('codice Python in action_run_js → critical + shouldReject', () => {
    const r = runQualityGate({
      nodes: [
        { id: 't', defId: 'trigger_manual', config: {} },
        { id: 'a', defId: 'action_run_js', config: { code: PYTHON_CODE } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    const issue = r.issues.find((i) => i.code === 'CODE_NODE_LANG_MISMATCH');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('critical');
    expect(issue!.nodeId).toBe('a');
    expect(issue!.message).toContain('action_run_python');
    expect(r.shouldReject).toBe(true);
  });

  it('codice JavaScript in action_run_python → critical', () => {
    const r = runQualityGate({
      nodes: [
        { id: 't', defId: 'trigger_manual', config: {} },
        { id: 'a', defId: 'action_run_python', config: { code: JS_CODE } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    const issue = r.issues.find((i) => i.code === 'CODE_NODE_LANG_MISMATCH');
    expect(issue).toBeDefined();
    expect(issue!.message).toContain('action_run_js');
  });

  it('codice corretto (JS in run_js, Python in run_python) → nessun issue', () => {
    const r = runQualityGate({
      nodes: [
        { id: 'js', defId: 'action_run_js', config: { code: JS_CODE } },
        { id: 'py', defId: 'action_run_python', config: { code: PYTHON_CODE } },
      ],
      edges: [],
    });
    expect(r.issues.some((i) => i.code === 'CODE_NODE_LANG_MISMATCH')).toBe(false);
  });

  it('codice ambiguo → NON flagga (anti falso-positivo)', () => {
    const r = runQualityGate({
      nodes: [{ id: 'a', defId: 'action_run_js', config: { code: 'result = input.value' } }],
      edges: [],
    });
    expect(r.issues.some((i) => i.code === 'CODE_NODE_LANG_MISMATCH')).toBe(false);
  });

  it('nodo non-code con "import" nel config → ignorato', () => {
    const r = runQualityGate({
      nodes: [{ id: 'h', defId: 'action_http', config: { body: 'import json\nprint(x)' } }],
      edges: [],
    });
    expect(r.issues.some((i) => i.code === 'CODE_NODE_LANG_MISMATCH')).toBe(false);
  });

  it('code vuoto → no-op', () => {
    const r = runQualityGate({
      nodes: [{ id: 'a', defId: 'action_run_js', config: { code: '  ' } }],
      edges: [],
    });
    expect(r.issues.some((i) => i.code === 'CODE_NODE_LANG_MISMATCH')).toBe(false);
  });
});

describe('QualityGate — DB_COLUMN_NOT_IN_SCHEMA (bug user 2026-06-09)', () => {
  // Schema reale price_monitoring del tenant senza1dio.
  const DBS = [{
    id: 'QhktHRtIKHL5aniYhgRvz',
    tables: ['price_monitoring', 'customers', 'orders'],
    columns: {
      price_monitoring: ['id', 'url', 'price', 'median_price', 'timestamp'],
      customers: ['id', 'name', 'email'],
    },
  }];

  it('db_insert rowJson con colonne inesistenti (code/created_at) → critical', () => {
    const r = runQualityGate({
      nodes: [{
        id: 'db_insert_1',
        defId: 'db_insert',
        config: {
          databaseId: 'QhktHRtIKHL5aniYhgRvz',
          table: 'price_monitoring',
          rowJson: '{"code":"{{$node.action_1.json.stdout}}","created_at":"{{$now}}"}',
        },
      }],
      edges: [],
      databases: DBS,
    });
    const issue = r.issues.find((i) => i.code === 'DB_COLUMN_NOT_IN_SCHEMA');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('critical');
    expect(issue!.field).toBe('rowJson');
    expect(issue!.message).toContain('"code"');
    expect(issue!.message).toContain('"created_at"');
    // Deve elencare le colonne reali disponibili.
    expect(issue!.message).toContain('median_price');
    expect(r.shouldReject).toBe(true);
  });

  it('db_insert rowJson con SOLO colonne valide → nessun issue', () => {
    const r = runQualityGate({
      nodes: [{
        id: 'i',
        defId: 'db_insert',
        config: {
          databaseId: 'QhktHRtIKHL5aniYhgRvz',
          table: 'price_monitoring',
          rowJson: '{"url":"https://x","price":9.9,"timestamp":"{{$now}}"}',
        },
      }],
      edges: [],
      databases: DBS,
    });
    expect(r.issues.some((i) => i.code === 'DB_COLUMN_NOT_IN_SCHEMA')).toBe(false);
  });

  it('rowJson come oggetto (non stringa) viene comunque validato', () => {
    const r = runQualityGate({
      nodes: [{
        id: 'i',
        defId: 'db_insert',
        config: {
          databaseId: 'QhktHRtIKHL5aniYhgRvz',
          table: 'customers',
          rowJson: { id: '1', nome: 'x' }, // "nome" non esiste (è "name")
        },
      }],
      edges: [],
      databases: DBS,
    });
    const issue = r.issues.find((i) => i.code === 'DB_COLUMN_NOT_IN_SCHEMA');
    expect(issue).toBeDefined();
    expect(issue!.message).toContain('"nome"');
  });

  it('db_update valida sia whereJson sia patchJson', () => {
    const r = runQualityGate({
      nodes: [{
        id: 'u',
        defId: 'db_update',
        config: {
          databaseId: 'QhktHRtIKHL5aniYhgRvz',
          table: 'customers',
          whereJson: '{"id":"1"}',           // valido
          patchJson: '{"phone":"+39"}',       // "phone" non esiste
        },
      }],
      edges: [],
      databases: DBS,
    });
    const issues = r.issues.filter((i) => i.code === 'DB_COLUMN_NOT_IN_SCHEMA');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.field).toBe('patchJson');
    expect(issues[0]!.message).toContain('"phone"');
  });

  it('chiavi che sono espressioni {{...}} vengono ignorate (non sono nomi-colonna)', () => {
    const r = runQualityGate({
      nodes: [{
        id: 'i',
        defId: 'db_insert',
        config: {
          databaseId: 'QhktHRtIKHL5aniYhgRvz',
          table: 'price_monitoring',
          rowJson: '{"{{dynamicCol}}":"v","url":"https://x"}',
        },
      }],
      edges: [],
      databases: DBS,
    });
    expect(r.issues.some((i) => i.code === 'DB_COLUMN_NOT_IN_SCHEMA')).toBe(false);
  });

  it('databaseId placeholder __USE_PICKER__ → skip (utente sceglierà post-import)', () => {
    const r = runQualityGate({
      nodes: [{
        id: 'i',
        defId: 'db_insert',
        config: { databaseId: '__USE_PICKER__', table: 'price_monitoring', rowJson: '{"foo":"bar"}' },
      }],
      edges: [],
      databases: DBS,
    });
    expect(r.issues.some((i) => i.code === 'DB_COLUMN_NOT_IN_SCHEMA')).toBe(false);
  });

  it('tabella senza info colonne (non in columns map) → skip colonna (table check resta)', () => {
    const r = runQualityGate({
      nodes: [{
        id: 'i',
        defId: 'db_insert',
        config: { databaseId: 'QhktHRtIKHL5aniYhgRvz', table: 'orders', rowJson: '{"whatever":"x"}' },
      }],
      edges: [],
      databases: DBS, // 'orders' è in tables ma NON in columns → skip colonna
    });
    expect(r.issues.some((i) => i.code === 'DB_COLUMN_NOT_IN_SCHEMA')).toBe(false);
  });

  it('databases senza columns del tutto → rule disattivata (backward compat)', () => {
    const r = runQualityGate({
      nodes: [{
        id: 'i',
        defId: 'db_insert',
        config: { databaseId: 'd1', table: 'price_monitoring', rowJson: '{"nope":"x"}' },
      }],
      edges: [],
      databases: [{ id: 'd1', tables: ['price_monitoring'] }], // no columns
    });
    expect(r.issues.some((i) => i.code === 'DB_COLUMN_NOT_IN_SCHEMA')).toBe(false);
  });
});

describe('QualityGate — integrazione: workflow ROTTO REALE "Crea Node Code" (2026-06-09)', () => {
  // Il workflow esatto generato da Liara per "creami un node code", che il
  // gate PRE-fix lasciava passare. Ora deve essere rigettato per i bug REALI.
  it('rigetta il workflow con language-mismatch + colonne db inesistenti', () => {
    const r = runQualityGate({
      nodes: [
        { id: 'trigger_1', defId: 'trigger_manual', config: { name: 'Avvia Creazione Codice' } },
        {
          id: 'action_1',
          defId: 'action_run_js',
          config: {
            code: 'import json, os\ndata = json.loads(os.environ.get("FLOWFORGE_INPUT", "{}"))\nprint({"received_keys": list(data.keys()), "count": len(data)})',
            timeoutMs: '30000', parseStdoutJson: 'true', allowNetwork: 'false',
          },
        },
        {
          id: 'db_insert_1',
          defId: 'db_insert',
          config: {
            databaseId: 'QhktHRtIKHL5aniYhgRvz', table: 'price_monitoring',
            rowJson: '{"code":"{{$node.action_1.json.stdout}}","created_at":"{{$now}}"}',
            onConflict: 'fail',
          },
        },
      ],
      edges: [
        { from: 'trigger_1', to: 'action_1' },
        { from: 'action_1', to: 'db_insert_1' },
      ],
      databases: [{
        id: 'QhktHRtIKHL5aniYhgRvz',
        tables: ['price_monitoring'],
        columns: { price_monitoring: ['id', 'url', 'price', 'median_price', 'timestamp'] },
      }],
    });
    expect(r.shouldReject).toBe(true);
    const codes = new Set(r.issues.map((i) => i.code));
    expect(codes.has('CODE_NODE_LANG_MISMATCH')).toBe(true);
    expect(codes.has('DB_COLUMN_NOT_IN_SCHEMA')).toBe(true);
  });
});
