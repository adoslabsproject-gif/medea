/**
 * Parametri di connessione al provider attivo.
 *
 * Unico punto in cui si mettono insieme chiave dal portachiavi, endpoint e
 * modello: lo usano sia la chat sia l'agente dei workflow, così non possono
 * divergere.
 */

import { notifyAiConfigChanged } from './config-changes';
import { getApiKey } from './keys';
import type { ProviderId } from './types';
import { CUSTOM_BASE_URL_KEY, CUSTOM_MODEL_KEY, isProviderId } from './types';

export const DEFAULT_PROVIDER_KEY = 'medea.ai.defaultProvider';

export interface ProviderConnection {
  provider: ProviderId;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  model: string | undefined;
}

/**
 * Il provider scelto dall'utente, o `null` se non ne ha scelto nessuno.
 *
 * Non c'è un predefinito: Medea non porta con sé un servizio, e scegliere al
 * posto dell'utente vorrebbe dire mostrargli l'errore di un provider che non
 * ha mai selezionato. Un valore salvato che non corrisponde più a un provider
 * — rimasto da una versione che ne aveva uno in più — vale come nessuna
 * scelta.
 */
export function activeProvider(): ProviderId | null {
  const stored = localStorage.getItem(DEFAULT_PROVIDER_KEY);
  return isProviderId(stored) ? stored : null;
}

/**
 * Salva il provider scelto e lo annuncia a chi ne tiene una copia.
 *
 * È l'unico punto in cui la scelta si scrive: le schermate che la cambiano
 * sono due, e scrivendola ognuna per conto suo una delle due dimenticava di
 * avvisare il motore dei workflow.
 */
export function setActiveProvider(provider: ProviderId): void {
  if (activeProvider() === provider) return;
  localStorage.setItem(DEFAULT_PROVIDER_KEY, provider);
  notifyAiConfigChanged();
}

/** Sollevato quando serve un modello e l'utente non ne ha ancora scelto uno. */
export class NessunProviderError extends Error {
  constructor() {
    super('Nessun modello AI scelto. Vai in Impostazioni → Modelli AI e scegline uno.');
    this.name = 'NessunProviderError';
  }
}

/** Il provider scelto, per chi senza non può lavorare. */
export function requireActiveProvider(): ProviderId {
  const provider = activeProvider();
  if (!provider) throw new NessunProviderError();
  return provider;
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

  // Indirizzo e modello li porta solo l'endpoint personale: gli altri provider
  // hanno un indirizzo fisso che conosce il backend, e mandargliene uno
  // significherebbe spedire la loro chiave a un host scelto per altro.
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
