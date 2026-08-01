/**
 * auto-fix Layer C — test 2026-grade.
 *
 * Coverage:
 *  - Placeholder → {{secrets.X}} (S3 bucket, SMTP, noreply, URL)
 *  - ID risorsa fittizi → __USE_PICKER__
 *  - Duplicate nodes merge + edge reroute + dedup
 *  - Idempotenza (rigirare 2x = stesso output)
 *  - Preserve template syntax {{...}} e $node.X
 */
import { describe, it, expect } from 'vitest';
import { autoFixWorkflow, isPickerResolvableField } from './auto-fix.js';

describe('autoFixWorkflow — placeholder → secret', () => {
  it('s3://bucket-name → {{secrets.S3_BUCKET}}', () => {
    const r = autoFixWorkflow({
      nodes: [{ id: 't', defId: 'trigger_file_watch', config: { directory: 's3://bucket-name/docs', glob: '*.pdf' } }],
      edges: [],
    });
    expect(r.nodes[0]!.config.directory).toBe('{{secrets.S3_BUCKET}}/docs');
    expect(r.appliedFixes.some((f) => f.type === 'placeholder_to_secret' && f.field === 'directory')).toBe(true);
  });

  it('smtp.example.com → {{secrets.SMTP_HOST}}', () => {
    const r = autoFixWorkflow({
      nodes: [{ id: 'm', defId: 'action_send_email', config: { host: 'smtp.example.com' } }],
      edges: [],
    });
    expect(r.nodes[0]!.config.host).toBe('{{secrets.SMTP_HOST}}');
  });

  it('noreply@company.com → {{secrets.NOREPLY_EMAIL}}', () => {
    const r = autoFixWorkflow({
      nodes: [{ id: 'm', defId: 'action_send_email', config: { from: 'noreply@company.com' } }],
      edges: [],
    });
    expect(r.nodes[0]!.config.from).toBe('{{secrets.NOREPLY_EMAIL}}');
  });

  it('management@company.com → {{secrets.NOTIFY_EMAIL}}', () => {
    const r = autoFixWorkflow({
      nodes: [{ id: 'm', defId: 'action_send_email', config: { to: 'management@company.com' } }],
      edges: [],
    });
    expect(r.nodes[0]!.config.to).toBe('{{secrets.NOTIFY_EMAIL}}');
  });

  it('{{secrets.X}} esistenti → preservati (no replace)', () => {
    const r = autoFixWorkflow({
      nodes: [{ id: 'h', defId: 'action_http', config: { url: '{{secrets.MY_API}}', body: '{{$node.prev.json}}' } }],
      edges: [],
    });
    expect(r.nodes[0]!.config.url).toBe('{{secrets.MY_API}}');
    expect(r.nodes[0]!.config.body).toBe('{{$node.prev.json}}');
    expect(r.appliedFixes).toEqual([]);
  });
});

describe('autoFixWorkflow — ID risorsa → __USE_PICKER__', () => {
  it('databaseId="db_opportunities" → __USE_PICKER__', () => {
    const r = autoFixWorkflow({
      nodes: [{ id: 'n', defId: 'community_notion', config: { databaseId: 'db_opportunities', table: 'logs' } }],
      edges: [],
    });
    expect(r.nodes[0]!.config.databaseId).toBe('__USE_PICKER__');
    expect(r.appliedFixes.some((f) => f.type === 'id_to_picker_marker')).toBe(true);
  });

  it('systemAccountId="email-account-1" → __USE_PICKER__', () => {
    const r = autoFixWorkflow({
      nodes: [{ id: 'm', defId: 'action_send_email', config: { systemAccountId: 'email-account-1' } }],
      edges: [],
    });
    expect(r.nodes[0]!.config.systemAccountId).toBe('__USE_PICKER__');
  });

  it('databaseId UUID reale → preservato', () => {
    const r = autoFixWorkflow({
      nodes: [{ id: 'n', defId: 'db_insert', config: { databaseId: 'd43e6f82-b056-4481-8284-8b812f499b77' } }],
      edges: [],
    });
    expect(r.nodes[0]!.config.databaseId).toBe('d43e6f82-b056-4481-8284-8b812f499b77');
    expect(r.appliedFixes).toEqual([]);
  });

  it('databaseId={{secrets.X}} template → preservato', () => {
    const r = autoFixWorkflow({
      nodes: [{ id: 'n', defId: 'db_insert', config: { databaseId: '{{secrets.DB_ID}}' } }],
      edges: [],
    });
    expect(r.nodes[0]!.config.databaseId).toBe('{{secrets.DB_ID}}');
  });

  it('table (non-id field) → SKIP, non viene toccato', () => {
    const r = autoFixWorkflow({
      nodes: [{ id: 'n', defId: 'db_insert', config: { table: 'orders', databaseId: 'd43e6f82-b056-4481-8284-8b812f499b77' } }],
      edges: [],
    });
    expect(r.nodes[0]!.config.table).toBe('orders');
  });
});

