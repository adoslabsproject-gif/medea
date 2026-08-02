/**
 * Smoke E2E — 12 scenari di workflow "tipo-LLM output" che simulano
 * pattern reali di output del modello Liara/Anthropic post-singleshot_generate.
 *
 * Ogni scenario:
 *   1. costruisce un workflow "raw" con bug comuni LLM (fan-in, hallucinated
 *      defId, placeholder hardcoded, switch senza default, ecc.);
 *   2. applica `autoFixWorkflow` (layer C);
 *   3. esegue `runQualityGate` post-fix;
 *   4. asserisce che NESSUN issue critical resta = workflow importabile.
 *
 * Questa suite è il primo test REALE end-to-end della pipeline scaffold —
 * pre-2026-06-09 tutti i test erano sui singoli componenti, qui validiamo
 * la combinata trasformazione `LLM-output → editor-ready`.
 *
 * Aggiungere uno scenario per OGNI nuovo pattern bug visto in prod (log dei
 * run scaffold_rejected). Anti-regression organico.
 *
 * @module services/ai-scaffold/scaffold-scenarios.test
 */
import { describe, it, expect } from 'vitest';
import { autoFixWorkflow } from './auto-fix.js';
import { runQualityGate } from './quality-gate.js';

interface ScenarioWorkflow {
  nodes: { id: string; defId: string; config: Record<string, unknown>; [k: string]: unknown }[];
  edges: { from: string; to: string; [k: string]: unknown }[];
}

/**
 * Esegue il pipeline completo auto-fix + quality-gate e ritorna lo stato finale.
 * Asserzioni helper per i test scenario:
 *   - workflow accettato (no critical issues post-fix)
 *   - fix attesi applicati (es. flow_merge inserito su fan-in)
 *   - nessuna regressione (count nodi/edges plausible)
 */
function pipeline(input: ScenarioWorkflow): {
  fixed: ScenarioWorkflow;
  appliedTypes: string[];
  issuesPost: ReturnType<typeof runQualityGate>['issues'];
  criticalPost: number;
  acceptable: boolean;
} {
  const fixed = autoFixWorkflow(input);
  const appliedTypes = Array.from(new Set(fixed.appliedFixes.map((f) => f.type)));
  const gate = runQualityGate({ nodes: fixed.nodes, edges: fixed.edges });
  const criticalPost = gate.issues.filter((i) => i.severity === 'critical').length;
  return {
    fixed: { nodes: fixed.nodes, edges: fixed.edges },
    appliedTypes,
    issuesPost: gate.issues,
    criticalPost,
    acceptable: criticalPost === 0,
  };
}

describe('Smoke E2E #1 — IMAP-driven CRM enrichment (fan-in classico)', () => {
  // Pattern reale dalla user history: Clearbit + fetch homepage + LinkedIn → log_audit
  it('LLM output con 3 source su db_insert → auto-fix inserisce flow_merge', () => {
    const raw: ScenarioWorkflow = {
      nodes: [
        { id: 'imap_1', defId: 'trigger_imap', config: { folder: 'sales' } },
        { id: 'extract_1', defId: 'agent_extractor', config: { provider: 'anthropic' } },
        {
          id: 'clearbit_1',
          defId: 'action_http',
          config: { url: 'https://clearbit.com/api/companies/{{$node.extract_1.json.domain}}' },
        },
        {
          id: 'fetch_home_1',
          defId: 'action_http',
          config: { url: 'https://{{$node.extract_1.json.domain}}' },
        },
        {
          id: 'linkedin_1',
          defId: 'action_http',
          config: { url: 'https://linkedin.com/search/{{$node.extract_1.json.company}}' },
        },
        {
          id: 'log_audit_1',
          defId: 'db_insert',
          config: { databaseId: '__USE_PICKER__', table: 'crm_log' },
        },
      ],
      edges: [
        { from: 'imap_1', to: 'extract_1' },
        { from: 'extract_1', to: 'clearbit_1' },
        { from: 'extract_1', to: 'fetch_home_1' },
        { from: 'extract_1', to: 'linkedin_1' },
        { from: 'clearbit_1', to: 'log_audit_1' },
        { from: 'fetch_home_1', to: 'log_audit_1' },
        { from: 'linkedin_1', to: 'log_audit_1' },
      ],
    };
    const r = pipeline(raw);
    expect(r.appliedTypes).toContain('fan_in_merge_inserted');
    expect(r.acceptable).toBe(true);
  });
});

