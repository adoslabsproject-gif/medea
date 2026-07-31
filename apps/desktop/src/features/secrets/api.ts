import { invoke } from '@tauri-apps/api/core';

/**
 * Segreti nel keychain di sistema (macOS Keychain / Windows Credential
 * Manager / Linux Secret Service) via comandi Tauri `secret_*`.
 *
 * Convenzione chiavi:
 * - `ai.key.<provider>` — API key BYOK del provider AI
 * - `accounts.v1`       — JSON degli account mail (incluse password IMAP/SMTP)
 */
export const secretsApi = {
  set: (key: string, value: string): Promise<void> => invoke('secret_set', { key, value }),
  get: (key: string): Promise<string | null> => invoke('secret_get', { key }),
  delete: (key: string): Promise<void> => invoke('secret_delete', { key }),
};
