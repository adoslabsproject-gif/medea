/**
 * Fase 1a (#12) — token usage per-nodo sugli 11 agent_*.
 *
 * CARATTERIZZAZIONE + equivalenza: questa suite fissa il comportamento
 * OSSERVABILE degli agent prima della modifica a dispatchLLM/makeAgentExecutor
 * e deve restare verde anche dopo. Le invarianti protette:
 *   1. Il CONTENUTO dell'output (i campi dati del JSON, il testo del translator)
 *      è byte-identico: aggiungere `_llm` non deve toccare i dati.
 *   2. Il corpo della richiesta inviata al provider (model, messages, parametri)
 *      non cambia: nessuna deriva di prompt.
 *   3. Il repair pass JSON (2ª chiamata) e i suoi percorsi di errore
 *      (_raw/_rawRepaired/_parseError/_repairError) restano identici.
 *   4. Un provider non-ok continua a lanciare con lo stesso messaggio.
 *
 * La sezione «_llm nell'output» è il NUOVO contratto (Fase 1a): usage dai
 * campi API del provider quando presenti (fromApi:true), stima ~3.5 char/token
 * altrimenti (fromApi:false). Mock del solo transport (safeFetchWithRedirects)
 * + breaker passthrough, come agent-review.behavior.test.ts: i reader di body
 * (readJsonCapped/readTextTruncated) restano REALI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const safeFetch = vi.fn<(...a: unknown[]) => Promise<unknown>>();
vi.mock('@medea/engine-safe-fetch', async (orig) => ({
  ...(await orig<typeof import('@medea/engine-safe-fetch')>()),
  safeFetchWithRedirects: (...a: unknown[]) => safeFetch(...a),
}));
vi.mock('@medea/engine-nodes-stdlib', async (orig) => {
  const actual = await orig<typeof import('@medea/engine-nodes-stdlib')>();
  return { ...actual, executeWithHostBreaker: (_u: string, fn: () => unknown) => fn() };
});

const { aiAgentNodes, AI_AGENT_DEFINITIONS } = await import('./index.js');

const okReply = (body: unknown) => ({
  ok: true, status: 200, headers: new Headers(),
  json: async () => body, text: async () => JSON.stringify(body),
});
const errReply = (status: number, body: string) => ({
  ok: false, status, headers: new Headers(),
  json: async () => ({}), text: async () => body,
  // readTextTruncated legge lo stream se presente; senza body stream usa text().
});

const ctx = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} } as never;
const node = (id: string) => {
  const n = aiAgentNodes.find((x) => x.def.id === id);
  if (!n?.executor) throw new Error(`node ${id} non trovato`);
  return n.executor;
};

/** Corpo (parsato) della chiamata i-esima. */
function sentBody(i = 0): Record<string, unknown> {
  const call = safeFetch.mock.calls[i];
  if (!call) throw new Error(`nessuna chiamata #${String(i)}`);
  return JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
}
function sentUrl(i = 0): string {
  const call = safeFetch.mock.calls[i];
  if (!call) throw new Error(`nessuna chiamata #${String(i)}`);
  return call[0] as string;
}

/** Vista DATI dell'output: senza il campo metadata `_llm` (Fase 1a lo aggiunge). */
function dataOf(output: unknown): unknown {
  if (output !== null && typeof output === 'object' && !Array.isArray(output)) {
    const { _llm: _ignored, ...rest } = output as Record<string, unknown>;
    return rest;
  }
  return output;
}

beforeEach(() => {
  safeFetch.mockReset();
  vi.stubEnv('MEDEA_LIARA_BASE_URL', '');
  vi.stubEnv('MEDEA_LICENSE_KEY', '');
});
afterEach(() => { vi.unstubAllEnvs(); });

