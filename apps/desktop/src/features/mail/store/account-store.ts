import { useEffect, useState } from 'react';

import { secretsApi } from '../../secrets/api';
import { open, type SealedBlob } from '../crypto';
import type { MailAccount } from '../types';

/** Account (incluse password IMAP/SMTP) nel keychain di sistema. */
const SECRET_KEY = 'accounts.v1';
/** Id account attivo — non è un segreto, resta in localStorage. */
const ACTIVE_KEY = 'medea.accounts.active';
/** Vecchio storage pre-keychain: blob AES "sealed" in localStorage. */
const LEGACY_STORAGE_KEY = 'medea.accounts.v1';

interface LegacyPersistedShape {
  accounts: SealedBlob;
  activeId: string | null;
}

export interface AccountStoreState {
  accounts: MailAccount[];
  activeId: string | null;
  loaded: boolean;
  active: MailAccount | null;
}

export async function loadAccounts(): Promise<AccountStoreState> {
  try {
    let accounts: MailAccount[] = [];
    const raw = await secretsApi.get(SECRET_KEY);
    if (raw) {
      accounts = JSON.parse(raw) as MailAccount[];
    } else {
      // Migrazione one-shot dal vecchio blob sealed in localStorage.
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy) {
        const persisted = JSON.parse(legacy) as LegacyPersistedShape;
        accounts = await open<MailAccount[]>(persisted.accounts);
        await secretsApi.set(SECRET_KEY, JSON.stringify(accounts));
        if (persisted.activeId) localStorage.setItem(ACTIVE_KEY, persisted.activeId);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    }
    const storedActive = localStorage.getItem(ACTIVE_KEY);
    const active = accounts.find((a) => a.id === storedActive) ?? accounts[0] ?? null;
    return {
      accounts,
      activeId: active?.id ?? null,
      loaded: true,
      active,
    };
  } catch (e) {
    console.error('Failed to load accounts:', e);
    return { accounts: [], activeId: null, loaded: true, active: null };
  }
}

export async function saveAccounts(accounts: MailAccount[], activeId: string | null) {
  await secretsApi.set(SECRET_KEY, JSON.stringify(accounts));
  if (activeId) localStorage.setItem(ACTIVE_KEY, activeId);
  else localStorage.removeItem(ACTIVE_KEY);
}

export async function clearAccounts() {
  await secretsApi.delete(SECRET_KEY);
  localStorage.removeItem(ACTIVE_KEY);
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

export function useAccountStore() {
  const [state, setState] = useState<AccountStoreState>({
    accounts: [],
    activeId: null,
    loaded: false,
    active: null,
  });

  useEffect(() => {
    void loadAccounts().then(setState);
  }, []);

  async function refresh() {
    const s = await loadAccounts();
    setState(s);
  }

  async function addAccount(account: MailAccount) {
    const accounts = [...state.accounts.filter((a) => a.id !== account.id), account];
    await saveAccounts(accounts, account.id);
    setState({
      accounts,
      activeId: account.id,
      loaded: true,
      active: account,
    });
  }

  async function updateAccount(id: string, patch: Partial<MailAccount>) {
    const accounts = state.accounts.map((a) => (a.id === id ? { ...a, ...patch } : a));
    await saveAccounts(accounts, state.activeId);
    setState({
      ...state,
      accounts,
      active: accounts.find((a) => a.id === state.activeId) ?? null,
    });
  }

  async function removeAccount(id: string) {
    const accounts = state.accounts.filter((a) => a.id !== id);
    const activeId = state.activeId === id ? (accounts[0]?.id ?? null) : state.activeId;
    await saveAccounts(accounts, activeId);
    setState({
      accounts,
      activeId,
      loaded: true,
      active: accounts.find((a) => a.id === activeId) ?? null,
    });
  }

  async function setActive(id: string) {
    const active = state.accounts.find((a) => a.id === id) ?? null;
    await saveAccounts(state.accounts, id);
    setState({ ...state, activeId: id, active });
  }

  return { ...state, addAccount, updateAccount, removeAccount, setActive, refresh };
}