describe('autoFixWorkflow — merge duplicate nodes', () => {
  it('4× db_insert stesso config → 1 nodo + edges re-routati', () => {
    const r = autoFixWorkflow({
      nodes: [
        { id: 't', defId: 'trigger_webhook', config: {} },
        { id: 'sw', defId: 'logic_switch', config: { expression: 'x' } },
        { id: 'db1', defId: 'db_insert', config: { table: 'logs', rowJson: '{"x":1}' } },
        { id: 'db2', defId: 'db_insert', config: { table: 'logs', rowJson: '{"x":1}' } },
        { id: 'db3', defId: 'db_insert', config: { table: 'logs', rowJson: '{"x":1}' } },
        { id: 'db4', defId: 'db_insert', config: { table: 'logs', rowJson: '{"x":1}' } },
      ],
      edges: [
        { from: 't', to: 'sw' },
        { from: 'sw', to: 'db1' },
        { from: 'sw', to: 'db2' },
        { from: 'sw', to: 'db3' },
        { from: 'sw', to: 'db4' },
      ],
    });
    // Resta solo 1 db_insert (db1, primo trovato)
    expect(r.nodes.filter((n) => n.defId === 'db_insert')).toHaveLength(1);
    // Edge: sw → db1 (gli altri vengono deduplicati dopo reroute)
    const swToDb = r.edges.filter((e) => e.from === 'sw' && e.to === 'db1');
    expect(swToDb.length).toBe(1);
    expect(r.appliedFixes.some((f) => f.type === 'merge_duplicate_nodes')).toBe(true);
  });

  it('config DIVERSI → NO merge', () => {
    const r = autoFixWorkflow({
      nodes: [
        { id: 't', defId: 'trigger_webhook', config: {} },
        { id: 'db1', defId: 'db_insert', config: { table: 'a' } },
        { id: 'db2', defId: 'db_insert', config: { table: 'b' } },
      ],
      edges: [{ from: 't', to: 'db1' }, { from: 't', to: 'db2' }],
    });
    expect(r.nodes.filter((n) => n.defId === 'db_insert')).toHaveLength(2);
    expect(r.appliedFixes.filter((f) => f.type === 'merge_duplicate_nodes')).toHaveLength(0);
  });
});

describe('autoFixWorkflow — idempotenza', () => {
  it('applicare 2 volte → stesso output al run 2', () => {
    const input = {
      nodes: [
        { id: 'm', defId: 'action_send_email', config: { host: 'smtp.example.com', from: 'noreply@company.com' } },
        { id: 'n', defId: 'community_notion', config: { databaseId: 'db_opportunities' } },
      ],
      edges: [{ from: 'm', to: 'n' }],
    };
    const r1 = autoFixWorkflow(input);
    const r2 = autoFixWorkflow({ nodes: r1.nodes, edges: r1.edges });
    expect(r2.appliedFixes).toEqual([]); // run 2 = niente da fare
    expect(r2.nodes).toEqual(r1.nodes);
  });
});

describe('autoFixWorkflow — force_loop_strategy_batch (regression)', () => {
  it('loop con downstream agent_data_analyst+keyword "report" → strategy=batch', () => {
    const r = autoFixWorkflow({
      nodes: [
        { id: 'trig', defId: 'trigger_manual', config: {} },
        { id: 'loop', defId: 'logic_loop', config: { itemsExpression: '{{$node.trig.json.items}}' } },
        { id: 'fetch', defId: 'action_web_fetch_advanced', config: { url: 'https://x' } },
        { id: 'agg', defId: 'agent_data_analyst', config: { prompt: 'genera un report completo' } },
      ],
      edges: [
        { from: 'trig', to: 'loop' },
        { from: 'loop', to: 'fetch' },
        { from: 'fetch', to: 'agg' },
      ],
    });
    const loop = r.nodes.find((n) => n.id === 'loop');
    expect(loop?.config.strategy).toBe('batch');
    const fix = r.appliedFixes.find((f) => f.type === 'force_loop_strategy_batch');
    expect(fix).toBeDefined();
    expect(fix?.before).toBe('naive');
    expect(fix?.after).toBe('batch');
  });

  it('loop con downstream action_send_email+keyword "summary" → strategy=batch', () => {
    const r = autoFixWorkflow({
      nodes: [
        { id: 'loop', defId: 'logic_loop', config: {} },
        { id: 'mail', defId: 'action_send_email', config: { subject: 'Daily summary report' } },
      ],
      edges: [{ from: 'loop', to: 'mail' }],
    });
    const loop = r.nodes.find((n) => n.id === 'loop');
    expect(loop?.config.strategy).toBe('batch');
  });

  it('loop senza aggregator downstream → strategy NON modificata', () => {
    const r = autoFixWorkflow({
      nodes: [
        { id: 'loop', defId: 'logic_loop', config: {} },
        { id: 'db', defId: 'db_insert', config: { table: 'logs' } },
      ],
      edges: [{ from: 'loop', to: 'db' }],
    });
    const loop = r.nodes.find((n) => n.id === 'loop');
    expect(loop?.config.strategy).toBeUndefined();
    expect(r.appliedFixes.find((f) => f.type === 'force_loop_strategy_batch')).toBeUndefined();
  });

  it('loop con send_email SENZA keyword aggregazione → NON modificato (legittimo per-item notification)', () => {
    const r = autoFixWorkflow({
      nodes: [
        { id: 'loop', defId: 'logic_loop', config: {} },
        { id: 'mail', defId: 'action_send_email', config: { subject: 'Welcome to {{item.name}}', body: 'Ciao!' } },
      ],
      edges: [{ from: 'loop', to: 'mail' }],
    });
    const loop = r.nodes.find((n) => n.id === 'loop');
    expect(loop?.config.strategy).toBeUndefined();
  });

  it('idempotenza: secondo run su workflow già batch non re-applica fix', () => {
    const input = {
      nodes: [
        { id: 'loop', defId: 'logic_loop', config: { strategy: 'batch' } },
        { id: 'agg', defId: 'agent_data_analyst', config: { prompt: 'aggregated report' } },
      ],
      edges: [{ from: 'loop', to: 'agg' }],
    };
    const r = autoFixWorkflow(input);
    expect(r.appliedFixes.find((f) => f.type === 'force_loop_strategy_batch')).toBeUndefined();
  });
});