describe('Smoke E2E #2 — Webhook con placeholder hardcoded (SMTP host + noreply email)', () => {
  it('SMTP host + noreply@example.com → auto-fix sostituisce con {{secrets.X}}', () => {
    const raw: ScenarioWorkflow = {
      nodes: [
        { id: 'wh_1', defId: 'trigger_webhook', config: { customPath: 'leads' } },
        {
          id: 'email_1',
          defId: 'action_send_email',
          config: {
            smtpHost: 'smtp.example.com',
            smtpUser: 'noreply@example.com',
            smtpPassword: '{{secrets.SMTP_PASSWORD}}',
            to: '{{$node.wh_1.json.email}}',
          },
        },
      ],
      edges: [{ from: 'wh_1', to: 'email_1' }],
    };
    const r = pipeline(raw);
    expect(r.appliedTypes).toContain('placeholder_to_secret');
    expect(r.acceptable).toBe(true);
    const emailNode = r.fixed.nodes.find((n) => n.id === 'email_1')!;
    // Solo i pattern noti distintivi vengono auto-sostituiti.
    // Per password senza pattern (es. 'your_password_here'), l'LLM deve
    // emettere già {{secrets.X}} grazie alla regola 2 nel SYSTEM_PROMPT_LORA.
    expect(emailNode.config.smtpHost).toMatch(/\{\{secrets\./u);
    expect(emailNode.config.smtpUser).toMatch(/\{\{secrets\./u);
  });
});

describe('Smoke E2E #3 — Cron daily summary con loop+aggregator', () => {
  it('Loop su array prodotti → batch strategy forced', () => {
    const raw: ScenarioWorkflow = {
      nodes: [
        { id: 'cron_1', defId: 'trigger_cron', config: { cronExpression: '0 9 * * *' } },
        {
          id: 'query_1',
          defId: 'db_query',
          config: {
            databaseId: '__USE_PICKER__',
            sql: "SELECT * FROM orders WHERE created_at > now() - interval '1 day'",
          },
        },
        {
          id: 'loop_1',
          defId: 'logic_loop',
          config: { itemsExpression: 'input', strategy: 'naive' },
        },
        { id: 'classify_1', defId: 'agent_classifier', config: { provider: 'liara' } },
        {
          id: 'summary_1',
          defId: 'agent_summarizer',
          config: { provider: 'liara', __action: 'summarize_report_orders' },
        },
        {
          id: 'email_1',
          defId: 'action_send_email',
          config: { to: '{{secrets.MANAGER_EMAIL}}', subject: 'Daily report' },
        },
      ],
      edges: [
        { from: 'cron_1', to: 'query_1' },
        { from: 'query_1', to: 'loop_1' },
        { from: 'loop_1', to: 'classify_1' },
        { from: 'classify_1', to: 'summary_1' },
        { from: 'summary_1', to: 'email_1' },
      ],
    };
    const r = pipeline(raw);
    expect(r.appliedTypes).toContain('force_loop_strategy_batch');
    expect(r.acceptable).toBe(true);
    const loopNode = r.fixed.nodes.find((n) => n.id === 'loop_1')!;
    expect(loopNode.config.strategy).toBe('batch');
  });
});

describe('Smoke E2E #4 — Multi-vendor parallel + flow_merge gia esplicito', () => {
  it('Workflow gia corretto → auto-fix non aggiunge merge duplicato (idempotenza)', () => {
    const raw: ScenarioWorkflow = {
      nodes: [
        { id: 'webhook_1', defId: 'trigger_webhook', config: {} },
        {
          id: 'stripe_1',
          defId: 'action_http',
          config: { url: 'https://api.stripe.com/v1/charges' },
        },
        {
          id: 'paypal_1',
          defId: 'action_http',
          config: { url: 'https://api.paypal.com/v1/payments' },
        },
        { id: 'merge_1', defId: 'flow_merge', config: { strategy: 'concat' } },
        {
          id: 'db_1',
          defId: 'db_insert',
          config: { databaseId: '__USE_PICKER__', table: 'payments' },
        },
      ],
      edges: [
        { from: 'webhook_1', to: 'stripe_1' },
        { from: 'webhook_1', to: 'paypal_1' },
        { from: 'stripe_1', to: 'merge_1' },
        { from: 'paypal_1', to: 'merge_1' },
        { from: 'merge_1', to: 'db_1' },
      ],
    };
    const r = pipeline(raw);
    expect(r.appliedTypes).not.toContain('fan_in_merge_inserted');
    expect(r.acceptable).toBe(true);
    expect(r.fixed.nodes.filter((n) => n.defId === 'flow_merge')).toHaveLength(1);
  });
});

describe('Smoke E2E #5 — File watch + classifier + 3 ramo logic_switch', () => {
  it('Switch con 3 cases + tutti con action terminale → accettato (no DEAD_END)', () => {
    const raw: ScenarioWorkflow = {
      nodes: [
        { id: 'watch_1', defId: 'trigger_file_watch', config: { path: '/inbox' } },
        { id: 'classify_1', defId: 'agent_classifier', config: { provider: 'liara' } },
        {
          id: 'switch_1',
          defId: 'logic_switch',
          config: {
            expression: '{{$node.classify_1.json.category}}',
            cases: [
              { key: 'invoice', label: 'Fatture' },
              { key: 'contract', label: 'Contratti' },
              { key: 'quote', label: 'Preventivi' },
            ],
            defaultCase: 'unknown',
          },
        },
        { id: 'erp_1', defId: 'action_http', config: { url: 'https://erp.internal/api/invoice' } },
        {
          id: 'legal_1',
          defId: 'action_http',
          config: { url: 'https://legal.internal/api/contract' },
        },
        { id: 'crm_1', defId: 'action_http', config: { url: 'https://crm.internal/api/quote' } },
        { id: 'manual_1', defId: 'community_slack', config: { channel: '#manual-review' } },
      ],
      edges: [
        { from: 'watch_1', to: 'classify_1' },
        { from: 'classify_1', to: 'switch_1' },
        { from: 'switch_1', to: 'erp_1', fromPort: 'invoice' },
        { from: 'switch_1', to: 'legal_1', fromPort: 'contract' },
        { from: 'switch_1', to: 'crm_1', fromPort: 'quote' },
        { from: 'switch_1', to: 'manual_1', fromPort: 'unknown' },
      ],
    };
    const r = pipeline(raw);
    expect(r.acceptable).toBe(true);
  });
});

describe('Smoke E2E #6 — Stripe webhook + validate + atomic DB insert', () => {
  it('Standard webhook→agent→db pipeline → no fix necessari', () => {
    const raw: ScenarioWorkflow = {
      nodes: [
        {
          id: 'wh_1',
          defId: 'trigger_webhook',
          config: { customPath: 'stripe', signSecret: '{{secrets.STRIPE_WEBHOOK_SECRET}}' },
        },
        { id: 'validate_1', defId: 'agent_validator', config: { provider: 'liara' } },
        {
          id: 'db_1',
          defId: 'db_insert',
          config: { databaseId: '__USE_PICKER__', table: 'stripe_events' },
        },
      ],
      edges: [
        { from: 'wh_1', to: 'validate_1' },
        { from: 'validate_1', to: 'db_1' },
      ],
    };
    const r = pipeline(raw);
    expect(r.acceptable).toBe(true);
  });
});

describe('Smoke E2E #7 — Duplicati nodi action_http per stesso URL', () => {
  it('3 nodi action_http identici → auto-fix merge_duplicate_nodes', () => {
    const sharedUrl = 'https://api.notion.com/v1/pages';
    const sharedConfig = { url: sharedUrl, method: 'POST' };
    const raw: ScenarioWorkflow = {
      nodes: [
        { id: 'wh_1', defId: 'trigger_webhook', config: {} },
        { id: 'a', defId: 'action_http', config: sharedConfig },
        { id: 'b', defId: 'action_http', config: sharedConfig },
        { id: 'c', defId: 'action_http', config: sharedConfig },
      ],
      edges: [
        { from: 'wh_1', to: 'a' },
        { from: 'wh_1', to: 'b' },
        { from: 'wh_1', to: 'c' },
      ],
    };
    const r = pipeline(raw);
    expect(r.appliedTypes).toContain('merge_duplicate_nodes');
    expect(r.fixed.nodes.filter((n) => n.defId === 'action_http')).toHaveLength(1);
  });
});

describe('Smoke E2E #8 — Agent con provider hallucinato openai', () => {
  it('LLM sceglie "openai" model + secrets template → normalize a tenant default + clear known-vendor model + clear apiKey template', () => {
    const raw: ScenarioWorkflow = {
      nodes: [
        { id: 'wh_1', defId: 'trigger_webhook', config: {} },
        {
          id: 'agent_1',
          defId: 'agent_extractor',
          config: { provider: 'openai', model: 'gpt-4o', apiKey: '{{secrets.OPENAI_API_KEY}}' },
        },
      ],
      edges: [{ from: 'wh_1', to: 'agent_1' }],
    };
    const rOverride = autoFixWorkflow({
      nodes: raw.nodes.map((n) => ({ ...n })),
      edges: raw.edges,
      tenantDefaultLlmProvider: 'anthropic',
    });
    const appliedOverride = Array.from(new Set(rOverride.appliedFixes.map((f) => f.type)));
    expect(appliedOverride).toContain('agent_provider_normalized');
    const agent = rOverride.nodes.find((n) => n.id === 'agent_1')!;
    expect(agent.config.provider).toBe('anthropic');
    expect(agent.config.model).toBeUndefined(); // gpt-4o matches KNOWN_MODEL_RE → cleared
    expect(agent.config.apiKey).toBeUndefined(); // {{secrets.X}} matches → cleared
  });

  it('apiKey custom (no template) NON viene cleared (lascia controllo all utente)', () => {
    const raw: ScenarioWorkflow = {
      nodes: [
        { id: 'wh_1', defId: 'trigger_webhook', config: {} },
        {
          id: 'agent_1',
          defId: 'agent_extractor',
          config: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-real-custom' },
        },
      ],
      edges: [{ from: 'wh_1', to: 'agent_1' }],
    };
    const r = autoFixWorkflow({
      nodes: raw.nodes.map((n) => ({ ...n })),
      edges: raw.edges,
      tenantDefaultLlmProvider: 'anthropic',
    });
    const agent = r.nodes.find((n) => n.id === 'agent_1')!;
    expect(agent.config.provider).toBe('anthropic'); // sempre normalizzato
    expect(agent.config.apiKey).toBe('sk-real-custom'); // preservato — by design
  });
});

describe('Smoke E2E #9 — Anti-fraud price monitoring (5 vendor parallelo, fan-in puro)', () => {
  it('Fan-in 5 vendor con HMAC sig direct → flow_merge auto + accettato', () => {
    // Pattern realistico: trigger ha già contesto (es. URL nel payload), non
    // c'è db_query intermedio. Per workflow con array-iteration serve
    // logic_loop (rule ARRAY_TO_SCALAR_WITHOUT_LOOP del quality-gate copre).
    const raw: ScenarioWorkflow = {
      nodes: [
        { id: 'cron_1', defId: 'trigger_cron', config: { cronExpression: '*/30 * * * *' } },
        {
          id: 'amazon_1',
          defId: 'action_http',
          config: { url: 'https://amazon.com/api/products' },
        },
        { id: 'ebay_1', defId: 'action_http', config: { url: 'https://ebay.com/api/products' } },
        {
          id: 'aliexpress_1',
          defId: 'action_http',
          config: { url: 'https://aliexpress.com/api/products' },
        },
        {
          id: 'shopify_1',
          defId: 'action_http',
          config: { url: 'https://shopify.com/api/products' },
        },
        {
          id: 'walmart_1',
          defId: 'action_http',
          config: { url: 'https://walmart.com/api/products' },
        },
        {
          id: 'log_1',
          defId: 'db_insert',
          config: { databaseId: '__USE_PICKER__', table: 'price_monitoring' },
        },
      ],
      edges: [
        { from: 'cron_1', to: 'amazon_1' },
        { from: 'cron_1', to: 'ebay_1' },
        { from: 'cron_1', to: 'aliexpress_1' },
        { from: 'cron_1', to: 'shopify_1' },
        { from: 'cron_1', to: 'walmart_1' },
        { from: 'amazon_1', to: 'log_1' },
        { from: 'ebay_1', to: 'log_1' },
        { from: 'aliexpress_1', to: 'log_1' },
        { from: 'shopify_1', to: 'log_1' },
        { from: 'walmart_1', to: 'log_1' },
      ],
    };
    const r = pipeline(raw);
    expect(r.appliedTypes).toContain('fan_in_merge_inserted');
    expect(r.acceptable).toBe(true);
    // Verifico merge ha 5 input. Il fan-in auto-fix ora inserisce `logic_merge`
    // (defId REALE; era 'flow_merge' phantom — fix 2026-06-10).
    const merge = r.fixed.nodes.find((n) => n.defId === 'logic_merge');
    expect(merge).toBeDefined();
    const toMerge = r.fixed.edges.filter((e) => e.to === merge!.id);
    expect(toMerge).toHaveLength(5);
  });
});

describe('Smoke E2E #10 — IMAP triage commercialista (Liara → email_triage → 9 categorie)', () => {
  it('agent_email_triage + logic_switch 9 cases tutti con action terminale', () => {
    const raw: ScenarioWorkflow = {
      nodes: [
        { id: 'imap_1', defId: 'trigger_imap', config: { folder: 'INBOX' } },
        {
          id: 'triage_1',
          defId: 'agent_email_triage_commercialista',
          config: { provider: 'liara' },
        },
        {
          id: 'switch_1',
          defId: 'logic_switch',
          config: {
            expression: '{{$node.triage_1.json.label}}',
            cases: [
              { key: 'fattura', label: 'Fattura' },
              { key: 'preventivo', label: 'Preventivo' },
              { key: 'rimborso', label: 'Rimborso' },
              { key: 'reminder', label: 'Reminder' },
              { key: 'errore', label: 'Errore' },
            ],
            defaultCase: 'altro',
          },
        },
        // 6 ramo terminali (5 cases + default)
        { id: 'odoo_invoice', defId: 'action_http', config: { url: 'https://odoo/api/invoice' } },
        { id: 'odoo_quote', defId: 'action_http', config: { url: 'https://odoo/api/quote' } },
        {
          id: 'refund_db',
          defId: 'db_insert',
          config: { databaseId: '__USE_PICKER__', table: 'refunds' },
        },
        { id: 'reminder_slack', defId: 'community_slack', config: { channel: '#reminders' } },
        {
          id: 'error_db',
          defId: 'db_insert',
          config: { databaseId: '__USE_PICKER__', table: 'errors' },
        },
        {
          id: 'manual_db',
          defId: 'db_insert',
          config: { databaseId: '__USE_PICKER__', table: 'manual_review' },
        },
      ],
      edges: [
        { from: 'imap_1', to: 'triage_1' },
        { from: 'triage_1', to: 'switch_1' },
        { from: 'switch_1', to: 'odoo_invoice', fromPort: 'fattura' },
        { from: 'switch_1', to: 'odoo_quote', fromPort: 'preventivo' },
        { from: 'switch_1', to: 'refund_db', fromPort: 'rimborso' },
        { from: 'switch_1', to: 'reminder_slack', fromPort: 'reminder' },
        { from: 'switch_1', to: 'error_db', fromPort: 'errore' },
        { from: 'switch_1', to: 'manual_db', fromPort: 'altro' },
      ],
    };
    const r = pipeline(raw);
    expect(r.acceptable).toBe(true);
  });
});

describe('Smoke E2E #11 — Workflow Stripe + Notion + Slack notify (4-layer pattern)', () => {
  it('Trigger→agent→switch→3 ramo terminali (no dead-end)', () => {
    const raw: ScenarioWorkflow = {
      nodes: [
        { id: 'wh_1', defId: 'trigger_webhook', config: { customPath: 'stripe' } },
        { id: 'classify_1', defId: 'agent_classifier', config: { provider: 'liara' } },
        {
          id: 'switch_1',
          defId: 'logic_switch',
          config: {
            expression: '{{$node.classify_1.json.type}}',
            cases: [
              { key: 'subscription_created', label: 'Sub Created' },
              { key: 'payment_failed', label: 'Failed' },
            ],
            defaultCase: 'other',
          },
        },
        { id: 'notion_1', defId: 'community_notion', config: { databaseId: '__USE_PICKER__' } },
        { id: 'slack_1', defId: 'community_slack', config: { channel: '#alerts' } },
        {
          id: 'db_1',
          defId: 'db_insert',
          config: { databaseId: '__USE_PICKER__', table: 'events' },
        },
      ],
      edges: [
        { from: 'wh_1', to: 'classify_1' },
        { from: 'classify_1', to: 'switch_1' },
        { from: 'switch_1', to: 'notion_1', fromPort: 'subscription_created' },
        { from: 'switch_1', to: 'slack_1', fromPort: 'payment_failed' },
        { from: 'switch_1', to: 'db_1', fromPort: 'other' },
      ],
    };
    const r = pipeline(raw);
    expect(r.acceptable).toBe(true);
  });
});

describe('Smoke E2E #12 — Compound: tutti i pattern bug LLM in unico workflow', () => {
  it('placeholder + fan-in + duplicati + obsolete model → auto-fix sistema TUTTO', () => {
    const raw: ScenarioWorkflow = {
      nodes: [
        { id: 'wh_1', defId: 'trigger_webhook', config: {} },
        {
          id: 'agent_1',
          defId: 'agent_extractor',
          config: { provider: 'openai', model: 'gpt-3.5-turbo-0613' },
        },
        {
          id: 'email_1',
          defId: 'action_send_email',
          config: {
            smtpHost: 'smtp.example.com',
            to: 'noreply@example.com',
          },
        },
        {
          id: 'http_a',
          defId: 'action_http',
          config: { url: 'https://api.same.com', method: 'POST' },
        },
        {
          id: 'http_b',
          defId: 'action_http',
          config: { url: 'https://api.same.com', method: 'POST' },
        },
        { id: 'db_1', defId: 'db_insert', config: { databaseId: '__USE_PICKER__', table: 'logs' } },
      ],
      edges: [
        { from: 'wh_1', to: 'agent_1' },
        { from: 'agent_1', to: 'email_1' },
        { from: 'agent_1', to: 'http_a' },
        { from: 'agent_1', to: 'http_b' },
        { from: 'http_a', to: 'db_1' },
        { from: 'http_b', to: 'db_1' },
        { from: 'email_1', to: 'db_1' },
      ],
    };
    const r = pipeline(raw);
    // Tutti i 4 fix attesi
    expect(r.appliedTypes).toContain('placeholder_to_secret');
    expect(r.appliedTypes).toContain('merge_duplicate_nodes');
    expect(r.appliedTypes).toContain('fan_in_merge_inserted');
    expect(r.appliedTypes).toContain('obsolete_model_cleared');
    // Workflow finale accettato
    expect(r.acceptable).toBe(true);
  });
});
