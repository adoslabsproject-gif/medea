/**
 * I segreti dei workflow: API key, password, chiavi private.
 *
 * Il valore sta nel **portachiavi del sistema operativo**, mai nel documento
 * e mai nel database. Nel workflow resta solo il riferimento
 * `{{secrets.NOME}}`, che è esattamente ciò che rende un workflow
 * esportabile senza portarsi via le credenziali.
 *
 * Qui Medea fa meglio dell'originale, dove le variabili del tenant stanno in
 * chiaro nel database nonostante i commenti dichiarino il contrario.
 *
 * I **nomi** invece non sono segreti — servono a mostrare l'elenco e a sapere
 * cosa consegnare al runtime — e stanno accanto alle altre preferenze.
 */

import { secretsApi } from '../../secrets/api';

/** Dove si tiene l'elenco dei nomi. I valori no: quelli sono nel portachiavi. */
const NAMES_KEY = 'medea.workflows.secretNames';

/** La chiave con cui un segreto sta nel portachiavi. */
function keychainKey(name: string): string {
  return `workflow.secret.${name}`;
}

/** Un nome utilizzabile in `{{secrets.NOME}}`: lettere, cifre, trattino basso. */
export function normalizeSecretName(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function secretNames(): string[] {
  try {
    const raw = localStorage.getItem(NAMES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

function rememberName(name: string): void {
  const names = secretNames();
  if (!names.includes(name)) {
    localStorage.setItem(NAMES_KEY, JSON.stringify([...names, name].sort()));
  }
}

function forgetName(name: string): void {
  localStorage.setItem(NAMES_KEY, JSON.stringify(secretNames().filter((n) => n !== name)));
}

export async function setSecret(rawName: string, value: string): Promise<string> {
  const name = normalizeSecretName(rawName);
  if (!name) throw new Error('Il nome del segreto non può essere vuoto.');
  await secretsApi.set(keychainKey(name), value);
  rememberName(name);
  return name;
}

export async function deleteSecret(name: string): Promise<void> {
  await secretsApi.delete(keychainKey(name));
  forgetName(name);
}

/** Vero quando il segreto ha davvero un valore nel portachiavi. */
export async function hasSecret(name: string): Promise<boolean> {
  return Boolean(await secretsApi.get(keychainKey(name)));
}

/**
 * Tutti i segreti, valori compresi.
 *
 * Li legge solo chi deve consegnarli al runtime. Un nome rimasto nell'elenco
 * senza valore nel portachiavi — cancellato a mano, portachiavi ripristinato —
 * viene saltato invece di consegnare una stringa vuota che a runtime
 * fallirebbe in modo incomprensibile.
 */
export async function allSecrets(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of secretNames()) {
    const value = await secretsApi.get(keychainKey(name));
    if (value) out[name] = value;
  }
  return out;
}
