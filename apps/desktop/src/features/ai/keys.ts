import { secretsApi } from '../secrets/api';

import type { ProviderId } from './types';

/**
 * API key BYOK per provider, salvate nel keychain OS.
 *
 * Migrazione trasparente: se una chiave esiste ancora nel vecchio storage
 * `localStorage` (plaintext, pre-keychain), viene spostata nel keychain e
 * rimossa da localStorage al primo accesso.
 */
const LEGACY_PREFIX = 'medea.ai.key.';
const cache = new Map<ProviderId, string>();

function keychainKey(p: ProviderId): string {
  return `ai.key.${p}`;
}

export async function getApiKey(p: ProviderId): Promise<string> {
  const cached = cache.get(p);
  if (cached !== undefined) return cached;
  let value = (await secretsApi.get(keychainKey(p))) ?? '';
  if (!value) {
    const legacy = localStorage.getItem(LEGACY_PREFIX + p);
    if (legacy?.trim()) {
      value = legacy.trim();
      await secretsApi.set(keychainKey(p), value);
      localStorage.removeItem(LEGACY_PREFIX + p);
    }
  }
  cache.set(p, value);
  return value;
}

export async function setApiKey(p: ProviderId, value: string): Promise<void> {
  const v = value.trim();
  if (v) await secretsApi.set(keychainKey(p), v);
  else await secretsApi.delete(keychainKey(p));
  localStorage.removeItem(LEGACY_PREFIX + p);
  cache.set(p, v);
}
