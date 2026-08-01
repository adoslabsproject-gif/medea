/**
 * Il collegamento con il runtime che esegue i workflow.
 *
 * Il runtime è lo stesso che gira sul server, avviato da Medea come processo
 * figlio su `127.0.0.1`. Qui ci sono solo le chiamate: indirizzo e token
 * arrivano dal Rust, che si occupa di avviarlo e di provvedere l'identità.
 *
 * La sessione si tiene in memoria per non ricrearla a ogni chiamata, ma si
 * butta al primo 401: un token scaduto è normale, non è un errore da mostrare
 * all'utente.
 */

import { invoke } from '@tauri-apps/api/core';

export interface RuntimeSession {
  baseUrl: string;
  token: string;
}

export interface RuntimeStatus {
  running: boolean;
  port?: number;
  baseUrl?: string;
  error?: string;
}

let cached: RuntimeSession | null = null;

/** Avvia il runtime se serve e restituisce dove parlargli. */
export async function session(): Promise<RuntimeSession> {
  cached ??= await invoke<RuntimeSession>('workflow_runtime_session');
  return cached;
}

export function forgetSession(): void {
  cached = null;
}

export function runtimeStatus(): Promise<RuntimeStatus> {
  return invoke('workflow_runtime_status');
}

/** Avvia il runtime se non è già in piedi. Idempotente. */
export function startRuntime(): Promise<RuntimeStatus> {
  return invoke('workflow_runtime_start');
}

/**
 * Riavvia il runtime perché riprenda la pianificazione.
 *
 * Serve dopo aver attivato o disattivato un workflow: lo scheduler carica i
 * cron una volta sola all'avvio, quindi senza questo un workflow attivato non
 * entrerebbe mai in pianificazione.
 */
export async function reloadRuntime(): Promise<RuntimeStatus> {
  forgetSession();
  return invoke('workflow_runtime_reload');
}

export class RuntimeError extends Error {}

/**
 * Una chiamata al runtime. Al primo rifiuto per sessione scaduta se ne
 * prende una nuova e si riprova — una volta sola: se rifiuta anche quella,
 * il problema non è il token.
 */
async function call<T>(
  path: string,
  init: Omit<RequestInit, 'headers'> = {},
  retry = true,
): Promise<T> {
  const s = await session();
  const response = await fetch(`${s.baseUrl}/api/v1${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${s.token}`,
    },
  });

  if (response.status === 401 && retry) {
    forgetSession();
    return call<T>(path, init, false);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new RuntimeError(
      `Il runtime ha risposto ${String(response.status)}${body ? `: ${body.slice(0, 300)}` : ''}`,
    );
  }

  return (await response.json()) as T;
}

export const runtimeApi = {
  get: <T>(path: string) => call<T>(path),
  post: <T>(path: string, body: unknown) =>
    call<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    call<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(path: string) => call<T>(path, { method: 'DELETE' }),
};