// ─── Risposte provider (con campi usage API reali) ─────────────────────────
const SUMMARY_JSON = '{"tldr":"Breve.","bullets":["a","b"],"detailed":"Testo lungo.","entities":{"people":["Anna Rossi"],"orgs":[],"dates":[],"amounts":[],"tech":[]}}';
const SUMMARY_DATA = JSON.parse(SUMMARY_JSON) as Record<string, unknown>;

const openAiReply = (text: string, usage?: { prompt_tokens: number; completion_tokens: number }) =>
  okReply({ choices: [{ message: { content: text } }], ...(usage ? { usage } : {}) });
const anthropicReply = (text: string, usage?: { input_tokens: number; output_tokens: number }) =>
  okReply({ content: [{ type: 'text', text }], ...(usage ? { usage } : {}) });
const geminiReply = (text: string, meta?: { promptTokenCount: number; candidatesTokenCount: number }) =>
  okReply({ candidates: [{ content: { parts: [{ text }] } }], ...(meta ? { usageMetadata: meta } : {}) });
const ollamaReply = (text: string, counts?: { prompt_eval_count: number; eval_count: number }) =>
  okReply({ message: { content: text }, ...(counts ?? {}) });

// ════════════════════════════════════════════════════════════════════════════
// CARATTERIZZAZIONE — deve restare verde PRIMA e DOPO la Fase 1a
// ════════════════════════════════════════════════════════════════════════════

describe('caratterizzazione: i DATI di output non cambiano (tutti i provider OpenAI-format)', () => {
  const cases: [provider: string, urlPart: string][] = [
    ['liara', 'liara.nothumanallowed.com/chat/completions'],
    ['openai', 'api.openai.com/v1/chat/completions'],
    ['openrouter', 'openrouter.ai/api/v1/chat/completions'],
    ['mistral', 'api.mistral.ai/v1/chat/completions'],
    ['groq', 'api.groq.com/openai/v1/chat/completions'],
  ];
  for (const [provider, urlPart] of cases) {
    it(`${provider}: summarizer → campi dati byte-identici alla risposta del modello`, async () => {
      safeFetch.mockResolvedValue(openAiReply(SUMMARY_JSON, { prompt_tokens: 100, completion_tokens: 40 }));
      const res = await node('agent_summarizer')({ provider, apiKey: 'k' }, 'testo da riassumere', ctx);
      expect(sentUrl()).toContain(urlPart);
      expect(dataOf(res.output)).toEqual(SUMMARY_DATA);
      expect(typeof res.durationMs).toBe('number');
    });
  }
});

describe('caratterizzazione: provider a shape dedicata', () => {
  it('anthropic: blocchi content type=text concatenati, dati identici', async () => {
    safeFetch.mockResolvedValue(anthropicReply(SUMMARY_JSON, { input_tokens: 120, output_tokens: 55 }));
    const res = await node('agent_summarizer')({ provider: 'anthropic', apiKey: 'k' }, 'testo', ctx);
    expect(sentUrl()).toContain('api.anthropic.com/v1/messages');
    expect(dataOf(res.output)).toEqual(SUMMARY_DATA);
  });

  it('gemini: parts concatenate, dati identici', async () => {
    safeFetch.mockResolvedValue(geminiReply(SUMMARY_JSON, { promptTokenCount: 80, candidatesTokenCount: 30 }));
    const res = await node('agent_summarizer')({ provider: 'gemini', apiKey: 'k' }, 'testo', ctx);
    expect(sentUrl()).toContain('generativelanguage.googleapis.com');
    expect(dataOf(res.output)).toEqual(SUMMARY_DATA);
  });

  it('ollama: message.content, dati identici', async () => {
    safeFetch.mockResolvedValue(ollamaReply(SUMMARY_JSON, { prompt_eval_count: 70, eval_count: 25 }));
    const res = await node('agent_summarizer')({ provider: 'ollama', apiKey: '' }, 'testo', ctx);
    expect(sentUrl()).toContain('/api/chat');
    expect(dataOf(res.output)).toEqual(SUMMARY_DATA);
  });
});

