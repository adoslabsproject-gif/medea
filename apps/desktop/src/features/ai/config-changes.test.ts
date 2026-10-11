// @vitest-environment happy-dom

/**
 * Chi cambia provider o chiave lo fa sapere.
 *
 * Il motore dei workflow tiene una copia delle chiavi. Se una chiave cambia
 * in Impostazioni e nessuno lo dice, i workflow pianificati continuano con
 * quella vecchia finché l'utente non riapre la sezione — e un cron notturno
 * fallisce con una chiave che l'utente ha già sostituito.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { secretsApi } = vi.hoisted(() => ({
  secretsApi: {
    get: vi.fn(() => Promise.resolve(null as string | null)),
    set: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock('../secrets/api', () => ({ secretsApi }));

const { notifyAiConfigChanged, onAiConfigChanged } = await import('./config-changes');
const { DEFAULT_PROVIDER_KEY, activeProvider, setActiveProvider } = await import('./connection');
const { setApiKey } = await import('./keys');

beforeEach(() => {
  localStorage.clear();
});

describe('onAiConfigChanged', () => {
  it('chi ascolta viene chiamato a ogni cambiamento', () => {
    const ascolta = vi.fn();
    const smetti = onAiConfigChanged(ascolta);

    notifyAiConfigChanged();
    notifyAiConfigChanged();

    expect(ascolta).toHaveBeenCalledTimes(2);
    smetti();
  });

  it('chi ha smesso di ascoltare non viene più chiamato', () => {
    const ascolta = vi.fn();
    onAiConfigChanged(ascolta)();

    notifyAiConfigChanged();

    expect(ascolta).not.toHaveBeenCalled();
  });

  it('un ascoltatore che fallisce non zittisce gli altri', () => {
    const rotto = vi.fn(() => {
      throw new Error('rotto');
    });
    const sano = vi.fn();
    const smettiRotto = onAiConfigChanged(rotto);
    const smettiSano = onAiConfigChanged(sano);
    const avviso = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    notifyAiConfigChanged();

    expect(sano).toHaveBeenCalledOnce();
    expect(avviso).toHaveBeenCalled();
    avviso.mockRestore();
    smettiRotto();
    smettiSano();
  });
});

describe('setActiveProvider', () => {
  it('salva la scelta e la annuncia', () => {
    const ascolta = vi.fn();
    const smetti = onAiConfigChanged(ascolta);

    setActiveProvider('openai');

    expect(localStorage.getItem(DEFAULT_PROVIDER_KEY)).toBe('openai');
    expect(activeProvider()).toBe('openai');
    expect(ascolta).toHaveBeenCalledOnce();
    smetti();
  });

  it('riscegliere lo stesso provider non annuncia niente', () => {
    setActiveProvider('openai');
    const ascolta = vi.fn();
    const smetti = onAiConfigChanged(ascolta);

    setActiveProvider('openai');

    expect(ascolta).not.toHaveBeenCalled();
    smetti();
  });
});

describe('setApiKey', () => {
  it('annuncia la chiave salvata, dopo averla scritta nel portachiavi', async () => {
    const ordine: string[] = [];
    secretsApi.set.mockImplementationOnce(() => {
      ordine.push('portachiavi');
      return Promise.resolve();
    });
    const smetti = onAiConfigChanged(() => ordine.push('annuncio'));

    await setApiKey('anthropic', 'ak-nuova');

    expect(ordine).toEqual(['portachiavi', 'annuncio']);
    smetti();
  });

  it('annuncia anche la chiave tolta', async () => {
    const ascolta = vi.fn();
    const smetti = onAiConfigChanged(ascolta);

    await setApiKey('anthropic', '   ');

    expect(secretsApi.delete).toHaveBeenCalled();
    expect(ascolta).toHaveBeenCalledOnce();
    smetti();
  });
});
