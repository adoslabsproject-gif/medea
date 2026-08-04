export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export type ProviderId =
  | 'liara'
  | 'claude-cli'
  | 'custom'
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'deepseek'
  | 'grok'
  | 'openrouter';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  timestamp: string;
}

/** Tool-call emessa dal modello, formato OpenAI. */
export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatTurn {
  role: ChatRole;
  content: string;
  /** Solo `assistant`: tool-call emesse in quel turno. */
  toolCalls?: OpenAiToolCall[];
  /** Solo `tool`: id della call a cui il risultato risponde. */
  toolCallId?: string;
  /** Solo `tool`: nome del tool eseguito. */
  name?: string;
  /** Immagini allegate al turno, come data URL. Il backend le traduce nel
   *  formato multimodale del provider (OpenAI / Anthropic / Gemini). */
  images?: string[];
}

export interface ChatRequest {
  provider: ProviderId;
  systemPrompt: string;
  history: ChatTurn[];
  apiKey?: string | undefined;
  model?: string | undefined;
  /** Solo per provider `custom`: base URL OpenAI-compatibile (es. https://miohost/v1). */
  baseUrl?: string | undefined;
  /** Tool disponibili, formato OpenAI function-calling. */
  tools?: Record<string, unknown>[] | undefined;
  /** Un nome per questa richiesta, se la si vuole poter fermare a metà.
   *  Senza, non è interrompibile — e va bene per le chiamate brevi. */
  requestId?: string | undefined;
  /** Lo schema a cui la risposta deve essere conforme.
   *
   *  Non è un suggerimento nel prompt: i server compatibili con OpenAI
   *  vincolano la generazione, e il modello non può produrre altro. È la
   *  differenza fra chiedere un JSON e ottenerlo. */
  jsonSchema?: Record<string, unknown> | undefined;
}

/** Quanti token è costata una risposta, quando il provider lo dichiara. */
export interface TokenUsage {
  input: number;
  output: number;
}

/** Risposta del modello: testo e/o chiamate a tool già normalizzate. */
export interface ChatResponse {
  content: string;
  /** Quanti token sono serviti, se il provider lo dice. */
  usage?: TokenUsage | undefined;
  toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
}

/** Provider che NON usano una API key: l'auth è altrove (CLI già loggata). */
export function providerNeedsApiKey(p: ProviderId): boolean {
  return p !== 'claude-cli';
}

/** Config non-segreta dell'endpoint personalizzato (la API key sta nel keychain). */
export const CUSTOM_BASE_URL_KEY = 'medea.ai.custom.baseUrl';
export const CUSTOM_MODEL_KEY = 'medea.ai.custom.model';

export function providerLabel(p: ProviderId): string {
  switch (p) {
    case 'liara':
      return 'Liara';
    case 'claude-cli':
      return 'Claude (abbonamento)';
    case 'custom':
      return 'Endpoint personale';
    case 'anthropic':
      return 'Claude';
    case 'openai':
      return 'OpenAI';
    case 'gemini':
      return 'Gemini';
    case 'deepseek':
      return 'DeepSeek';
    case 'grok':
      return 'Grok';
    case 'openrouter':
      return 'OpenRouter';
  }
}

export function providerLong(p: ProviderId): string {
  switch (p) {
    case 'liara':
      return 'Liara — modello proprio (nha-v1), richiede la tua API key';
    case 'claude-cli':
      return 'Claude via CLI locale — usa il tuo abbonamento Pro/Max, nessun costo API';
    case 'custom':
      return 'Endpoint personalizzato — OpenAI-compatibile (vLLM, gateway privato…)';
    case 'anthropic':
      return 'Anthropic Claude — richiede API key';
    case 'openai':
      return 'OpenAI — richiede API key';
    case 'gemini':
      return 'Google Gemini — richiede API key';
    case 'deepseek':
      return 'DeepSeek — richiede API key';
    case 'grok':
      return 'xAI Grok — richiede API key';
    case 'openrouter':
      return 'OpenRouter — richiede API key';
  }
}