describe('caratterizzazione: translator (outputFormat=text) → output resta la STRINGA nuda', () => {
  it('il testo tradotto è byte-identico e resta di tipo string (le chain downstream non si rompono)', async () => {
    const translated = 'Buongiorno, come stai?';
    safeFetch.mockResolvedValue(openAiReply(translated, { prompt_tokens: 20, completion_tokens: 8 }));
    const res = await node('agent_translator')({ provider: 'openai', apiKey: 'k', targetLanguage: 'italiano' }, 'Good morning, how are you?', ctx);
    expect(res.output).toBe(translated);
    expect(typeof res.output).toBe('string');
  });

  it('whitespace ai bordi PRESERVATO: il provider non-liara non trimma (byte-identico davvero)', async () => {
    safeFetch.mockResolvedValue(openAiReply('  Ciao.\n'));
    const res = await node('agent_translator')({ provider: 'openai', apiKey: 'k', targetLanguage: 'italiano' }, 'Hi.', ctx);
    expect(res.output).toBe('  Ciao.\n');
  });
});

describe('caratterizzazione: corpo richiesta INVARIATO (nessuna deriva di prompt)', () => {
  it('liara: /no_think prefissato al system, model default nha-v1, enable_thinking false', async () => {
    safeFetch.mockResolvedValue(openAiReply(SUMMARY_JSON));
    await node('agent_summarizer')({ provider: 'liara' }, 'testo', ctx);
    const body = sentBody();
    expect(body.model).toBe('nha-v1');
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    const msgs = body.messages as { role: string; content: string }[];
    expect(msgs[0]?.role).toBe('system');
    expect(msgs[0]?.content.startsWith('/no_think\n')).toBe(true);
    expect(msgs[0]?.content).toContain('You are a precise summarizer');
    expect(msgs[1]).toEqual({ role: 'user', content: 'testo' });
  });

  it('openai: model default gpt-4o-mini, system+user come prima', async () => {
    safeFetch.mockResolvedValue(openAiReply(SUMMARY_JSON));
    await node('agent_summarizer')({ provider: 'openai', apiKey: 'k' }, 'testo', ctx);
    const body = sentBody();
    expect(body.model).toBe('gpt-4o-mini');
    const msgs = body.messages as { role: string; content: string }[];
    expect(msgs[0]?.content).toContain('You are a precise summarizer');
    expect(msgs[1]).toEqual({ role: 'user', content: 'testo' });
  });

  it('anthropic: system top-level, max_tokens 4096, model default claude-sonnet-4-5', async () => {
    safeFetch.mockResolvedValue(anthropicReply(SUMMARY_JSON));
    await node('agent_summarizer')({ provider: 'anthropic', apiKey: 'k' }, 'testo', ctx);
    const body = sentBody();
    expect(body.model).toBe('claude-sonnet-4-5');
    expect(body.max_tokens).toBe(4096);
    expect(body.system).toContain('You are a precise summarizer');
  });
});

describe('caratterizzazione: liara strip <think> residuo', () => {
  it('il blocco <think>…</think> è rimosso dal testo PRIMA del parse', async () => {
    safeFetch.mockResolvedValue(openAiReply(`<think>ragionamento interno</think>\n${SUMMARY_JSON}`));
    const res = await node('agent_summarizer')({ provider: 'liara' }, 'testo', ctx);
    expect(dataOf(res.output)).toEqual(SUMMARY_DATA);
    expect(JSON.stringify(res.output)).not.toContain('ragionamento interno');
  });
});

