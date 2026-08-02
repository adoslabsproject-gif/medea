/**
 * Bug-bounty test — node-aliases (vocabolario n8n + generici → defId FlowForge).
 *
 * Obiettivo: un migrante n8n deve ottenere il nodo giusto comunque scriva il nome.
 * I test cercano i bug VERI di questa classe:
 *   - invarianza di formato (case/underscore/spazi/prefisso n8n) — il punto chiave;
 *   - mapping semantici corretti (Function = CODE, non Set; Filter = IF);
 *   - default "code node" → JavaScript;
 *   - CONTRATTO col catalog reale: ogni target alias DEVE esistere (anti-fantasma:
 *     beccherebbe community_stripe/ai_openai inesistenti);
 *   - fallback dei tipi senza equivalente → action_http reale, mai defId fantasma.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveNodeAlias,
  n8nTypeToDefId,
  normalizeAliasKey,
  aliasTargets,
} from './node-aliases.js';
import { ALL_NODE_MODULES } from '@/engine/workflow-engine.js';

describe('normalizeAliasKey — collassa i formati', () => {
  it.each([
    ['HTTP Request', 'httprequest'],
    ['httpRequest', 'httprequest'],
    ['http_request', 'httprequest'],
    ['  HTTPREQUEST  ', 'httprequest'],
    ['n8n-nodes-base.httpRequest', 'httprequest'],
    ['@n8n/n8n-nodes-langchain.openAi', 'openai'],
    ['Split In Batches', 'splitinbatches'],
  ])('"%s" → "%s"', (input, expected) => {
    expect(normalizeAliasKey(input)).toBe(expected);
  });
});

describe('resolveNodeAlias — invarianza di formato (lo stesso nodo comunque scritto)', () => {
  // Un utente può digitare il nome in 5 modi diversi: TUTTI devono risolvere uguale.
  it.each([
    'HTTP Request',
    'httpRequest',
    'http_request',
    'HTTPREQUEST',
    'n8n-nodes-base.httpRequest',
  ])('"%s" → action_http', (term) => {
    expect(resolveNodeAlias(term)).toBe('action_http');
  });
});

describe('resolveNodeAlias — nomi n8n → defId FlowForge', () => {
  it.each([
    // trigger
    ['n8n-nodes-base.scheduleTrigger', 'trigger_cron'],
    ['n8n-nodes-base.cron', 'trigger_cron'],
    ['n8n-nodes-base.webhook', 'trigger_webhook'],
    ['n8n-nodes-base.manualTrigger', 'trigger_manual'],
    ['n8n-nodes-base.formTrigger', 'trigger_form'],
    // logic
    ['n8n-nodes-base.set', 'logic_transform'],
    ['n8n-nodes-base.if', 'logic_if'],
    ['n8n-nodes-base.switch', 'logic_switch'],
    ['n8n-nodes-base.merge', 'logic_merge'],
    ['n8n-nodes-base.wait', 'logic_wait'],
    ['n8n-nodes-base.splitInBatches', 'logic_loop'],
    // action
    ['n8n-nodes-base.emailSend', 'action_send_email'],
    ['n8n-nodes-base.gmail', 'action_send_email'],
    // community
    ['n8n-nodes-base.slack', 'community_slack'],
    ['n8n-nodes-base.telegram', 'community_telegram'],
  ])('%s → %s', (n8nType, defId) => {
    expect(resolveNodeAlias(n8nType)).toBe(defId);
  });
});

describe('resolveNodeAlias — semantica corretta (i tranelli)', () => {
  it('Function/Function Item = CODE (action_run_js), NON Set/logic_transform', () => {
    // n8n Function esegue JS che ritorna item → è un code node, non un mapper.
    expect(resolveNodeAlias('function')).toBe('action_run_js');
    expect(resolveNodeAlias('functionItem')).toBe('action_run_js');
    expect(resolveNodeAlias('n8n-nodes-base.function')).toBe('action_run_js');
  });

  it('Set/Edit Fields = logic_transform (mapper), NON code', () => {
    expect(resolveNodeAlias('set')).toBe('logic_transform');
    expect(resolveNodeAlias('Edit Fields')).toBe('logic_transform');
  });

  it('Filter → logic_if (non esiste logic_filter: si usa IF)', () => {
    expect(resolveNodeAlias('filter')).toBe('logic_if');
  });

  it('"code node" generico → action_run_js (DEFAULT JS, come n8n)', () => {
    expect(resolveNodeAlias('code')).toBe('action_run_js');
    expect(resolveNodeAlias('code node')).toBe('action_run_js');
    expect(resolveNodeAlias('javascript')).toBe('action_run_js');
  });

  it('Python esplicito → action_run_python', () => {
    expect(resolveNodeAlias('python')).toBe('action_run_python');
    expect(resolveNodeAlias('run python')).toBe('action_run_python');
  });
});

describe('resolveNodeAlias — termine sconosciuto → undefined (il chiamante sceglie)', () => {
  it.each(['quantum_teleporter', 'foobar', 'n8n-nodes-base.salesforce', ''])(
    '"%s" → undefined',
    (term) => {
      expect(resolveNodeAlias(term)).toBeUndefined();
    },
  );
});

describe('AI: openai/anthropic → nodo LLM REALE (non fallback HTTP)', () => {
  it('OpenAI/Anthropic → action_llm_complete (nodo LLM vero, prompt→completion)', () => {
    expect(resolveNodeAlias('@n8n/n8n-nodes-langchain.openAi')).toBe('action_llm_complete');
    expect(resolveNodeAlias('@n8n/n8n-nodes-langchain.anthropic')).toBe('action_llm_complete');
    expect(n8nTypeToDefId('@n8n/n8n-nodes-langchain.openAi')).toBe('action_llm_complete');
  });
});

describe('n8nTypeToDefId — fallback SOLO per integrazioni inesistenti (no defId fantasma)', () => {
  it('tipi senza nodo FlowForge reale (stripe/salesforce) → action_http, MAI fantasma', () => {
    // Onestà: questi nodi NON esistono ancora in FlowForge. Il fallback action_http
    // (call API via HTTP) è la verità + l'import lo segnala nel warning unmappedTypes.
    // Bug latente chiuso: la vecchia mappa puntava a community_stripe INESISTENTE.
    expect(n8nTypeToDefId('n8n-nodes-base.stripe')).toBe('action_http');
    expect(n8nTypeToDefId('n8n-nodes-base.salesforce')).toBe('action_http');
  });

  it('fallback custom rispettato', () => {
    expect(n8nTypeToDefId('n8n-nodes-base.unknownXYZ', 'logic_transform')).toBe('logic_transform');
  });

  it('tipo mappato NON usa il fallback', () => {
    expect(n8nTypeToDefId('n8n-nodes-base.webhook')).toBe('trigger_webhook');
  });
});

describe('🚨 CONTRATTO: ogni target alias ESISTE nel catalog runtime reale', () => {
  // È il test che becca la classe di bug "alias → defId fantasma" (community_stripe,
  // ai_openai erano fantasmi). Tirato dal catalog REALE (ALL_NODE_MODULES), così se
  // un defId viene rinominato/rimosso o un alias punta a un id inesistente → ROSSO.
  const catalog = new Set(ALL_NODE_MODULES.map((m) => m.def.id));

  it('il catalog reale non è vuoto (sanity)', () => {
    expect(catalog.size).toBeGreaterThan(20);
  });

  it.each([...aliasTargets()])('target "%s" è nel catalog', (target) => {
    expect(catalog.has(target)).toBe(true);
  });
});
