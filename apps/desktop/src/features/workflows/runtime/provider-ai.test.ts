/**
 * Le chiavi AI arrivano al motore dei workflow.
 *
 * Fino alla 0.5 il desktop non consegnava mai al motore le chiavi dei
 * provider: i nodi AI dei workflow giravano solo perché il motore aveva un
 * servizio gratuito di ripiego. Tolto quello, un workflow con un nodo AI
 * falliva con «nessun provider configurato» anche a chi aveva la sua chiave
 * salvata in Impostazioni e la chat funzionante.
 *
 * @module features/workflows/runtime/provider-ai.test
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./client', () => ({
  runtimeApi: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
  runtimeStatus: vi.fn(),
}));
vi.mock('../../ai/keys', () => ({ getApiKey: vi.fn() }));
vi.mock('../../ai/connection', () => ({ activeProvider: vi.fn() }));

import { notifyAiConfigChanged } from '../../ai/config-changes';
import { activeProvider } from '../../ai/connection';
import { getApiKey } from '../../ai/keys';
import type { ProviderId } from '../../ai/types';

import { runtimeApi, runtimeStatus } from './client';
import {
  ascoltaConfigurazioneAi,
  consegnaProviderAi,
  consegnaProviderAiSeInPiedi,
  dimenticaConsegne,
  PROVIDER_DEL_MOTORE,
} from './provider-ai';

/** Lo stato del motore: quali provider hanno una chiave, e quale è preferito. */
function motore(conChiave: string[], predefinito: string | null = null) {
  vi.mocked(runtimeApi.get).mockImplementation((path: string) => {
    if (path === '/llm-providers') {
      return Promise.resolve({
        providers: ['anthropic', 'openai', 'gemini', 'mistral'].map((provider) => ({
          provider,
          hasKey: conChiave.includes(provider),
        })),
      });
    }
    if (path === '/llm-providers/preferences') {
      return Promise.resolve({ defaultLlmProvider: predefinito });
    }
    return Promise.reject(new Error(`chiamata inattesa: ${path}`));
  });
}

/** Le chiavi nel portachiavi del desktop. */
function portachiavi(chiavi: Partial<Record<ProviderId, string>>) {
  vi.mocked(getApiKey).mockImplementation((p) => Promise.resolve(chiavi[p] ?? ''));
}

beforeEach(() => {
  dimenticaConsegne();
  vi.mocked(runtimeApi.get).mockReset();
  vi.mocked(runtimeApi.put).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(runtimeApi.delete).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(runtimeStatus).mockReset();
  vi.mocked(getApiKey).mockReset();
  vi.mocked(activeProvider).mockReset().mockReturnValue(null);
});