describe('caratterizzazione: repair pass JSON', () => {
  it('1ª risposta non parseabile → 2ª chiamata di riparazione → dati = JSON riparato', async () => {
    safeFetch
      .mockResolvedValueOnce(openAiReply('ecco il json: {rotto', { prompt_tokens: 50, completion_tokens: 10 }))
      .mockResolvedValueOnce(openAiReply('{"label":"spam","confidence":0.9,"alternatives":[]}', { prompt_tokens: 60, completion_tokens: 15 }));
    const res = await node('agent_classifier')({ provider: 'openai', apiKey: 'k', labels: 'spam, ham' }, 'testo', ctx);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    const repairBody = sentBody(1);
    const msgs = repairBody.messages as { role: string; content: string }[];
    expect(msgs[0]?.content).toContain('riparatore di JSON');
    expect(dataOf(res.output)).toEqual({ label: 'spam', confidence: 0.9, alternatives: [] });
  });

  it('anche la riparazione fallisce → {_raw,_rawRepaired,_parseError} come prima', async () => {
    safeFetch
      .mockResolvedValueOnce(openAiReply('{rotto'))
      .mockResolvedValueOnce(openAiReply('ancora {rotto'));
    const res = await node('agent_classifier')({ provider: 'openai', apiKey: 'k', labels: 'a' }, 'testo', ctx);
    const out = dataOf(res.output) as Record<string, unknown>;
    expect(out._raw).toBe('{rotto');
    expect(out._rawRepaired).toBe('ancora {rotto');
    expect(typeof out._parseError).toBe('string');
  });

  it('la riparazione LANCIA → {_raw,_parseError,_repairError} come prima', async () => {
    safeFetch
      .mockResolvedValueOnce(openAiReply('{rotto'))
      .mockRejectedValueOnce(new Error('provider giù'));
    const res = await node('agent_classifier')({ provider: 'openai', apiKey: 'k', labels: 'a' }, 'testo', ctx);
    const out = dataOf(res.output) as Record<string, unknown>;
    expect(out._raw).toBe('{rotto');
    expect(out._repairError).toBe('provider giù');
  });
});