describe('autoFixWorkflow — combined real-case', () => {
  it('SEO audit workflow con tutti i problemi → fix tutti', () => {
    const r = autoFixWorkflow({
      nodes: [
        { id: 't', defId: 'trigger_cron', config: { cronExpression: '0 9 * * 1' } },
        { id: 'web', defId: 'action_web_fetch_advanced', config: { url: 'https://api.company.com/x' } },
        { id: 'meta', defId: 'action_meta_extract', config: {} },
        { id: 'db', defId: 'db_insert', config: { databaseId: 'db_seo_audits', table: 'audits' } },
        { id: 'mail', defId: 'action_send_email', config: { systemAccountId: 'email-account-1', from: 'noreply@company.com' } },
      ],
      edges: [
        { from: 't', to: 'web' },
        { from: 'web', to: 'meta' },
        { from: 'meta', to: 'db' },
        { from: 'db', to: 'mail' },
      ],
    });
    // url: api.company.com → secrets
    expect(r.nodes[1]!.config.url).toContain('{{secrets.API_URL}}');
    // databaseId: db_seo_audits → __USE_PICKER__
    expect(r.nodes[3]!.config.databaseId).toBe('__USE_PICKER__');
    // systemAccountId → __USE_PICKER__
    expect(r.nodes[4]!.config.systemAccountId).toBe('__USE_PICKER__');
    // from: noreply@company.com → secrets
    expect(r.nodes[4]!.config.from).toBe('{{secrets.NOREPLY_EMAIL}}');
    expect(r.appliedFixes.length).toBeGreaterThanOrEqual(4);
  });
});

