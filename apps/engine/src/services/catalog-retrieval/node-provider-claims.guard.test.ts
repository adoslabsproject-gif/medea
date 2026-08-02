/**
 * GUARD CODEBASE-WIDE — claim provider LLM nelle description ⊆ campo `provider` del nodo.
 *
 * Radice (review nodi): più nodi nominavano provider che NON gestivano
 * (agent_summarizer "(Liara/Anthropic)"; action_llm_complete "Gemini/Perplexity"
 * mentre l'executor li ignora). Questo guard scansiona OGNI nodo di OGNI package del
 * catalog: se il nodo ha un campo `provider` (select) e la sua description NOMINA un
 * provider LLM, quel provider DEVE essere tra le opzioni del campo. Altrimenti è un
 * claim fantasma → ROSSO, codebase-wide, per sempre.
 *
 * Scope: solo nodi CON un campo `provider` select (= scelta provider esposta). I nodi
 * che usano un endpoint diretto (scrape_smart) o un provider hardcoded documentato
 * (agent_tool_loop = Anthropic-only per il tool-calling) NON hanno quel campo → esclusi.
 */
import { describe, it, expect } from 'vitest';
import { stdlibNodes } from '@medea/engine-nodes-stdlib';
import { dbNodes } from '@medea/engine-nodes-db';
import { coreIntegrationNodes } from '@medea/engine-nodes-integrations-core';
import { italianConnectors } from '@medea/engine-nodes-integrations-italia';
import { aiAgentNodes } from '@medea/engine-nodes-ai-agents';
import { llmNodes } from '@medea/engine-nodes-llm';
import type { NodeModule } from '@medea/engine-nodes-stdlib';

const ALL_NODES: NodeModule[] = [
  ...stdlibNodes,
  ...dbNodes,
  ...coreIntegrationNodes,
  ...italianConnectors,
  ...aiAgentNodes,
  ...llmNodes,
];

// Nomi-PROVIDER inequivocabili (NON model name come Claude/GPT/Grok → evitano falsi
// positivi su esempi di modello). Token → id-opzione del campo provider.
const PROVIDER_TOKENS: Record<string, RegExp> = {
  liara: /\bLiara\b/,
  anthropic: /\bAnthropic\b/i,
  openai: /\bOpenAI\b/i,
  gemini: /\bGemini\b/i,
  mistral: /\bMistral\b/i,
  groq: /\bGroq\b/i,
  deepseek: /\bDeepSeek\b/i,
  xai: /\bxAI\b/i,
  ollama: /\bOllama\b/i,
  openrouter: /\bOpenRouter\b/i,
  perplexity: /\bPerplexity\b/i,
  cohere: /\bCohere\b/i,
};

function providerOptions(node: NodeModule): readonly string[] | null {
  const f = node.def.configFields?.find((cf) => cf.key === 'provider');
  if (f?.type !== 'select') return null;
  return f.options ?? [];
}

const withProviderField = ALL_NODES.filter((n) => providerOptions(n) !== null);

describe('GUARD codebase-wide — claim provider ⊆ campo provider', () => {
  it('esistono nodi con campo provider da verificare (sanity)', () => {
    expect(withProviderField.length).toBeGreaterThan(0);
  });

  it('🚨 OGNI provider NOMINATO nella description è tra le opzioni del campo provider del nodo', () => {
    const offenders: string[] = [];
    for (const node of withProviderField) {
      const opts = providerOptions(node)!;
      const desc = node.def.description;
      for (const [id, re] of Object.entries(PROVIDER_TOKENS)) {
        if (re.test(desc) && !opts.includes(id)) {
          offenders.push(
            `${node.def.id}: cita "${id}" ma non è tra le opzioni provider [${opts.join(',')}]`,
          );
        }
      }
    }
    expect(offenders, `claim provider fantasma:\n${offenders.join('\n')}`).toEqual([]);
  });
});
