import { describe, it, expect } from 'vitest';
import { NodeDefSchema } from '@medea/engine-core-schema';
import { aiAgentNodes, AI_AGENT_DEFINITIONS, internalGatewayTrustedHost } from './index.js';

describe('aiAgentNodes', () => {
  it('ships ogni agent specializzato + esattamente 1 generic tool-loop', () => {
    // INVARIANTE STRUTTURALE (resiliente a nuovi agent): il conteggio hardcoded
    // si è rotto 3 volte all'aggiunta di agent. Asserisco la RELAZIONE, non il
    // numero magico — ogni def specializzata in AI_AGENT_DEFINITIONS è spedita
    // come nodo, più esattamente 1 agent_tool_loop generico (ReAct multi-step).
    expect(AI_AGENT_DEFINITIONS.length).toBeGreaterThanOrEqual(8); // sanity: registry non vuoto
    expect(aiAgentNodes).toHaveLength(AI_AGENT_DEFINITIONS.length + 1);
    const specializedIds = new Set(AI_AGENT_DEFINITIONS.map((a) => a.id));
    const generic = aiAgentNodes.filter((n) => !specializedIds.has(n.def.id));
    expect(generic).toHaveLength(1);
    expect(generic[0]?.def.id).toBe('ai_agent_tool_loop');
  });

  it('every node validates as NodeDef', () => {
    for (const node of aiAgentNodes) {
      const result = NodeDefSchema.safeParse(node.def);
      if (!result.success) throw new Error(`${node.def.id}: ${result.error.message}`);
      expect(result.success).toBe(true);
    }
  });

  it('every specialized agent id is prefixed `agent_`', () => {
    // Il tool-loop generico ha prefisso `ai_agent_tool_loop` — testiamo solo
    // gli agent specializzati da AI_AGENT_DEFINITIONS.
    for (const def of AI_AGENT_DEFINITIONS) {
      expect(def.id.startsWith('agent_')).toBe(true);
    }
  });

  it('every node has a runnable executor', () => {
    for (const node of aiAgentNodes) {
      expect(typeof node.executor).toBe('function');
    }
  });

  it('every specialized agent has a system prompt (not exposed to user)', () => {
    for (const def of AI_AGENT_DEFINITIONS) {
      expect(def.systemPrompt.length).toBeGreaterThan(50);
    }
  });

  it('JSON-output agents declare outputFormat=json', () => {
    const jsonAgents = AI_AGENT_DEFINITIONS.filter((a) => a.outputFormat === 'json');
    expect(jsonAgents.length).toBeGreaterThan(5);
  });

  it('every specialized agent has a "provider" select field', () => {
    // Il tool-loop ha config field set diverso (model + tools), no provider
    // top-level. Testiamo solo gli specialized.
    const specializedIds = new Set(AI_AGENT_DEFINITIONS.map((a) => a.id));
    const specializedNodes = aiAgentNodes.filter((n) => specializedIds.has(n.def.id));
    expect(specializedNodes).toHaveLength(AI_AGENT_DEFINITIONS.length);
    for (const node of specializedNodes) {
      const provider = node.def.configFields?.find((f) => f.key === 'provider');
      expect(provider?.type).toBe('select');
      expect(provider?.options).toContain('anthropic');
      expect(provider?.options).toContain('openai');
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // A3.3 stabilization contract (2026-06-05) — agent nodes portati a STABLE.
  // Contratto: description ≥150 char, IT first sentence, use case enumerato.
  // ────────────────────────────────────────────────────────────────────────
  describe('A3.3 stabilized agent contract', () => {
    const A33_STABILIZED_AGENT_IDS = [
      'agent_summarizer',
      'agent_translator',
      'agent_classifier',
      'agent_extractor',
      'agent_intent_router',
      'agent_security_audit',
      'agent_code_reviewer',
      'agent_data_analyst',
    ] as const;

    it('every A3.3 stabilized agent has description ≥150 char + ≥25 distinct words + IT + Use case (anti-gaming)', () => {
      const englishVerbs = /^(Run|Send|Trigger|Execute|Read|Write|Get|Update|Delete|Create|Fetch|Query|Pause|Reshape|Call|Catch|Invoke|Push|Pull|Poll|Auto|Watch|Make|Build|Sleep|Wait|Receive|Calculate|Connect|Insert|Iterate|Iterates|Schedule|Subscribe|Classify|Extract|Translate|Faithful|Produce|Generate)\b/;
      const offenders: string[] = [];
      for (const id of A33_STABILIZED_AGENT_IDS) {
        const def = AI_AGENT_DEFINITIONS.find((d) => d.id === id);
        if (!def) {
          offenders.push(`${id}: NOT FOUND in AI_AGENT_DEFINITIONS`);
          continue;
        }
        const desc = def.description;
        if (desc.length < 150) {
          offenders.push(`${id}: desc length ${String(desc.length)} < 150`);
        }
        if (englishVerbs.test(desc)) {
          offenders.push(`${id}: starts with English verb "${desc.slice(0, 40)}…"`);
        }
        const distinctWords = new Set(desc.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
        if (distinctWords.size < 25) {
          offenders.push(`${id}: only ${String(distinctWords.size)} distinct words (<25 = gameable)`);
        }
        if (!/use case/i.test(desc)) {
          offenders.push(`${id}: missing "use case" enumeration`);
        }
      }
      if (offenders.length > 0) {
        throw new Error(`A3.3 agent contract violations:\n${offenders.join('\n')}`);
      }
      expect(offenders).toHaveLength(0);
    });
  });
});

describe('internalGatewayTrustedHost — esenzione SSRF per il gateway interno (fix nLA_liara)', () => {
  const GW = 'http://172.20.0.1:3006';

  it('🚨 baseUrl del gateway passato ESPLICITAMENTE (caso reale: runtime → context.llmProviders) → esente', () => {
    // Questo è il bug che bloccava nLA_liara: il runtime passa baseUrl=liaraBaseUrl().
    const url = 'http://172.20.0.1:3006/v1/chat/completions';
    expect(internalGatewayTrustedHost(url, GW)).toBe('172.20.0.1:3006');
  });

  it('default di sistema (stesso origin del gateway) → esente', () => {
    expect(internalGatewayTrustedHost(`${GW}/v1/chat/completions`, GW)).toBe('172.20.0.1:3006');
  });

  it('🚨 MUTATION: BYOK con origin DIVERSO (api.openai.com) → undefined (guard pieno, niente esenzione)', () => {
    expect(internalGatewayTrustedHost('https://api.openai.com/v1/chat/completions', GW)).toBeUndefined();
  });

  it('🚨 porta diversa = origin diverso → undefined (non apre 172.20.0.1 su altre porte)', () => {
    expect(internalGatewayTrustedHost('http://172.20.0.1:9999/v1/chat/completions', GW)).toBeUndefined();
  });

  it('gateway non configurato → undefined', () => {
    expect(internalGatewayTrustedHost('http://172.20.0.1:3006/x', undefined)).toBeUndefined();
  });

  it('url malformato → undefined (no throw)', () => {
    expect(internalGatewayTrustedHost('not a url', GW)).toBeUndefined();
  });
});
