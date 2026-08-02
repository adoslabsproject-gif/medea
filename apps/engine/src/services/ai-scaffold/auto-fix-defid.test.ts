/**
 * Tests 2026-grade per auto-fix-defid (rimap suffix inventato → base catalog).
 *
 * Origine bug: 2026-05-31, user CRM enrichment prompt → 5 defId inventati:
 *   action_json_extract_sender, action_json_extract_domain,
 *   action_http_clearbit, action_http_hunter, action_web_fetch_homepage.
 */
import { describe, it, expect } from 'vitest';
import { findBaseDefId, autoFixInventedDefIds } from './auto-fix-defid.js';

const CATALOG = new Set<string>([
  'trigger_imap',
  'trigger_webhook',
  'trigger_cron',
  'action_http',
  'action_json_extract',
  'action_fetch_url',
  'action_web_fetch_advanced',
  'action_send_email',
  'agent_extractor',
  'agent_translator',
  'agent_data_analyst',
  'logic_if',
  'logic_switch',
  'logic_loop',
  'db_query',
  'community_telegram',
  'community_slack',
  'community_hubspot',
]);

describe('findBaseDefId — strip suffix progressivo', () => {
  it('defId esiste già in catalog → ritorna se stesso (no strip)', () => {
    expect(findBaseDefId('action_http', CATALOG)).toBe('action_http');
    expect(findBaseDefId('trigger_imap', CATALOG)).toBe('trigger_imap');
  });

  it('action_http_clearbit → action_http (strip 1 part)', () => {
    expect(findBaseDefId('action_http_clearbit', CATALOG)).toBe('action_http');
  });

  it('action_http_hunter → action_http', () => {
    expect(findBaseDefId('action_http_hunter', CATALOG)).toBe('action_http');
  });

  it('action_json_extract_sender → action_json_extract', () => {
    expect(findBaseDefId('action_json_extract_sender', CATALOG)).toBe('action_json_extract');
  });

  it('action_json_extract_domain → action_json_extract', () => {
    expect(findBaseDefId('action_json_extract_domain', CATALOG)).toBe('action_json_extract');
  });

  it('action_web_fetch_homepage → action_web_fetch (NO, base non esiste) → null (no fallback fuzzy)', () => {
    // Volutamente NO: rimappiamo solo a base ESATTAMENTE in catalog.
    // Per "homepage" l'AI dovrebbe usare action_fetch_url o action_web_fetch_advanced,
    // ma la rimap NON deve guessare quale (rischio cambio semantica).
    expect(findBaseDefId('action_web_fetch_homepage', CATALOG)).toBeNull();
  });

  it('action_web_fetch_advanced_extra → action_web_fetch_advanced', () => {
    expect(findBaseDefId('action_web_fetch_advanced_extra', CATALOG)).toBe(
      'action_web_fetch_advanced',
    );
  });

  it('action_fetch_url_homepage → action_fetch_url', () => {
    expect(findBaseDefId('action_fetch_url_homepage', CATALOG)).toBe('action_fetch_url');
  });

  it("community_<vendor> SKIPPED — vendor è parte dell'identità (no strip)", () => {
    expect(findBaseDefId('community_unknown_vendor', CATALOG)).toBeNull();
    expect(findBaseDefId('community_telegram_send', CATALOG)).toBeNull();
  });

  it('trigger_<X> SKIPPED — ogni trigger è atomico', () => {
    expect(findBaseDefId('trigger_imap_advanced', CATALOG)).toBeNull();
    expect(findBaseDefId('trigger_webhook_v2', CATALOG)).toBeNull();
  });

  it('strip non riduce a < 2 parts (no "action" puro)', () => {
    // "action_foo_bar" → prova "action_foo" → no → prova "action" (1 part, < MIN_PARTS=2) → STOP
    expect(findBaseDefId('action_foo_bar', CATALOG)).toBeNull();
  });

  it('defId completamente inventato senza base → null', () => {
    expect(findBaseDefId('totally_made_up_thing', CATALOG)).toBeNull();
  });
});

