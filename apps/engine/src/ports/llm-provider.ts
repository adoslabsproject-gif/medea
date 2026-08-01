export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
}

export interface LLMCompletionRequest {
  model: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  stopSequences?: string[];
  toolCallingEnabled?: boolean;
  abortSignal?: AbortSignal;
}

export interface LLMTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMCompletionResponse {
  text: string;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';
  usage?: LLMTokenUsage;
  raw?: unknown;
}

export interface LLMStreamChunk {
  delta: string;
  done: boolean;
  finishReason?: LLMCompletionResponse['finishReason'];
}

export interface ILLMProvider {
  readonly name: string;
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse>;
  stream(request: LLMCompletionRequest): AsyncIterable<LLMStreamChunk>;
}