describe('autoFixWorkflow — agent_* provider normalization (2026-06-07)', () => {
  it('agent_data_analyst con openai/gpt-4o + apiKey hard-coded + tenant default=liara → riscritto a liara', () => {
    const r = autoFixWorkflow({
      nodes: [
        {
          id: 'analyst',
          defId: 'agent_data_analyst',
          config: {
            provider: 'openai',
            model: 'gpt-4o',
            apiKey: '{{secrets.OPENAI_API_KEY}}',
            extraContext: 'aggrega risultati',
          },
        },
      ],
      edges: [],
      tenantDefaultLlmProvider: 'liara',
    });
    expect(r.nodes[0]!.config.provider).toBe('liara');
    expect(r.nodes[0]!.config.model).toBeUndefined();
    expect(r.nodes[0]!.config.apiKey).toBeUndefined();
    expect(r.nodes[0]!.config.extraContext).toBe('aggrega risultati');
    expect(r.appliedFixes.some((f) => f.type === 'agent_provider_normalized')).toBe(true);
  });

  it('agent_* con provider gia\\` allineato al tenant default → no-op', () => {
    const r = autoFixWorkflow({
      nodes: [
        { id: 'summ', defId: 'agent_summarizer', config: { provider: 'anthropic', model: 'claude-sonnet-4-5' } },
      ],
      edges: [],
      tenantDefaultLlmProvider: 'anthropic',
    });
    expect(r.nodes[0]!.config.provider).toBe('anthropic');
    expect(r.nodes[0]!.config.model).toBe('claude-sonnet-4-5');
    expect(r.appliedFixes.some((f) => f.type === 'agent_provider_normalized')).toBe(false);
  });

  it('tenantDefaultLlmProvider null → no normalization (back-compat)', () => {
    const r = autoFixWorkflow({
      nodes: [
        { id: 'a', defId: 'agent_extractor', config: { provider: 'openai', model: 'gpt-4o' } },
      ],
      edges: [],
    });
    expect(r.nodes[0]!.config.provider).toBe('openai');
    expect(r.nodes[0]!.config.model).toBe('gpt-4o');
    expect(r.appliedFixes.some((f) => f.type === 'agent_provider_normalized')).toBe(false);
  });

  it('agent_* con provider vuoto → preservato (runtime fallback al default)', () => {
    const r = autoFixWorkflow({
      nodes: [
        { id: 'a', defId: 'agent_classifier', config: { provider: '', labels: 'urgent,normal' } },
      ],
      edges: [],
      tenantDefaultLlmProvider: 'liara',
    });
    expect(r.nodes[0]!.config.provider).toBe('');
    expect(r.appliedFixes.some((f) => f.type === 'agent_provider_normalized')).toBe(false);
  });

  it('riscrittura clear solo i model knownPrefix — niente clear di custom model', () => {
    const r = autoFixWorkflow({
      nodes: [
        { id: 'a', defId: 'agent_translator', config: { provider: 'openai', model: 'custom-fine-tune-v3' } },
      ],
      edges: [],
      tenantDefaultLlmProvider: 'liara',
    });
    expect(r.nodes[0]!.config.provider).toBe('liara');
    // 'custom-fine-tune-v3' non matcha gpt-/claude-/gemini-/… → preservato
    expect(r.nodes[0]!.config.model).toBe('custom-fine-tune-v3');
  });

  it('idempotente: girare 2x produce stesso risultato', () => {
    const input = {
      nodes: [
        { id: 'a', defId: 'agent_validator', config: { provider: 'google', model: 'gemini-2.0-flash', apiKey: '{{secrets.GOOGLE_AI_KEY}}' } },
      ],
      edges: [],
      tenantDefaultLlmProvider: 'liara',
    };
    const r1 = autoFixWorkflow(input);
    const r2 = autoFixWorkflow({ ...input, nodes: r1.nodes, edges: r1.edges });
    expect(r2.nodes[0]!.config.provider).toBe('liara');
    expect(r2.appliedFixes.some((f) => f.type === 'agent_provider_normalized')).toBe(false);
  });

  it('nodi non-agent_* non vengono toccati anche se hanno field provider', () => {
    const r = autoFixWorkflow({
      nodes: [
        { id: 'a', defId: 'action_http', config: { provider: 'openai', url: 'https://api.openai.com' } },
      ],
      edges: [],
      tenantDefaultLlmProvider: 'liara',
    });
    // action_http NON è un agent_* → no normalization
    expect(r.nodes[0]!.config.provider).toBe('openai');
    expect(r.appliedFixes.some((f) => f.type === 'agent_provider_normalized')).toBe(false);
  });
});

