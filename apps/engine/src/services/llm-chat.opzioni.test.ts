/**
 * Le opzioni per chiamata e il conteggio dei token valgono per OGNI provider.
 *
 * `maxTokens`, `timeoutMs` e il listener dei token stanno nella firma di
 * `dispatchLLMChat`: chi li passa si aspetta che contino. Un nodo che espone
 * «token massimi» e li vede ignorati, o un contatore che resta a zero, sono
 * una firma che promette e non mantiene. Qui si guarda la richiesta che parte
 * davvero, provider per provider, col nome che il suo protocollo dà al limite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Richiesta {
  url: string;
  body: Record<string, unknown>;
  signal: AbortSignal | undefined;
}

let richieste: Richiesta[] = [];
let risposta: unknown = {};

beforeEach(() => {
  richieste = [];
  globalThis.fetch = ((url: string, init: RequestInit) => {
    richieste.push({
      url,
      body: JSON.parse(init.body as string) as Record<string, unknown>,
      signal: init.signal ?? undefined,
    });
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(risposta)),
      json: () => Promise.resolve(risposta),
    } as Response);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.resetModules();
  vi.useRealTimers();
});

async function chiama(
  provider: string,
  opts?: { maxTokens?: number; timeoutMs?: number; temperature?: number; stop?: string[] },
): Promise<{ testo: string; usage: { input: number; output: number; fromApi: boolean }[] }> {
  const { dispatchLLMChat } = await import('./llm-chat.service.js');
  const usage: { input: number; output: number; fromApi: boolean }[] = [];
  const testo = await dispatchLLMChat(
    provider,
    'chiave',
    'modello-di-prova',
    'sei un assistente',
    'ciao',
    undefined,
    [],
    (u) => usage.push(u),
    opts,
  );
  return { testo, usage };
}

describe('maxTokens arriva al provider col nome del suo protocollo', () => {
  it('OpenAI-compatibile → max_tokens', async () => {
    risposta = { choices: [{ message: { content: 'ok' } }] };
    await chiama('openai', { maxTokens: 321 });
    expect(richieste[0]?.body.max_tokens).toBe(321);
  });

  it('OpenAI-compatibile senza maxTokens → il campo non viene mandato', async () => {
    // Un limite inventato qui taglierebbe risposte che il provider avrebbe
    // dato intere: senza richiesta esplicita decide lui.
    risposta = { choices: [{ message: { content: 'ok' } }] };
    await chiama('openai');
    expect(richieste[0]?.body).not.toHaveProperty('max_tokens');
  });

  it('Anthropic → max_tokens, che lì è obbligatorio e ha un predefinito', async () => {
    risposta = { content: [{ type: 'text', text: 'ok' }] };
    await chiama('anthropic', { maxTokens: 321 });
    expect(richieste[0]?.body.max_tokens).toBe(321);

    await chiama('anthropic');
    expect(richieste[1]?.body.max_tokens).toBe(8000);
  });

  /**
   * Dai modelli 4.7 in poi Anthropic risponde 400 a una `temperature`
   * diversa dalla sua predefinita (pagina delle deprecazioni, letta
   * l'11 ottobre 2026): non la si manda, né quella chiesta né lo 0.1.
   */
  it('Anthropic → nessuna temperature, nemmeno se richiesta', async () => {
    risposta = { content: [{ type: 'text', text: 'ok' }] };
    await chiama('anthropic', { temperature: 0.7 });
    await chiama('anthropic');
    expect('temperature' in (richieste[0]?.body ?? {})).toBe(false);
    expect('temperature' in (richieste[1]?.body ?? {})).toBe(false);
  });

  it('Gemini → generationConfig.maxOutputTokens', async () => {
    risposta = { candidates: [{ content: { parts: [{ text: 'ok' }] } }] };
    await chiama('gemini', { maxTokens: 321, temperature: 0.4 });
    expect(richieste[0]?.body.generationConfig).toEqual({
      maxOutputTokens: 321,
      temperature: 0.4,
    });
  });

  it('Ollama → options.num_predict', async () => {
    risposta = { message: { content: 'ok' } };
    await chiama('ollama', { maxTokens: 321 });
    expect(richieste[0]?.body.options).toEqual({ num_predict: 321 });
  });
});

