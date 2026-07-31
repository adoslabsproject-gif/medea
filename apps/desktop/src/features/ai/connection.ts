/**
 * Parametri di connessione al provider attivo.
 *
 * Unico punto in cui si mettono insieme chiave dal portachiavi, endpoint e
 * modello: lo usano sia la chat sia l'agente dei workflow, così non possono
 * divergere.
 */

import { getApiKey } from './keys';
import type { ProviderId } from './types';
import { CUSTOM_BASE_URL_KEY, CUSTOM_MODEL_KEY } from './types';

export const DEFAULT_PROVIDER_KEY = 'medea.ai.defaultProvider';

export interface ProviderConnection {
  provider: ProviderId;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  model: string | undefined;
}

/** Il provider scelto dall'utente. `liara` è il default. */
export function activeProvider(): ProviderId {
  const stored = localStorage.getItem(DEFAULT_PROVIDER_KEY);
  return (stored as ProviderId | null) ?? 'liara';
}

/**
 * `true` per i provider che sanno vincolare l'output a uno schema JSON.
 * Per gli altri lo schema va incollato nel prompt e il risultato ripulito.
 */
export function supportsStructuredOutput(provider: ProviderId): boolean {
  return provider !== 'gemini' && provider !== 'claude-cli';
}

export async function providerConnection(provider: ProviderId): Promise<ProviderConnection> {
  const apiKey = (await getApiKey(provider)) || undefined;
  if (provider !== 'custom') {
    return { provider, apiKey, baseUrl: undefined, model: undefined };
  }
  return {
    provider,
    apiKey,
    baseUrl: localStorage.getItem(CUSTOM_BASE_URL_KEY) ?? undefined,
    model: localStorage.getItem(CUSTOM_MODEL_KEY) ?? undefined,
  };
}
