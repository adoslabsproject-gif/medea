// @vitest-environment happy-dom

/**
 * Quale provider è attivo, e cosa succede quando non lo è nessuno.
 *
 * Medea non ha un servizio preconfigurato: finché l'utente non sceglie, un
 * provider attivo non c'è. È uno stato vero e va trattato come tale — un
 * ripiego silenzioso su un provider qualsiasi produrrebbe l'errore di quel
 * provider («manca la chiave») a chi non l'ha mai scelto.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getApiKey } = vi.hoisted(() => ({
  getApiKey: vi.fn((_p: string) => Promise.resolve('')),
}));

vi.mock('./keys', () => ({ getApiKey }));

const {
  DEFAULT_PROVIDER_KEY,
  activeProvider,
  providerConnection,
  requireActiveProvider,
  supportsStructuredOutput,
} = await import('./connection');
const { CUSTOM_BASE_URL_KEY, CUSTOM_MODEL_KEY, PROVIDER_IDS, isProviderId } =
  await import('./types');

beforeEach(() => {
  localStorage.clear();
  getApiKey.mockReset();
  getApiKey.mockResolvedValue('');
});

describe('activeProvider', () => {
  it('non ne inventa uno quando nessuno è stato scelto', () => {
    expect(activeProvider()).toBeNull();
  });

  it('restituisce quello scelto', () => {
    localStorage.setItem(DEFAULT_PROVIDER_KEY, 'openai');
    expect(activeProvider()).toBe('openai');
  });

  /**
   * Un provider può sparire fra una versione e l'altra, e il suo nome resta
   * scritto nelle impostazioni di chi lo usava. Quel nome non è più una scelta
   * valida: va letto come «nessuna scelta», non passato al backend che
   * risponderebbe «provider sconosciuto».
   */
  it('scarta un valore salvato che non è più un provider', () => {
    localStorage.setItem(DEFAULT_PROVIDER_KEY, 'provider-dismesso');
    expect(activeProvider()).toBeNull();
  });

  it('scarta la stringa vuota', () => {
    localStorage.setItem(DEFAULT_PROVIDER_KEY, '');
    expect(activeProvider()).toBeNull();
  });
});

describe('requireActiveProvider', () => {
  it('dice dove andare a sceglierlo, quando manca', () => {
    expect(() => requireActiveProvider()).toThrow(/Impostazioni → Modelli AI/u);
  });

  it('restituisce quello scelto', () => {
    localStorage.setItem(DEFAULT_PROVIDER_KEY, 'claude-cli');
    expect(requireActiveProvider()).toBe('claude-cli');
  });
});

describe('isProviderId', () => {
  it('riconosce tutti e soli i provider dichiarati', () => {
    for (const p of PROVIDER_IDS) expect(isProviderId(p)).toBe(true);
    expect(isProviderId('provider-dismesso')).toBe(false);
    expect(isProviderId('')).toBe(false);
    expect(isProviderId(null)).toBe(false);
  });

  it('elenca i provider a chiave, l’endpoint personale e Claude in abbonamento', () => {
    expect([...PROVIDER_IDS].sort()).toEqual(
      [
        'anthropic',
        'claude-cli',
        'custom',
        'deepseek',
        'gemini',
        'grok',
        'openai',
        'openrouter',
      ].sort(),
    );
  });
});

describe('providerConnection', () => {
  it('per un provider a indirizzo fisso porta solo la chiave', async () => {
    getApiKey.mockResolvedValue('sk-prova');
    expect(await providerConnection('openai')).toEqual({
      provider: 'openai',
      apiKey: 'sk-prova',
      baseUrl: undefined,
      model: undefined,
    });
  });

  it('senza chiave non ne passa una vuota', async () => {
    const conn = await providerConnection('anthropic');
    expect(conn.apiKey).toBeUndefined();
  });

  it('per l’endpoint personale porta anche indirizzo e modello', async () => {
    localStorage.setItem(CUSTOM_BASE_URL_KEY, 'https://miohost.example.com/v1');
    localStorage.setItem(CUSTOM_MODEL_KEY, 'mio-modello');
    getApiKey.mockResolvedValue('chiave');
    expect(await providerConnection('custom')).toEqual({
      provider: 'custom',
      apiKey: 'chiave',
      baseUrl: 'https://miohost.example.com/v1',
      model: 'mio-modello',
    });
  });

  it('non manda al provider un indirizzo che l’utente non ha scritto', async () => {
    // L'indirizzo dell'endpoint personale è dell'endpoint personale: se
    // trapelasse sugli altri, una chiave OpenAI finirebbe su un host privato.
    localStorage.setItem(CUSTOM_BASE_URL_KEY, 'https://miohost.example.com/v1');
    for (const p of PROVIDER_IDS) {
      if (p === 'custom') continue;
      expect((await providerConnection(p)).baseUrl).toBeUndefined();
    }
  });
});

describe('supportsStructuredOutput', () => {
  it('è falso solo per chi non sa vincolare la risposta a uno schema', () => {
    expect(supportsStructuredOutput('gemini')).toBe(false);
    expect(supportsStructuredOutput('claude-cli')).toBe(false);
    expect(supportsStructuredOutput('openai')).toBe(true);
    expect(supportsStructuredOutput('custom')).toBe(true);
  });
});