describe('stop: le sequenze a cui fermarsi, col nome di ogni protocollo', () => {
  const STOP = ['\n\n', '/* >>>'];

  it('OpenAI-compatibile → stop', async () => {
    risposta = { choices: [{ message: { content: 'ok' } }] };
    await chiama('openai', { stop: STOP });
    expect(richieste[0]?.body.stop).toEqual(STOP);
  });

  /**
   * Anthropic rifiuta la richiesta intera (400) se una sequenza è fatta di
   * soli spazi o a capo. Mandargliela vorrebbe dire non avere nessuna
   * risposta per colpa di un'opzione accessoria: quelle le si toglie.
   */
  it('Anthropic → stop_sequences, senza quelle di soli spazi che rifiuterebbe', async () => {
    risposta = { content: [{ type: 'text', text: 'ok' }] };
    await chiama('anthropic', { stop: STOP });
    expect(richieste[0]?.body.stop_sequences).toEqual(['/* >>>']);
  });

  it('Anthropic con sole sequenze di spazi → il campo non viene mandato', async () => {
    risposta = { content: [{ type: 'text', text: 'ok' }] };
    await chiama('anthropic', { stop: ['\n\n', '  '] });
    expect(richieste[0]?.body).not.toHaveProperty('stop_sequences');
  });

  it('Gemini → generationConfig.stopSequences', async () => {
    risposta = { candidates: [{ content: { parts: [{ text: 'ok' }] } }] };
    await chiama('gemini', { stop: STOP });
    expect(richieste[0]?.body.generationConfig).toEqual({ stopSequences: STOP });
  });

  it('Ollama → options.stop, insieme al limite di uscita', async () => {
    risposta = { message: { content: 'ok' } };
    await chiama('ollama', { stop: STOP, maxTokens: 50 });
    expect(richieste[0]?.body.options).toEqual({ num_predict: 50, stop: STOP });
  });

  it('senza stop nessun provider riceve il campo', async () => {
    risposta = { choices: [{ message: { content: 'ok' } }] };
    await chiama('openai');
    expect(richieste[0]?.body).not.toHaveProperty('stop');
  });
});

describe('timeoutMs decide quanto si aspetta', () => {
  // Si guarda con quale durata viene creato il segnale di annullamento che
  // parte con la richiesta: i timer finti non governano `AbortSignal.timeout`,
  // quindi aspettare lo scadere misurerebbe l'orologio vero.
  for (const provider of ['openai', 'anthropic', 'gemini', 'ollama']) {
    it(`${provider}: il segnale che parte con la richiesta ha la durata chiesta`, async () => {
      risposta =
        provider === 'anthropic'
          ? { content: [{ type: 'text', text: 'ok' }] }
          : provider === 'gemini'
            ? { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }
            : provider === 'ollama'
              ? { message: { content: 'ok' } }
              : { choices: [{ message: { content: 'ok' } }] };
      const spia = vi.spyOn(AbortSignal, 'timeout');

      await chiama(provider, { timeoutMs: 5_000 });
      expect(spia).toHaveBeenLastCalledWith(5_000);
      expect(richieste[0]?.signal).toBe(spia.mock.results.at(-1)?.value);

      // Senza richiesta resta il minuto di sempre.
      await chiama(provider);
      expect(spia).toHaveBeenLastCalledWith(60_000);

      spia.mockRestore();
    });
  }
});

describe('i token consumati arrivano al listener', () => {
  it('OpenAI-compatibile: quelli dichiarati dal provider', async () => {
    risposta = {
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    };
    const { usage } = await chiama('openai');
    expect(usage).toEqual([{ input: 11, output: 7, fromApi: true }]);
  });

  it('Anthropic: input_tokens e output_tokens', async () => {
    risposta = {
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 11, output_tokens: 7 },
    };
    const { usage } = await chiama('anthropic');
    expect(usage).toEqual([{ input: 11, output: 7, fromApi: true }]);
  });

  it('Gemini: usageMetadata', async () => {
    risposta = {
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 },
    };
    const { usage } = await chiama('gemini');
    expect(usage).toEqual([{ input: 11, output: 7, fromApi: true }]);
  });

  it('Ollama: prompt_eval_count ed eval_count', async () => {
    risposta = { message: { content: 'ok' }, prompt_eval_count: 11, eval_count: 7 };
    const { usage } = await chiama('ollama');
    expect(usage).toEqual([{ input: 11, output: 7, fromApi: true }]);
  });

  it('se il provider non li dichiara si stimano, e lo si dice', async () => {
    risposta = { choices: [{ message: { content: 'una risposta di prova' } }] };
    const { usage } = await chiama('openai');
    expect(usage).toHaveLength(1);
    expect(usage[0]?.fromApi).toBe(false);
    expect(usage[0]?.input).toBeGreaterThan(0);
    expect(usage[0]?.output).toBeGreaterThan(0);
  });
});
