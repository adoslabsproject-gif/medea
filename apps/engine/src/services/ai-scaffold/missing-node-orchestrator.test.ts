/**
 * Missing-Node Wizard Orchestrator — smoke E2E.
 *
 * Verifica:
 *  - detectMissingDefIds isola ONLY i defId veramente sconosciuti
 *  - planSynthesis prepara prompt LLM con context corretto (upstream/downstream)
 *  - executeSynthesisPlan invoca deps con fail-soft per-item
 *  - applyDefIdMapping riscrive defId senza toccare edges/config
 *  - idempotenza: defId già synth'd viene riusato (no doppio LLM call)
 *  - edge case: trigger_/community_ esclusi a priori (non sintetizzabili)
 */
import { describe, it, expect, vi } from 'vitest';
import {
  detectMissingDefIds,
  planSynthesis,
  executeSynthesisPlan,
  applyDefIdMapping,
  deriveSlugFromDefId,
  deriveDisplayName,
  type Workflow,
  type OrchestratorDeps,
  type SynthesisPlan,
} from './missing-node-orchestrator.js';

const KNOWN = new Set([
  'action_http', 'action_send_email', 'agent_summarizer',
  'logic_loop', 'flow_merge', 'db_query',
]);
const KNOWN_CUSTOM = new Set(['custom_legacy-scraper']);

describe('detectMissingDefIds', () => {
  it('rileva defId fuori dal catalog escludendo stdlib e custom esistenti', () => {
    const wf: Workflow = {
      nodes: [
        { id: 'n1', defId: 'action_http', config: {} },                 // known stdlib
        { id: 'n2', defId: 'custom_legacy-scraper', config: {} },       // known custom
        { id: 'n3', defId: 'action_amazon_search', config: { query: 'x' } }, // MISSING
        { id: 'n4', defId: 'action_amazon_search', config: { query: 'y' } }, // dup, raises count
        { id: 'n5', defId: 'integration_shopify_orders', config: {} },  // MISSING
      ],
      edges: [],
    };
    const missing = detectMissingDefIds(wf, KNOWN, KNOWN_CUSTOM);
    expect(missing.map((m) => m.defId)).toEqual(['action_amazon_search', 'integration_shopify_orders']);
    expect(missing[0]!.usageCount).toBe(2);
    expect(missing[0]!.nodeIds).toEqual(['n3', 'n4']);
    expect(missing[0]!.observedConfigs).toHaveLength(2);
  });

  it('escludi community_/trigger_ a priori (non si sintetizzano)', () => {
    const wf: Workflow = {
      nodes: [
        { id: 'n1', defId: 'community_acme_widget', config: {} },
        { id: 'n2', defId: 'trigger_webhook_custom', config: {} },
      ],
      edges: [],
    };
    expect(detectMissingDefIds(wf, KNOWN, KNOWN_CUSTOM)).toEqual([]);
  });

  it('escludi defId che findBaseDefId risolve (auto-fix-defid lo gestisce dopo)', () => {
    // "action_http_clearbit" → strip suffix → "action_http" exists.
    const wf: Workflow = {
      nodes: [
        { id: 'n1', defId: 'action_http_clearbit', config: {} },
      ],
      edges: [],
    };
    expect(detectMissingDefIds(wf, KNOWN, KNOWN_CUSTOM)).toEqual([]);
  });
});

describe('deriveSlug/DisplayName', () => {
  it('strip prefisso categoria + kebab', () => {
    expect(deriveSlugFromDefId('action_amazon_search')).toBe('amazon-search');
    expect(deriveSlugFromDefId('agent_email_triage_legal')).toBe('email-triage-legal');
    expect(deriveSlugFromDefId('integration_shopify_orders')).toBe('shopify-orders');
  });

  it('displayName titlecase', () => {
    expect(deriveDisplayName('action_amazon_search')).toBe('Amazon Search');
    expect(deriveDisplayName('agent_email_triage_legal')).toBe('Email Triage Legal');
  });
});

describe('planSynthesis', () => {
  it('prepara prompt LLM con userPrompt + observed schema + upstream/downstream', () => {
    const wf: Workflow = {
      nodes: [
        { id: 'http_in', defId: 'action_http', config: {} },
        { id: 'amz1', defId: 'action_amazon_search', config: { query: 'iphone', region: 'IT' } },
        { id: 'merge', defId: 'flow_merge', config: {} },
      ],
      edges: [
        { from: 'http_in', to: 'amz1' },
        { from: 'amz1', to: 'merge' },
      ],
    };
    const missing = detectMissingDefIds(wf, KNOWN, KNOWN_CUSTOM);
    const plan = planSynthesis(missing, {
      userPrompt: 'Trova best price iPhone in IT su Amazon',
      contextNodes: wf.nodes,
      contextEdges: wf.edges,
    });
    expect(plan.items).toHaveLength(1);
    const item = plan.items[0]!;
    expect(item.targetDefId).toBe('custom_amazon-search');
    expect(item.proposedSlug).toBe('amazon-search');
    expect(item.proposedDisplayName).toBe('Amazon Search');
    expect(item.llmPrompt).toContain('Trova best price iPhone in IT');
    expect(item.llmPrompt).toContain('upstream=[action_http]');
    expect(item.llmPrompt).toContain('downstream=[flow_merge]');
    expect(item.llmPrompt).toContain('query, region');
    expect(plan.skipped).toEqual([]);
  });
});

