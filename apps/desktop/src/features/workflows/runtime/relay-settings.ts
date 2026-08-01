/**
 * Le impostazioni del canale verso l'esterno.
 *
 * Il **token** sta nel portachiavi: è quello che dimostra di essere questa
 * installazione, e chi lo avesse potrebbe ricevere al posto tuo le chiamate
 * dirette qui. L'indirizzo del relay e l'interruttore acceso/spento stanno
 * accanto alle altre preferenze — non sono segreti, e serve poterli leggere
 * senza aprire il portachiavi a ogni disegno di schermo.
 *
 * Spento di default, e vuoto di default: un'app che si collega da sola a un
 * server di qualcun altro non è quello che nessuno si aspetta installando un
 * client di posta.
 */

import { secretsApi } from '../../secrets/api';

const KEYCHAIN_KEY = 'workflow.relay.token';
const URL_KEY = 'medea.workflows.relayUrl';
const ENABLED_KEY = 'medea.workflows.relayEnabled';

export function relayUrl(): string {
  return localStorage.getItem(URL_KEY) ?? '';
}

export function setRelayUrl(value: string): void {
  localStorage.setItem(URL_KEY, value.trim());
}

export function relayEnabled(): boolean {
  return localStorage.getItem(ENABLED_KEY) === 'true';
}

export function setRelayEnabled(value: boolean): void {
  localStorage.setItem(ENABLED_KEY, String(value));
}

/** Un segreto lungo, dal generatore del sistema operativo. */
function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Il token di questa installazione, creandolo la prima volta.
 *
 * Una volta creato non cambia più: l'identificativo pubblico ne è l'impronta,
 * e cambiarlo vorrebbe dire invalidare tutti gli indirizzi già consegnati a
 * qualcuno.
 */
export async function relayToken(): Promise<string> {
  const existing = await secretsApi.get(KEYCHAIN_KEY);
  if (existing) return existing;
  const token = newToken();
  await secretsApi.set(KEYCHAIN_KEY, token);
  return token;
}

/** Butta via il token. Il prossimo giro ne nasce uno nuovo — e con esso un
 *  identificativo nuovo, che è il modo di revocare gli indirizzi vecchi. */
export async function forgetRelayToken(): Promise<void> {
  await secretsApi.delete(KEYCHAIN_KEY);
}
