/**
 * LEGACY — cifratura best-effort lato browser usata prima del keychain OS.
 *
 * Oggi le credenziali vivono nel keychain di sistema (comandi Tauri
 * `secret_*`, crate `keyring`). Questo modulo resta SOLO per la migrazione
 * one-shot dei vecchi blob "sealed" salvati in localStorage
 * (vedi `store/account-store.ts`): la chiave era derivata da fingerprint
 * pubblici del device, quindi NON è crittografia affidabile.
 * Da rimuovere quando la migrazione non serve più.
 */

const ENC = new TextEncoder();
const DEC = new TextDecoder();

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    ENC.encode(passphrase) as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: 250_000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function getDevicePassphrase(): string {
  // Combinazione di valori del browser/OS che restano stabili sull'installazione.
  // Non è un segreto crittografico ma è specifico della macchina.
  const parts = [
    navigator.userAgent,
    navigator.language,
    String(screen.width),
    String(screen.height),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  return parts.join('|');
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface SealedBlob {
  v: 1;
  salt: string;
  iv: string;
  ct: string;
}

export async function seal(plainObj: unknown): Promise<SealedBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(getDevicePassphrase(), salt);
  const json = ENC.encode(JSON.stringify(plainObj));
  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, json);
  return { v: 1, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ctBuf)) };
}

export async function open<T = unknown>(blob: SealedBlob): Promise<T> {
  if (blob.v !== 1) throw new Error('Unsupported sealed blob version');
  const salt = unb64(blob.salt);
  const iv = unb64(blob.iv);
  const ct = unb64(blob.ct);
  const key = await deriveKey(getDevicePassphrase(), salt);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ct as BufferSource,
  );
  return JSON.parse(DEC.decode(plainBuf)) as T;
}