describe('autoFixWorkflow — obsolete model auto-clear (2026-06-07)', () => {
  it('agent_data_analyst con anthropic + claude-3-haiku-20240307 → field model rimosso', () => {
    const r = autoFixWorkflow({
      nodes: [
        { id: 'a', defId: 'agent_data_analyst', config: { provider: 'anthropic', model: 'claude-3-haiku-20240307', extraContext: 'aggrega' } },
      ],
      edges: [],
    });
    expect(r.nodes[0]!.config.model).toBeUndefined();
    expect(r.nodes[0]!.config.provider).toBe('anthropic');
    expect(r.nodes[0]!.config.extraContext).toBe('aggrega');
    expect(r.appliedFixes.some((f) => f.type === 'obsolete_model_cleared')).toBe(true);
  });

  it('openai gpt-3.5-turbo-0613 → cleared', () => {
    const r = autoFixWorkflow({
      nodes: [
        { id: 'a', defId: 'agent_classifier', config: { provider: 'openai', model: 'gpt-3.5-turbo-0613' } },
      ],
      edges: [],
    });
    expect(r.nodes[0]!.config.model).toBeUndefined();
  });

  it('modello corrente claude-sonnet-4-5 → non clearrato', () => {
    const r = autoFixWorkflow({
      nodes: [
        { id: 'a', defId: 'agent_summarizer', config: { provider: 'anthropic', model: 'claude-sonnet-4-5' } },
      ],
      edges: [],
    });
    expect(r.nodes[0]!.config.model).toBe('claude-sonnet-4-5');
    expect(r.appliedFixes.some((f) => f.type === 'obsolete_model_cleared')).toBe(false);
  });

  it('idempotente: girare 2x produce stesso risultato', () => {
    const input = {
      nodes: [
        { id: 'a', defId: 'agent_extractor', config: { provider: 'gemini', model: 'gemini-pro' } },
      ],
      edges: [],
    };
    const r1 = autoFixWorkflow(input);
    expect(r1.nodes[0]!.config.model).toBeUndefined();
    const r2 = autoFixWorkflow({ nodes: r1.nodes, edges: r1.edges });
    expect(r2.nodes[0]!.config.model).toBeUndefined();
    expect(r2.appliedFixes.some((f) => f.type === 'obsolete_model_cleared')).toBe(false);
  });

  it('non-agent node con model obsoleto → ignorato (no side effect)', () => {
    const r = autoFixWorkflow({
      nodes: [
        { id: 'a', defId: 'action_http', config: { provider: 'openai', model: 'gpt-3.5-turbo-0613' } },
      ],
      edges: [],
    });
    expect(r.nodes[0]!.config.model).toBe('gpt-3.5-turbo-0613');
    expect(r.appliedFixes.some((f) => f.type === 'obsolete_model_cleared')).toBe(false);
  });

  // FAN_IN auto-fix — quando >1 edge converge su non-aggregator
  describe('fan-in auto-fix → flow_merge inserito', () => {
    it('3 edges → db_insert: inserisce flow_merge prima', () => {
      const r = autoFixWorkflow({
        nodes: [
          { id: 'src_a', defId: 'action_http', config: { url: 'https://a.com' } },
          { id: 'src_b', defId: 'action_http', config: { url: 'https://b.com' } },
          { id: 'src_c', defId: 'action_http', config: { url: 'https://c.com' } },
          { id: 'log_audit_12', defId: 'db_insert', config: {} },
        ],
        edges: [
          { from: 'src_a', to: 'log_audit_12' },
          { from: 'src_b', to: 'log_audit_12' },
          { from: 'src_c', to: 'log_audit_12' },
        ],
      });
      // Ora dovrebbero esserci 5 nodi (4 original + 1 merge)
      expect(r.nodes).toHaveLength(5);
      const merge = r.nodes.find((n) => n.defId === 'logic_merge');
      expect(merge).toBeDefined();
      expect(merge!.id).toMatch(/^merge_log_audit_12/);
      expect(merge!.config.strategy).toBe('concat');
      // 3 edges sources → merge, 1 edge merge → log_audit_12
      const toMerge = r.edges.filter((e) => e.to === merge!.id);
      expect(toMerge).toHaveLength(3);
      const fromMerge = r.edges.filter((e) => e.from === merge!.id);
      expect(fromMerge).toHaveLength(1);
      expect(fromMerge[0]!.to).toBe('log_audit_12');
      expect(r.appliedFixes.some((f) => f.type === 'fan_in_merge_inserted' && f.nodeId === 'log_audit_12')).toBe(true);
    });

    it('aggregator natural → NO merge inserito', () => {
      const r = autoFixWorkflow({
        nodes: [
          { id: 'a', defId: 'action_http', config: { url: 'https://a.com' } },
          { id: 'b', defId: 'action_http', config: { url: 'https://b.com' } },
          { id: 'sum', defId: 'agent_summarizer', config: {} },
        ],
        edges: [
          { from: 'a', to: 'sum' },
          { from: 'b', to: 'sum' },
        ],
      });
      expect(r.nodes).toHaveLength(3);
      expect(r.appliedFixes.some((f) => f.type === 'fan_in_merge_inserted')).toBe(false);
    });

    it('logic_if branch picker → NO merge inserito', () => {
      const r = autoFixWorkflow({
        nodes: [
          { id: 'a', defId: 'action_http', config: { url: 'https://a.com' } },
          { id: 'b', defId: 'action_http', config: { url: 'https://b.com' } },
          { id: 'if1', defId: 'logic_if', config: {} },
        ],
        edges: [
          { from: 'a', to: 'if1' },
          { from: 'b', to: 'if1' },
        ],
      });
      expect(r.nodes).toHaveLength(3);
      expect(r.appliedFixes.some((f) => f.type === 'fan_in_merge_inserted')).toBe(false);
    });

    it('1 edge → non-aggregator: NO merge (no fan-in)', () => {
      const r = autoFixWorkflow({
        nodes: [
          { id: 'a', defId: 'action_http', config: {} },
          { id: 'db', defId: 'db_insert', config: {} },
        ],
        edges: [{ from: 'a', to: 'db' }],
      });
      expect(r.nodes).toHaveLength(2);
      expect(r.appliedFixes.some((f) => f.type === 'fan_in_merge_inserted')).toBe(false);
    });

    it('multipli fan-in → merge per ciascuno', () => {
      const r = autoFixWorkflow({
        nodes: [
          { id: 'a', defId: 'action_http', config: { url: 'https://a.com' } },
          { id: 'b', defId: 'action_http', config: { url: 'https://b.com' } },
          { id: 'c', defId: 'action_http', config: { url: 'https://c.com' } },
          { id: 'd', defId: 'action_http', config: { url: 'https://d.com' } },
          { id: 'db1', defId: 'db_insert', config: {} },
          { id: 'email1', defId: 'action_send_email', config: {} },
        ],
        edges: [
          { from: 'a', to: 'db1' }, { from: 'b', to: 'db1' },
          { from: 'c', to: 'email1' }, { from: 'd', to: 'email1' },
        ],
      });
      const merges = r.nodes.filter((n) => n.defId === 'logic_merge');
      expect(merges).toHaveLength(2);
    });

    // E2E: dopo auto-fix il quality-gate NON solleva FAN_IN_WITHOUT_MERGE
    // (assertion vera vs fake-mock — usa il vero checkFanInWithoutMerge logic)
    it('🚨 E2E reale: dopo auto-fix il workflow PASSA il check fan-in del quality-gate', async () => {
      const broken = {
        nodes: [
          { id: 'extract', defId: 'agent_extractor', config: { provider: 'anthropic' } },
          { id: 'clearbit', defId: 'action_http', config: { url: 'https://clearbit.com/api' } },
          { id: 'fetch_home', defId: 'action_http', config: { url: 'https://{{$node.extract.json.domain}}' } },
          { id: 'linkedin', defId: 'action_http', config: { url: 'https://linkedin.com/api/search' } },
          { id: 'log_audit_12', defId: 'db_insert', config: { table: 'crm_log' } },
        ],
        edges: [
          { from: 'extract', to: 'clearbit' },
          { from: 'extract', to: 'fetch_home' },
          { from: 'extract', to: 'linkedin' },
          { from: 'clearbit', to: 'log_audit_12' },
          { from: 'fetch_home', to: 'log_audit_12' },
          { from: 'linkedin', to: 'log_audit_12' },
        ],
      };
      // Pre-fix: il quality gate trovava 1 issue critical FAN_IN_WITHOUT_MERGE
      const { runQualityGate } = await import('./quality-gate.js');
      const resultPre = runQualityGate({ nodes: broken.nodes, edges: broken.edges });
      const preFanIn = resultPre.issues.filter((i) => i.code === 'FAN_IN_WITHOUT_MERGE');
      expect(preFanIn.length).toBe(1);
      expect(preFanIn[0]!.nodeId).toBe('log_audit_12');

      // Apply auto-fix
      const fixed = autoFixWorkflow(broken);
      expect(fixed.appliedFixes.some((f) => f.type === 'fan_in_merge_inserted')).toBe(true);

      // Post-fix: il quality gate NON solleva più FAN_IN_WITHOUT_MERGE
      const resultPost = runQualityGate({ nodes: fixed.nodes, edges: fixed.edges });
      const postFanIn = resultPost.issues.filter((i) => i.code === 'FAN_IN_WITHOUT_MERGE');
      expect(postFanIn.length).toBe(0);
    });

    // Idempotenza: girare auto-fix N volte produce stesso risultato (no merge duplicati)
    it('idempotente: applicare auto-fix 3 volte non aggiunge merge duplicati', () => {
      const input = {
        nodes: [
          { id: 'a', defId: 'action_http', config: { url: 'https://a.com' } },
          { id: 'b', defId: 'action_http', config: { url: 'https://b.com' } },
          { id: 'db', defId: 'db_insert', config: {} },
        ],
        edges: [
          { from: 'a', to: 'db' },
          { from: 'b', to: 'db' },
        ],
      };
      const r1 = autoFixWorkflow(input);
      const merges1 = r1.nodes.filter((n) => n.defId === 'logic_merge').length;
      expect(merges1).toBe(1);
      const r2 = autoFixWorkflow({ nodes: r1.nodes, edges: r1.edges });
      const merges2 = r2.nodes.filter((n) => n.defId === 'logic_merge').length;
      expect(merges2).toBe(1);
      const r3 = autoFixWorkflow({ nodes: r2.nodes, edges: r2.edges });
      const merges3 = r3.nodes.filter((n) => n.defId === 'logic_merge').length;
      expect(merges3).toBe(1);
    });

    // Verifica che la regola FAN-IN sia effettivamente nel SYSTEM_PROMPT
    // (anti-regression contro futuro context-compaction che la rimuova)
    it('🚨 SYSTEM_PROMPT contiene la regola FAN-IN HARD RULE (anti-regression compaction)', async () => {
      const { SYSTEM_PROMPT } = await import('./prompts.js');
      expect(SYSTEM_PROMPT).toContain('FAN-IN HARD RULE');
      expect(SYSTEM_PROMPT).toContain('flow_merge');
      expect(SYSTEM_PROMPT).toContain('non-aggregator');
    });
  });

  describe('code-node language auto-heal (bug user 2026-06-09)', () => {
    // Il codice ESATTO generato da Liara nel bug report: Python dentro run_js.
    const PYTHON_CODE = [
      'import json, os',
      '',
      'data = json.loads(os.environ.get("FLOWFORGE_INPUT", "{}"))',
      'print({"received_keys": list(data.keys()), "count": len(data)})',
    ].join('\n');
    const JS_CODE = [
      'const items = input.items || [];',
      'const total = items.reduce((s, x) => s + (x.amount || 0), 0);',
      'return { total, count: items.length };',
    ].join('\n');

    it('action_run_js con codice Python → corretto a action_run_python', () => {
      const r = autoFixWorkflow({
        nodes: [{
          id: 'action_1',
          defId: 'action_run_js',
          config: { code: PYTHON_CODE, timeoutMs: '30000', parseStdoutJson: 'true', allowNetwork: 'false' },
        }],
        edges: [],
      });
      expect(r.nodes[0]!.defId).toBe('action_run_python');
      const fix = r.appliedFixes.find((f) => f.type === 'code_node_lang_corrected');
      expect(fix).toBeDefined();
      expect(fix!.before).toBe('action_run_js');
      expect(fix!.after).toBe('action_run_python');
      // Il codice NON viene toccato — solo il defId.
      expect(r.nodes[0]!.config.code).toBe(PYTHON_CODE);
    });

    it('action_run_python con codice JavaScript → corretto a action_run_js', () => {
      const r = autoFixWorkflow({
        nodes: [{ id: 'a', defId: 'action_run_python', config: { code: JS_CODE } }],
        edges: [],
      });
      expect(r.nodes[0]!.defId).toBe('action_run_js');
      expect(r.appliedFixes.some((f) => f.type === 'code_node_lang_corrected')).toBe(true);
    });

    it('NON tocca un nodo run_js con codice JS corretto (no falso positivo)', () => {
      const r = autoFixWorkflow({
        nodes: [{ id: 'a', defId: 'action_run_js', config: { code: JS_CODE } }],
        edges: [],
      });
      expect(r.nodes[0]!.defId).toBe('action_run_js');
      expect(r.appliedFixes.some((f) => f.type === 'code_node_lang_corrected')).toBe(false);
    });

    it('NON tocca un nodo run_python con codice Python corretto', () => {
      const r = autoFixWorkflow({
        nodes: [{ id: 'a', defId: 'action_run_python', config: { code: PYTHON_CODE } }],
        edges: [],
      });
      expect(r.nodes[0]!.defId).toBe('action_run_python');
      expect(r.appliedFixes.some((f) => f.type === 'code_node_lang_corrected')).toBe(false);
    });

    it('NON tocca su codice ambiguo (frammento valido in entrambi)', () => {
      const r = autoFixWorkflow({
        nodes: [{ id: 'a', defId: 'action_run_js', config: { code: 'result = input.value' } }],
        edges: [],
      });
      expect(r.nodes[0]!.defId).toBe('action_run_js');
      expect(r.appliedFixes.some((f) => f.type === 'code_node_lang_corrected')).toBe(false);
    });

    it('NON tocca nodi non-code anche se il config contiene parole tipo "import"', () => {
      const r = autoFixWorkflow({
        nodes: [{ id: 'h', defId: 'action_http', config: { url: 'https://x.it', body: 'import json' } }],
        edges: [],
      });
      expect(r.nodes[0]!.defId).toBe('action_http');
      expect(r.appliedFixes.some((f) => f.type === 'code_node_lang_corrected')).toBe(false);
    });

    it('idempotente: una seconda passata non riapplica il fix', () => {
      const r1 = autoFixWorkflow({
        nodes: [{ id: 'a', defId: 'action_run_js', config: { code: PYTHON_CODE } }],
        edges: [],
      });
      const r2 = autoFixWorkflow({ nodes: r1.nodes, edges: r1.edges });
      expect(r2.nodes[0]!.defId).toBe('action_run_python');
      expect(r2.appliedFixes.some((f) => f.type === 'code_node_lang_corrected')).toBe(false);
    });

    it('code mancante/vuoto → no-op (niente crash)', () => {
      const r = autoFixWorkflow({
        nodes: [
          { id: 'empty', defId: 'action_run_js', config: { code: '   ' } },
          { id: 'nocode', defId: 'action_run_js', config: {} },
        ],
        edges: [],
      });
      expect(r.nodes.every((n) => n.defId === 'action_run_js')).toBe(true);
      expect(r.appliedFixes.some((f) => f.type === 'code_node_lang_corrected')).toBe(false);
    });
  });
});

