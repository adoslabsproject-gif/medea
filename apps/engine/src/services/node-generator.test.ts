import { describe, it, expect } from 'vitest';
import { NodeGeneratorService } from './node-generator.service.js';
import type {
  ILLMProvider,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMStreamChunk,
} from '@/ports/llm-provider.js';

class StubLLMProvider implements ILLMProvider {
  readonly name = 'stub';
  constructor(private readonly response: string) {}
  complete(_req: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    return Promise.resolve({ text: this.response, finishReason: 'stop' });
  }

  async *stream(_req: LLMCompletionRequest): AsyncIterable<LLMStreamChunk> {
    yield { delta: this.response, done: true, finishReason: 'stop' };
  }
}

const VALID_LLM_RESPONSE = `\`\`\`json
{
  "def": {
    "id": "action_stripe_charge",
    "type": "action",
    "label": "Stripe Charge",
    "icon": "credit-card",
    "color": "#635bff",
    "description": "Create a charge via Stripe API.",
    "configFields": [
      { "key": "amount", "label": "Amount (cents)", "type": "number", "required": true },
      { "key": "apiKey", "label": "Stripe Secret Key", "type": "secret", "required": true }
    ],
    "vendor": "third-party",
    "version": "1.0.0"
  },
  "executorSource": "async function execute(config, input, context) { const startedAt = Date.now(); const res = await fetch('https://api.stripe.com/v1/charges', { method: 'POST', headers: { Authorization: 'Bearer ' + context.secrets.apiKey } }); const body = await res.json(); return { output: body, durationMs: Date.now() - startedAt }; }",
  "rationale": "Uses Stripe REST API. Amount in cents.",
  "warnings": ["Idempotency keys not handled in this minimal version."]
}
\`\`\``;

describe('NodeGeneratorService', () => {
  it('parses a valid LLM response into a GeneratedNode', async () => {
    const service = new NodeGeneratorService(new StubLLMProvider(VALID_LLM_RESPONSE));
    const result = await service.generate({ description: 'Stripe charge integration node' });
    expect(result.def.id).toBe('action_stripe_charge');
    expect(result.def.label).toBe('Stripe Charge');
    expect(result.executorSource).toContain('fetch');
    expect(result.warnings).toHaveLength(1);
  });

  it('rejects descriptions under 10 chars', async () => {
    const service = new NodeGeneratorService(new StubLLMProvider(VALID_LLM_RESPONSE));
    await expect(service.generate({ description: 'short' })).rejects.toThrow(/at least 10/);
  });

  it('throws when LLM returns non-JSON', () => {
    const service = new NodeGeneratorService(new StubLLMProvider('Sorry, I cannot help.'));
    expect(() => service.parseLLMResponse('Sorry, I cannot help.')).toThrow(/not valid JSON/);
  });

  it('throws when generated def fails schema validation', () => {
    const bad = `\`\`\`json
{
  "def": { "id": "bad id!", "type": "action", "label": "x", "icon": "i", "color": "red", "description": "" },
  "executorSource": "async function execute(config,input,context){return {output:null,durationMs:0};}",
  "rationale": "n/a"
}
\`\`\``;
    const service = new NodeGeneratorService(new StubLLMProvider(bad));
    expect(() => service.parseLLMResponse(bad)).toThrow(/failed validation/);
  });

  it('rejects executor source with forbidden tokens (process.env)', () => {
    const malicious = `\`\`\`json
{
  "def": {
    "id": "action_evil",
    "type": "action",
    "label": "Evil",
    "icon": "skull",
    "color": "#000000",
    "description": "tries to read env"
  },
  "executorSource": "async function execute(config,input,context){const x=process.env.SECRET; return {output:x,durationMs:0};}",
  "rationale": "n/a"
}
\`\`\``;
    const service = new NodeGeneratorService(new StubLLMProvider(malicious));
    expect(() => service.parseLLMResponse(malicious)).toThrow(/forbidden tokens/);
  });

  it('generateStream: emette delta in ordine poi done col nodo parsato', async () => {
    class MultiChunkLLM implements ILLMProvider {
      readonly name = 'multi';
      constructor(private readonly chunks: string[]) {}
      complete(_req: LLMCompletionRequest): Promise<LLMCompletionResponse> {
        return Promise.resolve({ text: this.chunks.join(''), finishReason: 'stop' });
      }

      async *stream(_req: LLMCompletionRequest): AsyncIterable<LLMStreamChunk> {
        for (const c of this.chunks) yield { delta: c, done: false };
        yield { delta: '', done: true, finishReason: 'stop' };
      }
    }
    const pieces = [
      '```json\n{"def":',
      JSON.stringify({
        id: 'action_x',
        type: 'action',
        label: 'X',
        icon: 'i',
        color: '#ffffff',
        description: 'd',
      }),
      ',"executorSource":"async function execute(c,i,x){return {output:1,durationMs:0};}","rationale":"r"}\n```',
    ];
    const service = new NodeGeneratorService(new MultiChunkLLM(pieces));
    const events: string[] = [];
    let nodeId = '';
    for await (const ev of service.generateStream({ description: 'a long enough description' })) {
      if (ev.type === 'delta') events.push(ev.text);
      else nodeId = ev.node.def.id;
    }
    expect(events).toEqual(pieces);
    expect(nodeId).toBe('action_x');
  });

  it('generateStream: errore di validazione si propaga (no done)', async () => {
    class BrokenLLM implements ILLMProvider {
      readonly name = 'broken';
      complete(): Promise<LLMCompletionResponse> {
        return Promise.resolve({ text: 'nope', finishReason: 'stop' });
      }

      async *stream(): AsyncIterable<LLMStreamChunk> {
        yield { delta: 'not json at all', done: true };
      }
    }
    const service = new NodeGeneratorService(new BrokenLLM());
    await expect(
      (async () => {
        for await (const _ev of service.generateStream({
          description: 'a long enough description',
        })) {
          /* drain */
        }
      })(),
    ).rejects.toThrow(/not valid JSON/u);
  });

  it('parses JSON outside fenced block too', () => {
    const noFence = JSON.stringify({
      def: {
        id: 'action_x',
        type: 'action',
        label: 'X',
        icon: 'x',
        color: '#ffffff',
        description: 'x',
      },
      executorSource:
        'async function execute(config,input,context){return {output:null,durationMs:0};}',
      rationale: 'x',
    });
    const service = new NodeGeneratorService(new StubLLMProvider(noFence));
    const result = service.parseLLMResponse(noFence);
    expect(result.def.id).toBe('action_x');
  });
});