describe('autoFixInventedDefIds — integrazione su multiple nodi', () => {
  it('applica rimap su 4 nodi del bug user 2026-05-31 (sender/domain/clearbit/hunter)', () => {
    const r = autoFixInventedDefIds(
      {
        nodes: [
          { id: 'n1', defId: 'trigger_imap', config: {} },
          { id: 'n2', defId: 'action_json_extract_sender', config: { jsonPath: '$.from' } },
          { id: 'n3', defId: 'action_json_extract_domain', config: { jsonPath: '$.domain' } },
          { id: 'n4', defId: 'action_http_clearbit', config: { url: 'https://clearbit.com' } },
          { id: 'n5', defId: 'action_http_hunter', config: { url: 'https://hunter.io' } },
        ],
      },
      CATALOG,
    );
    expect(r.appliedFixes).toHaveLength(4);
    expect(r.nodes.find((n) => n.id === 'n2')?.defId).toBe('action_json_extract');
    expect(r.nodes.find((n) => n.id === 'n3')?.defId).toBe('action_json_extract');
    expect(r.nodes.find((n) => n.id === 'n4')?.defId).toBe('action_http');
    expect(r.nodes.find((n) => n.id === 'n5')?.defId).toBe('action_http');
    // trigger_imap non toccato (era valido)
    expect(r.nodes.find((n) => n.id === 'n1')?.defId).toBe('trigger_imap');
  });

  it('preserva config originale durante rimap (URL Clearbit non perso)', () => {
    const r = autoFixInventedDefIds(
      {
        nodes: [
          {
            id: 'n1',
            defId: 'action_http_clearbit',
            config: { url: 'https://clearbit.com/v2/companies/find', method: 'GET' },
          },
        ],
      },
      CATALOG,
    );
    const fixed = r.nodes[0];
    if (!fixed) throw new Error('node missing');
    expect(fixed.defId).toBe('action_http');
    expect(fixed.config.url).toBe('https://clearbit.com/v2/companies/find');
    expect(fixed.config.method).toBe('GET');
  });

  it('non muta input originale (deep clone)', () => {
    const input = {
      nodes: [{ id: 'n1', defId: 'action_http_clearbit', config: { url: 'x' } }],
    };
    autoFixInventedDefIds(input, CATALOG);
    expect(input.nodes[0]?.defId).toBe('action_http_clearbit');
  });

  it('idempotente: 2x giri = stesso output', () => {
    const r1 = autoFixInventedDefIds(
      { nodes: [{ id: 'n1', defId: 'action_http_clearbit', config: {} }] },
      CATALOG,
    );
    const r2 = autoFixInventedDefIds({ nodes: r1.nodes }, CATALOG);
    expect(r2.appliedFixes).toHaveLength(0);
    expect(r2.nodes[0]?.defId).toBe('action_http');
  });

  it('appliedFixes ha before/after corretti per telemetry', () => {
    const r = autoFixInventedDefIds(
      { nodes: [{ id: 'extract_sender', defId: 'action_json_extract_sender', config: {} }] },
      CATALOG,
    );
    expect(r.appliedFixes[0]).toMatchObject({
      nodeId: 'extract_sender',
      before: 'action_json_extract_sender',
      after: 'action_json_extract',
    });
    expect(r.appliedFixes[0]?.detail).toContain('preservata nel config');
  });

  it('NON rimappa community_<vendor> anche se vendor inventato', () => {
    // community_unknownvendor → catalog non lo conosce. Liara doveva
    // verificare prima con list_node_catalog. Auto-fix NON tenta strip
    // (vendor=identità). Il workflow fallirà la validation con messaggio
    // esplicito → Liara riceve feedback e retry con community_X valido.
    const r = autoFixInventedDefIds(
      { nodes: [{ id: 'n1', defId: 'community_unknownvendor', config: {} }] },
      CATALOG,
    );
    expect(r.appliedFixes).toHaveLength(0);
    expect(r.nodes[0]?.defId).toBe('community_unknownvendor');
  });

  it('lascia nodi valid intatti (zero fixes se tutto OK)', () => {
    const r = autoFixInventedDefIds(
      {
        nodes: [
          { id: 'n1', defId: 'trigger_imap', config: {} },
          { id: 'n2', defId: 'action_http', config: { url: 'x' } },
          { id: 'n3', defId: 'community_telegram', config: { action: 'send_message' } },
        ],
      },
      CATALOG,
    );
    expect(r.appliedFixes).toHaveLength(0);
  });
});