describe('🔒 orphan-edge heal — merge node referenziato ma non emesso dall’LLM', () => {
  it('scenario user (loop → N branch → merge mancante): crea logic_merge + edge validi', () => {
    // Riproduce il bug prod 2026-06-10 (Sitemap Crawler): 4 branch SEO che
    // convergono su "merge_logic_loop_1" che Liara NON ha messo nei nodi.
    const r = autoFixWorkflow({
      nodes: [
        { id: 'logic_loop_1', defId: 'logic_loop', config: { strategy: 'batch' } },
        { id: 'seo_1', defId: 'action_seo_audit', config: {} },
        { id: 'meta_1', defId: 'action_meta_extract', config: {} },
        { id: 'redir_1', defId: 'action_redirect_chain', config: {} },
        { id: 'link_1', defId: 'action_link_audit', config: {} },
        { id: 'file_1', defId: 'action_file_write', config: {} },
      ],
      edges: [
        { from: 'logic_loop_1', to: 'seo_1' }, { from: 'logic_loop_1', to: 'meta_1' },
        { from: 'logic_loop_1', to: 'redir_1' }, { from: 'logic_loop_1', to: 'link_1' },
        // 4 edge orfani → merge inesistente
        { from: 'seo_1', to: 'merge_logic_loop_1' }, { from: 'meta_1', to: 'merge_logic_loop_1' },
        { from: 'redir_1', to: 'merge_logic_loop_1' }, { from: 'link_1', to: 'merge_logic_loop_1' },
        { from: 'merge_logic_loop_1', to: 'file_1' },
      ],
    });
    const merge = r.nodes.find((n) => n.id === 'merge_logic_loop_1');
    expect(merge, 'merge node creato').toBeDefined();
    expect(merge!.defId).toBe('logic_merge'); // defId VALIDO (no phantom flow_merge)
    expect(r.appliedFixes.some((f) => f.type === 'orphan_edge_healed')).toBe(true);
    // ZERO edge orfani residui: ogni edge.from/to referenzia un nodo esistente
    const ids = new Set(r.nodes.map((n) => n.id));
    for (const e of r.edges) {
      expect(ids.has(e.from), `from ${e.from}`).toBe(true);
      expect(ids.has(e.to), `to ${e.to}`).toBe(true);
    }
  });

  it('edge orfano verso nodo NON-merge → scartato (grafo valido, niente save rotto)', () => {
    const r = autoFixWorkflow({
      nodes: [{ id: 'a', defId: 'trigger_manual', config: {} }, { id: 'b', defId: 'action_http', config: {} }],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'ghost_node_42' }],
    });
    expect(r.nodes.find((n) => n.id === 'ghost_node_42')).toBeUndefined(); // NON creato
    expect(r.edges.some((e) => e.to === 'ghost_node_42')).toBe(false);     // edge droppato
    expect(r.appliedFixes.some((f) => f.type === 'orphan_edge_healed')).toBe(true);
  });

  it('idempotente: ri-eseguire 2× produce lo stesso grafo', () => {
    const input = {
      nodes: [{ id: 'x', defId: 'action_http', config: {} }],
      edges: [{ from: 'x', to: 'merge_x' }],
    };
    const r1 = autoFixWorkflow(input);
    const r2 = autoFixWorkflow({ nodes: r1.nodes, edges: r1.edges });
    expect(r2.nodes.filter((n) => n.id === 'merge_x')).toHaveLength(1);
    expect(r2.edges.length).toBe(r1.edges.length);
  });
});

