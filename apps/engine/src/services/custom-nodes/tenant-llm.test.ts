/**
 * La chat dei custom node passa dal provider del tenant.
 *
 * Si guarda cosa arriva al dispatcher: il provider e la chiave risolti per il
 * tenant, i messaggi tradotti nella sua forma, le opzioni per chiamata. E
 * cosa succede quando un provider non c'è: l'errore deve dire dove
 * configurarlo, non essere inghiottito qui.
 *
 * @module services/custom-nodes/tenant-llm.test
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  resolve: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock('@/services/llm-resolver.service.js', () => ({
  llmResolver: { resolve: m.resolve },
}));
vi.mock('@/services/llm-chat.service.js', () => ({
  dispatchLLMChat: m.dispatch,
}));

import { tenantChatCompletion } from './tenant-llm.js';

const richiesta = (over = {}) => ({
  messages: [
    { role: 'system', content: 'regole' },
    { role: 'user', content: 'ciao' },
  ],
  temperature: 0.2,
  maxTokens: 100,
  timeoutMs: 5000,
  workspaceId: 'tenant-1',
  ...over,
});

beforeEach(() => {
  m.resolve.mockReset();
  m.dispatch.mockReset();
  m.resolve.mockReturnValue({ provider: 'openai', apiKey: 'sk-1', model: 'gpt-prova' });
  m.dispatch.mockResolvedValue('risposta');
});

describe('tenantChatCompletion', () => {
  it('chiede il provider del tenant, e usa la sua chiave e il suo modello', async () => {
    const r = await tenantChatCompletion(richiesta());

    expect(m.resolve).toHaveBeenCalledWith('tenant-1');
    const args = m.dispatch.mock.calls[0]!;
    expect(args.slice(0, 3)).toEqual(['openai', 'sk-1', 'gpt-prova']);
    expect(r).toEqual({
      content: 'risposta',
      usage: { input: 0, output: 0 },
      provider: 'openai',
    });
  });

  it('separa sistema, storia e ultimo messaggio come li vuole il dispatcher', async () => {
    await tenantChatCompletion(
      richiesta({
        messages: [
          { role: 'system', content: 'regole' },
          { role: 'system', content: 'contesto' },
          { role: 'user', content: 'prima' },
          { role: 'assistant', content: 'seconda' },
          { role: 'user', content: 'terza' },
        ],
      }),
    );
    const [, , , system, user, , history] = m.dispatch.mock.calls[0]!;
    expect(system).toBe('regole\n\ncontesto');
    expect(user).toBe('terza');
    expect(history).toEqual([
      { role: 'user', content: 'prima' },
      { role: 'assistant', content: 'seconda' },
    ]);
  });

  it('passa limite, attesa, temperature e stop come opzioni della chiamata', async () => {
    await tenantChatCompletion(richiesta({ stop: ['\n\n'] }));
    expect(m.dispatch.mock.calls[0]![8]).toEqual({
      maxTokens: 100,
      timeoutMs: 5000,
      temperature: 0.2,
      stop: ['\n\n'],
    });
  });

  it('senza stop non ne inventa uno', async () => {
    await tenantChatCompletion(richiesta());
    expect(m.dispatch.mock.calls[0]![8]).not.toHaveProperty('stop');
  });

  it('modelOverride vince sul modello del tenant', async () => {
    await tenantChatCompletion(richiesta({ modelOverride: 'altro-modello' }));
    expect(m.dispatch.mock.calls[0]![2]).toBe('altro-modello');
  });

  it('porta l’indirizzo configurato dal tenant, quando c’è', async () => {
    m.resolve.mockReturnValue({
      provider: 'ollama',
      apiKey: '',
      model: 'llama',
      baseUrl: 'http://host:11434',
    });
    await tenantChatCompletion(richiesta());
    expect(m.dispatch.mock.calls[0]![5]).toBe('http://host:11434');
  });

  it('riporta i token che il dispatcher dichiara', async () => {
    m.dispatch.mockImplementation((...args: unknown[]) => {
      (args[7] as (u: { input: number; output: number; fromApi: boolean }) => void)({
        input: 7,
        output: 3,
        fromApi: true,
      });
      return Promise.resolve('risposta');
    });
    const r = await tenantChatCompletion(richiesta());
    expect(r.usage).toEqual({ input: 7, output: 3 });
  });

  it('🚨 nessun provider configurato → l’errore esce così com’è, senza chiamare nessuno', async () => {
    const errore = new Error('Nessun provider LLM configurato. Vai in Settings → AI Providers…');
    m.resolve.mockImplementation(() => {
      throw errore;
    });
    await expect(tenantChatCompletion(richiesta())).rejects.toBe(errore);
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it('un errore del provider si propaga: chi chiama decide se ripiegare', async () => {
    m.dispatch.mockRejectedValue(new Error('OpenAI 500: boom'));
    await expect(tenantChatCompletion(richiesta())).rejects.toThrow('OpenAI 500');
  });

  it('rifiuta una conversazione che non finisce con un messaggio dell’utente', async () => {
    await expect(
      tenantChatCompletion(richiesta({ messages: [{ role: 'system', content: 'solo regole' }] })),
    ).rejects.toThrow(/ultimo messaggio/u);
    expect(m.dispatch).not.toHaveBeenCalled();
  });
});
