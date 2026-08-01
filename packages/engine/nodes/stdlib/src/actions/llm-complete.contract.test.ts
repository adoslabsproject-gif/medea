/**
 * Contract test ANTI-DRIFT — action_llm_complete.
 *
 * Storia: la description prometteva "9 provider" incl. Gemini/Perplexity mentre
 * l'executor NON le supportava (claim fantasma). RISOLTO IMPLEMENTANDO i provider
 * (non sgonfiando la description): Gemini era già nel provider-registry, Perplexity
 * aggiunto al SSOT (OpenAI-compat sonar). Ora il guard pretende il CONTRARIO: ogni
 * provider citato come supportato DEVE essere nell'enum del campo `provider`, e i
 * provider reali (gemini, perplexity inclusi) devono esserci.
 *
 * NB: l'anti-drift configField ↔ executor ALLOWED_PROVIDERS vive nel runtime
 * (executors/llm-complete.test.ts) dove ALLOWED_PROVIDERS è importabile.
 */
import { describe, it, expect } from 'vitest';
import { llmCompleteNode } from './llm-complete.js';

const def = llmCompleteNode.def;
const description = def.description;
const providerField = def.configFields?.find((f) => f.key === 'provider');
const options = providerField?.type === 'select' ? providerField.options : [];

describe('action_llm_complete — contract description ⊆ provider (anti-drift)', () => {
  it('il campo provider espone l\'insieme reale (10: liara + 9 BYOK)', () => {
    expect([...options].sort()).toEqual(
      ['anthropic', 'deepseek', 'gemini', 'groq', 'liara', 'mistral', 'openai', 'openrouter', 'perplexity', 'xai'],
    );
  });

  it('🚨 Gemini e Perplexity sono SUPPORTATI (opzione + citati in description)', () => {
    expect(options).toContain('gemini');
    expect(options).toContain('perplexity');
    expect(description).toMatch(/Gemini/i);
    expect(description).toMatch(/Perplexity/i);
  });

  it('🚨 ogni provider BYOK citato nella description ∈ enum del campo provider', () => {
    // Mapping nome-umano → id enum, per i provider nominati nella description.
    const named: Record<string, string> = {
      Anthropic: 'anthropic', OpenAI: 'openai', 'Google Gemini': 'gemini', 'DeepSeek-V3': 'deepseek',
      'xAI Grok': 'xai', OpenRouter: 'openrouter', Mistral: 'mistral', Groq: 'groq', Perplexity: 'perplexity',
    };
    for (const [human, id] of Object.entries(named)) {
      if (new RegExp(human, 'i').test(description)) {
        expect(options, `description cita "${human}" ma '${id}' non è nell'enum provider`).toContain(id);
      }
    }
  });
});
