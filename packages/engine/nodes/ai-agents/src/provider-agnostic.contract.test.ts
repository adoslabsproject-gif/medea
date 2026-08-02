/**
 * Contract test ANTI-ASPIRAZIONALE — gli agent generici sono PROVIDER-AGNOSTICI.
 *
 * Bug segnalato: una description diceva "Agent LLM (Liara/Anthropic)" mentre il nodo
 * funziona con QUALSIASI provider configurato in Settings → AI Providers (l'executor
 * `resolveLlmSettings` itera la preference order, e `dispatchLLM` supporta
 * anthropic/openai/gemini/mistral/groq/openrouter/ollama/liara). Una description che
 * nomina un sottoinsieme ristretto inganna l'utente.
 *
 * Questo guard lega description ↔ capability reale per OGNI agent generico (quelli
 * costruiti da makeAgentNode = AI_AGENT_DEFINITIONS):
 *  1. esiste un configField `provider` con TUTTI i provider supportati (+ '' = default Settings);
 *  2. la description NON restringe a una coppia/sottoinsieme di provider.
 *
 * NB: agent_tool_loop è ESCLUSO — usa l'API Anthropic per il tool-calling ed è
 * legittimamente provider-specifico (documentato onestamente nel suo nodo).
 */
import { describe, it, expect } from 'vitest';
import { aiAgentNodes, AI_AGENT_DEFINITIONS } from './index.js';

// Provider che l'executor (dispatchLLM) sa gestire — fonte di verità della capability.
const SUPPORTED = [
  'anthropic',
  'openai',
  'gemini',
  'mistral',
  'groq',
  'openrouter',
  'ollama',
  'liara',
] as const;

const genericIds = new Set(AI_AGENT_DEFINITIONS.map((a) => a.id));
const genericNodes = aiAgentNodes.filter((n) => genericIds.has(n.def.id));

describe('agent generici — provider-agnostici (contract)', () => {
  it('il set di test copre tutti gli agent generici', () => {
    expect(genericNodes.length).toBe(AI_AGENT_DEFINITIONS.length);
    expect(genericNodes.length).toBeGreaterThan(0);
  });

  it('🚨 ogni agent generico ha un campo provider con TUTTI i provider supportati + default Settings ("")', () => {
    for (const node of genericNodes) {
      const field = node.def.configFields?.find((f) => f.key === 'provider');
      expect(field, `${node.def.id}: manca il configField provider`).toBeDefined();
      const opts = field?.type === 'select' ? field.options : [];
      expect(opts, `${node.def.id}: provider deve includere '' (default Settings)`).toContain('');
      for (const p of SUPPORTED) {
        expect(opts, `${node.def.id}: provider non offre '${p}'`).toContain(p);
      }
    }
  });

  it('🚨 nessuna description di agent generico restringe a provider specifici (no "Liara/Anthropic", "solo Liara", ecc.)', () => {
    // Pattern che nominano un provider come VINCOLO (non come esempio di Settings).
    const RESTRICTIVE = [
      /\(\s*Liara\s*\/\s*Anthropic\s*\)/i,
      /\bsolo\s+(Liara|Anthropic|OpenAI)\b/i,
      /\bsoltanto\s+(Liara|Anthropic)\b/i,
      /\bonly\s+(Liara|Anthropic)\b/i,
    ];
    for (const node of genericNodes) {
      const d = node.def.description;
      for (const re of RESTRICTIVE) {
        expect(
          re.test(d),
          `${node.def.id}: description restringe i provider (${re}) ma il nodo è provider-agnostico`,
        ).toBe(false);
      }
    }
  });
});