describe('caratterizzazione: errore provider → throw invariato', () => {
  it('HTTP 500 → Error "OpenAI 500: …"', async () => {
    safeFetch.mockResolvedValue(errReply(500, 'boom interno'));
    await expect(
      node('agent_summarizer')({ provider: 'openai', apiKey: 'k' }, 'testo', ctx),
    ).rejects.toThrow(/OpenAI 500/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// NUOVO CONTRATTO Fase 1a — `_llm` nell'output
// ════════════════════════════════════════════════════════════════════════════

interface Llm { inputTokens: number; outputTokens: number; model: string; provider: string; fromApi: boolean }
const llmOf = (output: unknown): Llm => {
  const meta = (output as Record<string, unknown>)._llm;
  if (!meta) throw new Error('output senza _llm');
  return meta as Llm;
};

describe('_llm: conteggi dalla API del provider (fromApi:true)', () => {
  it('openai-format: prompt_tokens/completion_tokens → inputTokens/outputTokens, model default effettivo', async () => {
    safeFetch.mockResolvedValue(openAiReply(SUMMARY_JSON, { prompt_tokens: 100, completion_tokens: 40 }));
    const res = await node('agent_summarizer')({ provider: 'openai', apiKey: 'k' }, 'testo', ctx);
    expect(llmOf(res.output)).toEqual({ inputTokens: 100, outputTokens: 40, model: 'gpt-4o-mini', provider: 'openai', fromApi: true });
  });

  it('anthropic: input_tokens/output_tokens', async () => {
    safeFetch.mockResolvedValue(anthropicReply(SUMMARY_JSON, { input_tokens: 120, output_tokens: 55 }));
    const res = await node('agent_summarizer')({ provider: 'anthropic', apiKey: 'k' }, 'testo', ctx);
    expect(llmOf(res.output)).toEqual({ inputTokens: 120, outputTokens: 55, model: 'claude-sonnet-4-5', provider: 'anthropic', fromApi: true });
  });

  it('gemini: usageMetadata.promptTokenCount/candidatesTokenCount', async () => {
    safeFetch.mockResolvedValue(geminiReply(SUMMARY_JSON, { promptTokenCount: 80, candidatesTokenCount: 30 }));
    const res = await node('agent_summarizer')({ provider: 'gemini', apiKey: 'k' }, 'testo', ctx);
    expect(llmOf(res.output)).toEqual({ inputTokens: 80, outputTokens: 30, model: 'gemini-2.0-flash', provider: 'gemini', fromApi: true });
  });

  it('ollama: prompt_eval_count/eval_count', async () => {
    safeFetch.mockResolvedValue(ollamaReply(SUMMARY_JSON, { prompt_eval_count: 70, eval_count: 25 }));
    const res = await node('agent_summarizer')({ provider: 'ollama', apiKey: '' }, 'testo', ctx);
    expect(llmOf(res.output)).toEqual({ inputTokens: 70, outputTokens: 25, model: 'llama3.2', provider: 'ollama', fromApi: true });
  });

  it('liara: usage del gateway + model default nha-v1', async () => {
    safeFetch.mockResolvedValue(openAiReply(SUMMARY_JSON, { prompt_tokens: 33, completion_tokens: 11 }));
    const res = await node('agent_summarizer')({ provider: 'liara' }, 'testo', ctx);
    expect(llmOf(res.output)).toEqual({ inputTokens: 33, outputTokens: 11, model: 'nha-v1', provider: 'liara', fromApi: true });
  });

  it('config.model override → _llm.model = modello effettivo inviato', async () => {
    safeFetch.mockResolvedValue(openAiReply(SUMMARY_JSON, { prompt_tokens: 1, completion_tokens: 1 }));
    const res = await node('agent_summarizer')({ provider: 'openai', apiKey: 'k', model: 'gpt-4o' }, 'testo', ctx);
    expect(llmOf(res.output).model).toBe('gpt-4o');
    expect(sentBody().model).toBe('gpt-4o');
  });
});

describe('_llm: fallback stima quando la API non riporta usage (fromApi:false)', () => {
  it('risposta senza usage → stima ~3.5 char/token su system+user e sulla risposta', async () => {
    safeFetch.mockResolvedValue(openAiReply(SUMMARY_JSON));
    const res = await node('agent_summarizer')({ provider: 'openai', apiKey: 'k' }, 'testo', ctx);
    const meta = llmOf(res.output);
    expect(meta.fromApi).toBe(false);
    // Stima sul TESTO INVIATO/RICEVUTO reale, verificabile dalla chiamata mockata.
    const msgs = sentBody().messages as { content: string }[];
    const sentChars = msgs.reduce((acc, m) => acc + m.content.length, 0);
    expect(meta.inputTokens).toBe(Math.ceil((msgs[0]?.content.length ?? 0) / 3.5) + Math.ceil((msgs[1]?.content.length ?? 0) / 3.5));
    expect(meta.inputTokens).toBeGreaterThan(0);
    expect(sentChars).toBeGreaterThan(0);
    expect(meta.outputTokens).toBe(Math.ceil(SUMMARY_JSON.length / 3.5));
  });

  it('usage API rotto (NaN) → stima, non NaN nel pannello', async () => {
    safeFetch.mockResolvedValue(okReply({ choices: [{ message: { content: SUMMARY_JSON } }], usage: { prompt_tokens: 'boh', completion_tokens: 40 } }));
    const res = await node('agent_summarizer')({ provider: 'openai', apiKey: 'k' }, 'testo', ctx);
    const meta = llmOf(res.output);
    expect(meta.fromApi).toBe(false);
    expect(Number.isFinite(meta.inputTokens)).toBe(true);
    expect(Number.isFinite(meta.outputTokens)).toBe(true);
  });
});

describe('_llm: repair pass = usage CUMULATIVO delle 2 chiamate', () => {
  it('somma input/output delle due chiamate, fromApi true se entrambe precise', async () => {
    safeFetch
      .mockResolvedValueOnce(openAiReply('{rotto', { prompt_tokens: 50, completion_tokens: 10 }))
      .mockResolvedValueOnce(openAiReply('{"label":"a","confidence":1,"alternatives":[]}', { prompt_tokens: 60, completion_tokens: 15 }));
    const res = await node('agent_classifier')({ provider: 'openai', apiKey: 'k', labels: 'a' }, 'testo', ctx);
    const meta = llmOf(res.output);
    expect(meta).toMatchObject({ inputTokens: 110, outputTokens: 25, fromApi: true });
  });

  it('repair fallito → _llm presente ANCHE sull\'oggetto {_raw,…} (i token sono stati spesi)', async () => {
    safeFetch
      .mockResolvedValueOnce(openAiReply('{rotto', { prompt_tokens: 50, completion_tokens: 10 }))
      .mockResolvedValueOnce(openAiReply('ancora {rotto', { prompt_tokens: 60, completion_tokens: 15 }));
    const res = await node('agent_classifier')({ provider: 'openai', apiKey: 'k', labels: 'a' }, 'testo', ctx);
    expect(llmOf(res.output)).toMatchObject({ inputTokens: 110, outputTokens: 25 });
  });

  it('repair LANCIA → resta l\'usage della 1ª chiamata', async () => {
    safeFetch
      .mockResolvedValueOnce(openAiReply('{rotto', { prompt_tokens: 50, completion_tokens: 10 }))
      .mockRejectedValueOnce(new Error('provider giù'));
    const res = await node('agent_classifier')({ provider: 'openai', apiKey: 'k', labels: 'a' }, 'testo', ctx);
    expect(llmOf(res.output)).toMatchObject({ inputTokens: 50, outputTokens: 10, fromApi: true });
  });
});

describe('_llm: limite documentato Fase 1a — output non-oggetto resta nudo', () => {
  it('translator (stringa): nessun _llm, il valore resta la stringa (usage per queste forme → Fase 3, canale log)', async () => {
    safeFetch.mockResolvedValue(openAiReply('Ciao', { prompt_tokens: 5, completion_tokens: 2 }));
    const res = await node('agent_translator')({ provider: 'openai', apiKey: 'k', targetLanguage: 'italiano' }, 'Hello', ctx);
    expect(res.output).toBe('Ciao');
  });

  it('extractor con output array puro: l\'array resta INTATTO (niente wrapping)', async () => {
    // NB comportamento PRE-esistente di extractJson: con `[{…}]` viene estratto
    // l'OGGETTO interno (prova {} prima di []). Un array arriva in output solo
    // quando il testo non contiene graffe — è quel caso che non va wrappato.
    safeFetch.mockResolvedValue(openAiReply('["anna@x.it","luca@y.it"]', { prompt_tokens: 5, completion_tokens: 2 }));
    const res = await node('agent_extractor')({ provider: 'openai', apiKey: 'k', schema: '["string"]' }, 'testo', ctx);
    expect(res.output).toEqual(['anna@x.it', 'luca@y.it']);
  });
});

describe('caratterizzazione: tutti gli 11 agent specializzati eseguono e ritornano i dati', () => {
  it('ogni agent_* con risposta valida ritorna i dati del modello (JSON) o la stringa (text)', async () => {
    expect(AI_AGENT_DEFINITIONS).toHaveLength(11);
    for (const def of AI_AGENT_DEFINITIONS) {
      safeFetch.mockReset();
      const payload = def.outputFormat === 'json' ? '{"ok":true}' : 'testo di risposta';
      safeFetch.mockResolvedValue(openAiReply(payload, { prompt_tokens: 10, completion_tokens: 5 }));
      const res = await node(def.id)({ provider: 'openai', apiKey: 'k' }, 'input', ctx);
      if (def.outputFormat === 'json') {
        expect(dataOf(res.output)).toEqual({ ok: true });
        // Fase 1a: ogni agent JSON espone il metadata usage standard.
        expect(llmOf(res.output)).toEqual({ inputTokens: 10, outputTokens: 5, model: 'gpt-4o-mini', provider: 'openai', fromApi: true });
      } else {
        expect(res.output).toBe(payload);
      }
    }
  });
});