describe('consegnaProviderAi — le chiavi salvate arrivano al motore', () => {
  it('una chiave nel portachiavi viene consegnata al motore', async () => {
    motore([]);
    portachiavi({ openai: 'sk-desktop' });

    const esito = await consegnaProviderAi();

    expect(runtimeApi.put).toHaveBeenCalledWith('/llm-providers/openai', { apiKey: 'sk-desktop' });
    expect(esito.consegnati).toEqual(['openai']);
    expect(esito.problems).toEqual([]);
  });

  it('una chiave tolta dal desktop viene tolta anche dal motore', async () => {
    motore(['anthropic']);
    portachiavi({});

    const esito = await consegnaProviderAi();

    expect(runtimeApi.delete).toHaveBeenCalledWith('/llm-providers/anthropic');
    expect(esito.tolti).toEqual(['anthropic']);
  });

  it('non tocca i provider che il desktop non gestisce', async () => {
    // `mistral` esiste solo nel motore: non è il desktop a decidere se resta.
    motore(['mistral']);
    portachiavi({});

    await consegnaProviderAi();

    expect(runtimeApi.delete).not.toHaveBeenCalled();
  });

  it('niente chiave e niente sul motore: nessuna scrittura', async () => {
    motore([]);
    portachiavi({});

    await consegnaProviderAi();

    expect(runtimeApi.put).not.toHaveBeenCalled();
    expect(runtimeApi.delete).not.toHaveBeenCalled();
  });

  it('la stessa chiave non viene riscritta a ogni apertura della sezione', async () => {
    portachiavi({ openai: 'sk-desktop' });
    motore([]);
    await consegnaProviderAi();
    motore(['openai']);
    await consegnaProviderAi();

    expect(runtimeApi.put).toHaveBeenCalledTimes(1);
  });

  it('una chiave cambiata viene riconsegnata', async () => {
    motore([]);
    portachiavi({ openai: 'sk-vecchia' });
    await consegnaProviderAi();

    motore(['openai']);
    portachiavi({ openai: 'sk-nuova' });
    await consegnaProviderAi();

    expect(runtimeApi.put).toHaveBeenLastCalledWith('/llm-providers/openai', {
      apiKey: 'sk-nuova',
    });
  });

  it('se il motore ha perso la chiave la riceve di nuovo, anche se era già stata consegnata', async () => {
    portachiavi({ openai: 'sk-desktop' });
    motore([]);
    await consegnaProviderAi();
    // Il database del motore è stato ricreato: la chiave non c'è più.
    motore([]);
    await consegnaProviderAi();

    expect(runtimeApi.put).toHaveBeenCalledTimes(2);
  });

  it('un provider che fallisce non ferma gli altri', async () => {
    motore([]);
    portachiavi({ openai: 'sk-1', gemini: 'gk-1' });
    vi.mocked(runtimeApi.put).mockImplementation((path: string) =>
      path.endsWith('/openai') ? Promise.reject(new Error('400')) : Promise.resolve({ ok: true }),
    );

    const esito = await consegnaProviderAi();

    expect(esito.consegnati).toEqual(['gemini']);
    expect(esito.problems).toHaveLength(1);
    expect(esito.problems[0]).toContain('openai');
  });

  it('un problema non riporta mai la chiave', async () => {
    motore([]);
    portachiavi({ openai: 'sk-segretissima' });
    vi.mocked(runtimeApi.put).mockRejectedValue(new Error('rifiutata sk-segretissima'));

    const esito = await consegnaProviderAi();

    expect(esito.problems.join(' ')).not.toContain('sk-segretissima');
  });
});

describe('consegnaProviderAi — il provider scelto vale anche per i workflow', () => {
  it('il provider scelto, se ha una chiave, diventa il predefinito del motore', async () => {
    motore([]);
    portachiavi({ openai: 'sk-1', anthropic: 'ak-1' });
    vi.mocked(activeProvider).mockReturnValue('anthropic');

    const esito = await consegnaProviderAi();

    expect(runtimeApi.put).toHaveBeenCalledWith('/llm-providers/preferences', {
      defaultLlmProvider: 'anthropic',
    });
    expect(esito.predefinito).toBe('anthropic');
  });

  it.each(['claude-cli', 'custom'] as const)(
    '«%s» non esiste nel motore: nessuna preferenza, decide il primo con chiave',
    async (scelto) => {
      motore(['openai'], 'openai');
      portachiavi({ openai: 'sk-1' });
      vi.mocked(activeProvider).mockReturnValue(scelto);

      const esito = await consegnaProviderAi();

      expect(runtimeApi.put).toHaveBeenCalledWith('/llm-providers/preferences', {
        defaultLlmProvider: null,
      });
      expect(esito.predefinito).toBeNull();
    },
  );

  it('un provider scelto ma senza chiave non viene dichiarato predefinito', async () => {
    motore([], 'gemini');
    portachiavi({ openai: 'sk-1' });
    vi.mocked(activeProvider).mockReturnValue('gemini');

    await consegnaProviderAi();

    expect(runtimeApi.put).toHaveBeenCalledWith('/llm-providers/preferences', {
      defaultLlmProvider: null,
    });
  });

  it('se la preferenza è già quella, non si riscrive', async () => {
    motore(['openai'], 'openai');
    portachiavi({ openai: 'sk-1' });
    vi.mocked(activeProvider).mockReturnValue('openai');

    await consegnaProviderAi();

    expect(runtimeApi.put).not.toHaveBeenCalledWith(
      '/llm-providers/preferences',
      expect.anything(),
    );
  });
});

