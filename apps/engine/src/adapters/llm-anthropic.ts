import type {
  ILLMProvider,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMStreamChunk,
} from '@/ports/llm-provider.js';
import { readTextTruncated } from '@/lib/capped-response.js';

interface AnthropicResponseShape {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export class AnthropicProvider implements ILLMProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly apiKey: string,
    private readonly defaultModel = 'claude-sonnet-4-5',
  ) {
    if (!apiKey) throw new Error('AnthropicProvider requires an apiKey');
  }

  async complete(req: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const systemMessages = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const conversation = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }));

    const body: Record<string, unknown> = {
      model: req.model || this.defaultModel,
      max_tokens: req.maxTokens ?? 4096,
      messages: conversation,
    };
    if (systemMessages) body.system = systemMessages;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.stopSequences) body.stop_sequences = req.stopSequences;

    const init: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    };
    if (req.abortSignal) init.signal = req.abortSignal;

    const res = await fetch('https://api.anthropic.com/v1/messages', init);
    const text = (await readTextTruncated(res, 8 * 1024 * 1024)).text; // cap anti-OOM (CDN error page enorme)
    if (!res.ok) {
      throw new Error(`Anthropic ${String(res.status)}: ${text}`);
    }

    // Anthropic outage può rispondere 200 ma con body HTML (CDN error page)
    // o body troncato. Parse non-throwing per evitare crash dell'orchestrator
    // — se non è JSON valido propaghiamo come Error con il body originale
    // troncato per debugging downstream.
    const { safeJsonParse } = await import('../lib/safe-json.js');
    const parseResult = safeJsonParse<AnthropicResponseShape>(text);
    if (!parseResult.ok) {
      throw new Error(`Anthropic 200 but non-JSON body (${text.slice(0, 200)})`);
    }
    const parsed = parseResult.value;
    const responseText =
      parsed.content
        ?.filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text ?? '')
        .join('') ?? '';

    const finishReason: LLMCompletionResponse['finishReason'] =
      parsed.stop_reason === 'end_turn'
        ? 'stop'
        : parsed.stop_reason === 'max_tokens'
          ? 'length'
          : parsed.stop_reason === 'tool_use'
            ? 'tool_calls'
            : 'stop';

    const out: LLMCompletionResponse = {
      text: responseText,
      finishReason,
    };
    if (parsed.usage) {
      out.usage = {
        promptTokens: parsed.usage.input_tokens,
        completionTokens: parsed.usage.output_tokens,
        totalTokens: parsed.usage.input_tokens + parsed.usage.output_tokens,
      };
    }
    return out;
  }

  async *stream(req: LLMCompletionRequest): AsyncIterable<LLMStreamChunk> {
    const result = await this.complete({ ...req, stream: false });
    yield { delta: result.text, done: true, finishReason: result.finishReason };
  }
}