describe('🔒 guard sistemico: l’auto-fix non emette MAI il defId phantom flow_merge', () => {
  it('fan-in → crea logic_merge (defId REALE), mai flow_merge', () => {
    const r = autoFixWorkflow({
      nodes: [
        { id: 'a', defId: 'action_http', config: {} }, { id: 'b', defId: 'action_http', config: { url: 'x' } },
        { id: 'c', defId: 'action_http', config: { url: 'y' } }, { id: 'sink', defId: 'db_insert', config: { table: 't' } },
      ],
      edges: [{ from: 'a', to: 'sink' }, { from: 'b', to: 'sink' }, { from: 'c', to: 'sink' }],
    });
    expect(r.nodes.some((n) => n.defId === 'flow_merge'), 'nessun flow_merge phantom').toBe(false);
    expect(r.nodes.some((n) => n.defId === 'logic_merge'), 'merge reale inserito').toBe(true);
  });

  it('orphan-heal → crea logic_merge, mai flow_merge', () => {
    const r = autoFixWorkflow({
      nodes: [{ id: 'x', defId: 'action_http', config: {} }],
      edges: [{ from: 'x', to: 'merge_x_1' }],
    });
    expect(r.nodes.some((n) => n.defId === 'flow_merge')).toBe(false);
    expect(r.nodes.find((n) => n.id === 'merge_x_1')?.defId).toBe('logic_merge');
  });
});