describe('consegnaProviderAiSeInPiedi — salvare una chiave non avvia il motore', () => {
  it('a motore spento non fa nessuna chiamata', async () => {
    vi.mocked(runtimeStatus).mockResolvedValue({ running: false });

    expect(await consegnaProviderAiSeInPiedi()).toBeNull();
    expect(runtimeApi.get).not.toHaveBeenCalled();
  });

  it('a motore acceso consegna subito', async () => {
    vi.mocked(runtimeStatus).mockResolvedValue({ running: true });
    motore([]);
    portachiavi({ openai: 'sk-1' });

    const esito = await consegnaProviderAiSeInPiedi();

    expect(esito?.consegnati).toEqual(['openai']);
  });
});

describe('ascoltaConfigurazioneAi — un cambio in Impostazioni arriva al motore acceso', () => {
  /** Lascia svuotare la coda delle consegne. */
  const aspetta = () =>
    new Promise((r) => {
      setTimeout(r, 0);
    });

  it('una chiave cambiata viene consegnata senza riaprire i workflow', async () => {
    vi.mocked(runtimeStatus).mockResolvedValue({ running: true });
    motore([]);
    portachiavi({ openai: 'sk-1' });
    const smetti = ascoltaConfigurazioneAi();

    notifyAiConfigChanged();
    await aspetta();

    expect(runtimeApi.put).toHaveBeenCalledWith('/llm-providers/openai', { apiKey: 'sk-1' });
    smetti();
  });

  it('dopo aver smesso di ascoltare non consegna più', async () => {
    vi.mocked(runtimeStatus).mockResolvedValue({ running: true });
    motore([]);
    portachiavi({ openai: 'sk-1' });
    ascoltaConfigurazioneAi()();

    notifyAiConfigChanged();
    await aspetta();

    expect(runtimeApi.put).not.toHaveBeenCalled();
  });

  it('due cambi di fila si consegnano in ordine, non insieme', async () => {
    vi.mocked(runtimeStatus).mockResolvedValue({ running: true });
    motore([]);
    let aperte = 0;
    let massimo = 0;
    vi.mocked(getApiKey).mockImplementation(async (p) => {
      aperte++;
      massimo = Math.max(massimo, aperte);
      await aspetta();
      aperte--;
      return p === 'openai' ? 'sk-1' : '';
    });
    const smetti = ascoltaConfigurazioneAi();

    notifyAiConfigChanged();
    notifyAiConfigChanged();
    await vi.waitFor(() => {
      expect(runtimeStatus).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(aperte).toBe(0);
    });

    expect(massimo).toBe(1);
    smetti();
  });

  it('un motore che non risponde non fa esplodere niente', async () => {
    vi.mocked(runtimeStatus).mockRejectedValue(new Error('giù'));
    const avviso = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const smetti = ascoltaConfigurazioneAi();

    notifyAiConfigChanged();
    await aspetta();

    expect(avviso).toHaveBeenCalled();
    avviso.mockRestore();
    smetti();
  });
});

describe('PROVIDER_DEL_MOTORE — i nomi sono quelli che il motore accetta', () => {
  /**
   * Il motore rifiuta con 400 un nome che non conosce. I due elenchi vivono
   * in pacchetti diversi: se uno cambia nome a un provider, questo test è
   * l'unico posto in cui la cosa si vede prima dell'utente.
   */
  it('ogni provider consegnato è fra quelli supportati dal motore', () => {
    const sorgente = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../../engine/src/services/llm-providers.service.ts',
      ),
      'utf8',
    );
    const blocco = /SUPPORTED_PROVIDERS[^=]*=\s*\[([^\]]*)\]/u.exec(sorgente)?.[1] ?? '';
    const supportati = [...blocco.matchAll(/'([a-z-]+)'/gu)].map((m) => m[1]);

    expect(supportati.length).toBeGreaterThan(0);
    expect([...PROVIDER_DEL_MOTORE].sort()).toEqual(
      ['anthropic', 'deepseek', 'gemini', 'grok', 'openai', 'openrouter'].sort(),
    );
    for (const provider of PROVIDER_DEL_MOTORE) {
      expect(supportati, `il motore non conosce «${provider}»`).toContain(provider);
    }
  });
});
