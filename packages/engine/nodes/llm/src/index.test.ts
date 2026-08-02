import { describe, it, expect } from 'vitest';
import { NodeDefSchema } from '@medea/engine-core-schema';
import { llmNodes } from './index.js';

describe('LLM provider nodes', () => {
  it('ships 5 providers', () => {
    expect(llmNodes).toHaveLength(5);
    const ids = llmNodes.map((n) => n.def.id).sort();
    expect(ids).toEqual(['ai_anthropic', 'ai_gemini', 'ai_ollama', 'ai_openai', 'ai_openrouter']);
  });

  it('every node validates against schema', () => {
    for (const node of llmNodes) {
      const result = NodeDefSchema.safeParse(node.def);
      if (!result.success) throw new Error(`${node.def.id}: ${result.error.message}`);
      expect(result.success).toBe(true);
    }
  });

  it('every node has an executor', () => {
    for (const node of llmNodes) {
      expect(typeof node.executor).toBe('function');
    }
  });

  it('every node has a model field', () => {
    for (const node of llmNodes) {
      const model = node.def.configFields?.find((f) => f.key === 'model');
      expect(model).toBeDefined();
    }
  });

  it('Ollama uses baseUrl not apiKey', () => {
    const ollama = llmNodes.find((n) => n.def.id === 'ai_ollama');
    const baseUrl = ollama?.def.configFields?.find((f) => f.key === 'baseUrl');
    const apiKey = ollama?.def.configFields?.find((f) => f.key === 'apiKey');
    expect(baseUrl).toBeDefined();
    expect(apiKey).toBeUndefined();
  });
});
