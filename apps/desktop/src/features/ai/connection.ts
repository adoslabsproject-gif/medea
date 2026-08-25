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

/** Dove l'utente può spostare Liara senza che nessuno ricompili niente. */
export const LIARA_BASE_URL_KEY = 'medea.ai.liara.baseUrl';

/**
 * Il gateway di Liara, `/v1` compreso.
 *
 * Il `/v1` non è decorazione: nginx davanti al gateway instrada con una
 * corrispondenza **esatta** su `/v1/chat/completions`, e tutto ciò che non
 * combacia finisce in `location / { return 444; }` — connessione chiusa senza
 * risposta, che a chi chiama arriva come «fetch failed» e non come un 404.
 *
 * È il difetto che ha tenuto fermo il wizard il 2026-08-05: il motore
 * componeva l'indirizzo dal proprio default, che il `/v1` non ce l'aveva, e
 * ogni sua richiesta veniva chiusa in faccia senza una riga di spiegazione.
 *
 * Sta qui e non solo nel Rust perché ora l'indirizzo **parte da qui** anche
 * quando la richiesta la fa il motore: un default in due posti è un default
 * che prima o poi diverge.
 */
export const LIARA_BASE_URL_PREDEFINITO = 'https://liara.nothumanallowed.com/v1';

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

  // Liara è self-hosted: il suo indirizzo non è una costante del mondo, è una
  // scelta di chi la ospita. Chi la sposta lo cambia da qui; chi non l'ha mai
  // toccata usa quello noto.
  //
  // Restituirlo **sempre** è la parte che conta: prima usciva `undefined` per
  // ogni provider diverso da «personalizzato», quindi al motore non arrivava
  // nessun indirizzo e lui ripiegava sul proprio — diverso, e sbagliato.
  if (provider === 'liara') {
    // Un campo svuotato vale «rimetti quello noto», non «nessun indirizzo»:
    // la stringa vuota diventa assenza *prima* del ripiego, altrimenti
    // vincerebbe lei e comporrebbe un URL che non esiste.
    const grezzo = localStorage.getItem(LIARA_BASE_URL_KEY)?.trim();
    const salvato = grezzo === '' ? undefined : grezzo;
    return {
      provider,
      apiKey,
      baseUrl: salvato ?? LIARA_BASE_URL_PREDEFINITO,
      model: undefined,
    };
  }

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