describe('🔒 alias flow_merge → logic_merge (vocabolario scaffold → defId runtime)', () => {
  const KNOWN = new Set(['logic_merge', 'action_http', 'logic_loop']);

  it('findBaseDefId("flow_merge") → "logic_merge" (alias, non null)', () => {
    expect(findBaseDefId('flow_merge', KNOWN)).toBe('logic_merge');
  });

  it('alias NON applicato se il target non è nel catalog (no falso mapping)', () => {
    expect(findBaseDefId('flow_merge', new Set(['action_http']))).toBeNull();
  });

  it('autoFixInventedDefIds rimappa un nodo flow_merge → logic_merge', () => {
    const r = autoFixInventedDefIds(
      {
        nodes: [{ id: 'm', defId: 'flow_merge', config: { strategy: 'concat' } }],
      },
      KNOWN,
    );
    expect(r.nodes[0]!.defId).toBe('logic_merge');
    expect(r.appliedFixes[0]!.before).toBe('flow_merge');
    expect(r.appliedFixes[0]!.after).toBe('logic_merge');
  });
});

describe('🔌 alias n8n / nomi generici → defId FlowForge (migrante n8n)', () => {
  const CAT = new Set([
    'action_run_js',
    'action_run_python',
    'action_http',
    'logic_transform',
    'logic_if',
    'logic_merge',
    'trigger_webhook',
  ]);

  it.each([
    ['code', 'action_run_js'],
    ['function', 'action_run_js'], // Function n8n = CODE, non Set
    ['python', 'action_run_python'],
    ['httpRequest', 'action_http'],
    ['HTTP Request', 'action_http'], // con spazio (normalizzato)
    ['n8n-nodes-base.set', 'logic_transform'],
    ['set', 'logic_transform'],
    ['if', 'logic_if'],
    ['filter', 'logic_if'],
    ['merge', 'logic_merge'],
    ['n8n-nodes-base.webhook', 'trigger_webhook'],
  ])('findBaseDefId("%s") → "%s"', (input, expected) => {
    expect(findBaseDefId(input, CAT)).toBe(expected);
  });

  it('autoFixInventedDefIds normalizza un nodo "code" emesso da Liara → action_run_js', () => {
    const r = autoFixInventedDefIds(
      {
        nodes: [{ id: 'c', defId: 'code', config: { code: 'return 1' } }],
      },
      CAT,
    );
    expect(r.nodes[0]!.defId).toBe('action_run_js');
    expect(r.appliedFixes[0]).toMatchObject({ before: 'code', after: 'action_run_js' });
  });

  it('un defId REALE non viene toccato (no falso mapping su nodi validi)', () => {
    const r = autoFixInventedDefIds(
      {
        nodes: [{ id: 'x', defId: 'action_http', config: {} }],
      },
      CAT,
    );
    expect(r.appliedFixes).toHaveLength(0);
    expect(r.nodes[0]!.defId).toBe('action_http');
  });

  it('DIFENSIVO: alias n8n NON applicato se il target manca dal catalog', () => {
    expect(findBaseDefId('code', new Set(['action_http']))).toBeNull();
  });
});
