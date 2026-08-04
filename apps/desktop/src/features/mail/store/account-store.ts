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
  /**
   * Il portachiavi non ha risposto: **non sappiamo** quali account esistono.
   *
   * È diverso da «non ce ne sono», e confondere le due cose ha fatto danni
   * veri il 2026-08-04: il portachiavi non ha risposto, l'app ha concluso che
   * la posta non fosse configurata e ha chiesto le credenziali. Reinserite,
   * hanno prodotto un account con un id nuovo per un indirizzo che nel
   * database c'era già — colonna unica, inserimento rifiutato, e la prima
   * cartella agganciata a un id inesistente: «FOREIGN KEY constraint failed».
   *
   * Chi non sa deve dirlo, non tirare a indovinare il caso peggiore.
   */
  illeggibile: boolean;
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
      illeggibile: false,
    };
  } catch (e) {
    console.error('Lettura degli account fallita:', e);
    return {
      accounts: [],
      activeId: null,
      loaded: true,
      active: null,
      illeggibile: true,
    };
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
    illeggibile: false,
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
      illeggibile: false,
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
      illeggibile: false,
    });
  }

  /**
   * Riscrive l'elenco intero, tenendo attivo lo stesso indirizzo.
   *
   * Serve a rimettere in riga gli id quando il database ne restituisce di
   * diversi da quelli salvati: l'attivo non si può inseguire per id, perché è
   * proprio l'id che sta cambiando — si insegue per indirizzo, che è la cosa
   * che l'utente riconosce.
   */
  async function replaceAll(accounts: MailAccount[]) {
    const emailAttiva = state.active?.emailAddress;
    const attivo = accounts.find((a) => a.emailAddress === emailAttiva) ?? accounts[0] ?? null;
    await saveAccounts(accounts, attivo?.id ?? null);
    setState({
      accounts,
      activeId: attivo?.id ?? null,
      loaded: true,
      active: attivo,
      illeggibile: false,
    });
  }

  async function setActive(id: string) {
    const active = state.accounts.find((a) => a.id === id) ?? null;
    await saveAccounts(state.accounts, id);
    setState({ ...state, activeId: id, active });
  }

  return { ...state, addAccount, updateAccount, removeAccount, setActive, refresh, replaceAll };
}