describe('isPickerResolvableField — contratto del heal pre-validation (bug diretta YouTube 2026-06-12)', () => {
  it('match per NOME (PICKER_FIELDS_RE): databaseId/emailAccountId anche senza tipo', () => {
    expect(isPickerResolvableField('databaseId')).toBe(true);
    expect(isPickerResolvableField('emailAccountId')).toBe(true);
    expect(isPickerResolvableField('DATABASEID')).toBe(true); // case-insensitive
  });

  it('match per TIPO catalog: table (db-table-picker) è resolvable, ma solo col tipo giusto', () => {
    expect(isPickerResolvableField('table', 'db-table-picker')).toBe(true);
    expect(isPickerResolvableField('workflowTarget', 'workflow-picker')).toBe(true);
    expect(isPickerResolvableField('table')).toBe(false);           // senza tipo: il nome non basta
    expect(isPickerResolvableField('table', 'text')).toBe(false);   // tipo non-picker
  });

  it('campi NON sanabili restano fuori: schema/to/subject/code non sono picker', () => {
    for (const key of ['schema', 'to', 'subject', 'code', 'path', 'cronExpression']) {
      expect(isPickerResolvableField(key), key).toBe(false);
      expect(isPickerResolvableField(key, 'code'), `${key}+code`).toBe(false);
    }
  });
});