describe('executeSynthesisPlan', () => {
  it('invoca deps con success → mapping popolato', async () => {
    const plan: SynthesisPlan = {
      items: [{
        missing: { defId: 'action_amazon_search', usageCount: 1, nodeIds: ['n1'], observedConfigs: [{}] },
        proposedSlug: 'amazon-search',
        targetDefId: 'custom_amazon-search',
        proposedDisplayName: 'Amazon Search',
        llmPrompt: 'fake prompt',
      }],
      skipped: [],
    };
    const findExisting = vi.fn().mockResolvedValue(null);
    const generate = vi.fn().mockResolvedValue({
      sourceExecutor: 'export const executor = async () => ({ output: {}, durationMs: 0 });',
      sourceDefinition: '{"id":"custom_amazon-search","label":"Amazon Search"}',
      sourceSchema: '{"type":"object"}',
    });
    const persist = vi.fn().mockResolvedValue({
      defId: 'custom_amazon-search',
      customNodeId: 'cn-1',
      semver: '0.1.0',
    });
    const deps: OrchestratorDeps = {
      findExistingCustomDefId: findExisting,
      generateNodeBlueprint: generate,
      persistAndPublish: persist,
    };
    const result = await executeSynthesisPlan(plan, deps, { workspaceId: 'ws1', ownerUserId: 'u1' });

    expect(result.succeeded).toHaveLength(1);
    expect(result.succeeded[0]!.reused).toBe(false);
    expect(result.mapping.get('action_amazon_search')).toBe('custom_amazon-search');
    expect(generate).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
  });

  it('idempotenza: slug già esistente → riuso (zero LLM/persist calls)', async () => {
    const plan: SynthesisPlan = {
      items: [{
        missing: { defId: 'action_amazon_search', usageCount: 1, nodeIds: ['n1'], observedConfigs: [{}] },
        proposedSlug: 'amazon-search',
        targetDefId: 'custom_amazon-search',
        proposedDisplayName: 'Amazon Search',
        llmPrompt: 'fake',
      }],
      skipped: [],
    };
    const findExisting = vi.fn().mockResolvedValue('custom_amazon-search');
    const generate = vi.fn();
    const persist = vi.fn();
    const result = await executeSynthesisPlan(plan, {
      findExistingCustomDefId: findExisting,
      generateNodeBlueprint: generate,
      persistAndPublish: persist,
    }, { workspaceId: 'ws1', ownerUserId: 'u1' });

    expect(result.succeeded[0]!.reused).toBe(true);
    expect(result.mapping.get('action_amazon_search')).toBe('custom_amazon-search');
    expect(generate).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('fail-soft: LLM fail su item 1 → item 2 proseguito', async () => {
    const plan: SynthesisPlan = {
      items: [
        {
          missing: { defId: 'action_alpha', usageCount: 1, nodeIds: ['n1'], observedConfigs: [{}] },
          proposedSlug: 'alpha', targetDefId: 'custom_alpha', proposedDisplayName: 'Alpha', llmPrompt: '',
        },
        {
          missing: { defId: 'action_beta', usageCount: 1, nodeIds: ['n2'], observedConfigs: [{}] },
          proposedSlug: 'beta', targetDefId: 'custom_beta', proposedDisplayName: 'Beta', llmPrompt: '',
        },
      ],
      skipped: [],
    };
    let call = 0;
    const generate = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new Error('LLM 503 backend overloaded');
      return { sourceExecutor: 'x', sourceDefinition: 'y', sourceSchema: 'z' };
    });
    const persist = vi.fn().mockResolvedValue({ defId: 'custom_beta', customNodeId: 'cn-2', semver: '0.1.0' });

    const result = await executeSynthesisPlan(plan, {
      findExistingCustomDefId: vi.fn().mockResolvedValue(null),
      generateNodeBlueprint: generate,
      persistAndPublish: persist,
    }, { workspaceId: 'ws1', ownerUserId: 'u1' });

    expect(result.succeeded).toHaveLength(1);
    expect(result.succeeded[0]!.oldDefId).toBe('action_beta');
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.oldDefId).toBe('action_alpha');
    expect(result.failed[0]!.reason).toContain('503');
  });
});

describe('applyDefIdMapping', () => {
  it('riscrive solo defId mappati, edges e config invariati', () => {
    const wf: Workflow = {
      nodes: [
        { id: 'n1', defId: 'action_amazon_search', config: { query: 'x' } },
        { id: 'n2', defId: 'action_http', config: { url: 'https://y.com' } },
      ],
      edges: [{ from: 'n1', to: 'n2', port: 'out' }],
    };
    const mapping = new Map([['action_amazon_search', 'custom_amazon-search']]);
    const out = applyDefIdMapping(wf, mapping);
    expect(out.nodes[0]!.defId).toBe('custom_amazon-search');
    expect(out.nodes[0]!.config).toEqual({ query: 'x' });
    expect(out.nodes[1]!.defId).toBe('action_http');
    expect(out.edges).toEqual([{ from: 'n1', to: 'n2', port: 'out' }]);
    // Defensive copy: modifying out non muta wf
    (out.nodes[0]!.config as Record<string, unknown>).query = 'mutated';
    expect((wf.nodes[0]!.config as Record<string, unknown>).query).toBe('x');
  });

  it('idempotente: doppio apply == single apply', () => {
    const wf: Workflow = {
      nodes: [{ id: 'n1', defId: 'action_amazon_search', config: {} }],
      edges: [],
    };
    const mapping = new Map([['action_amazon_search', 'custom_amazon-search']]);
    const once = applyDefIdMapping(wf, mapping);
    const twice = applyDefIdMapping(once, mapping);
    expect(twice.nodes[0]!.defId).toBe('custom_amazon-search');
  });
});
