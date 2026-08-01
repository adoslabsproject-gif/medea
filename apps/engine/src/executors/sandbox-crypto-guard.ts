/**
 * sandbox-crypto-guard — guardia anti-OOM sul bridge `crypto.randomBytes`
 * esposto ai custom node nella sandbox isolated-vm.
 *
 * IL BUCO (audit sandbox 2026-07-10): il bridge `__cryptoRandomBytes(size)`
 * chiama `node:crypto.randomBytes(size)` con `size` CONTROLLATO dal vendor.
 * A differenza degli altri bridge (che ricevono STRINGHE già costruite
 * nell'isolate, quindi limitate dal suo `memoryLimit`), `randomBytes` alloca
 * ex-novo SULL'HOST partendo da un piccolo numero → un custom node malevolo o
 * buggato con `crypto.randomBytes(2_000_000_000)` alloca 2GB nel processo host,
 * BYPASSANDO il `memoryLimit` dell'isolate → OOM/DoS del container runtime.
 *
 * Fix: cap superiore + validazione (intero non-negativo). 64KB è enormemente
 * oltre ogni uso crypto legittimo (nonce/chiavi = decine di byte); un vendor
 * che chiede di più sta abusando, non firmando un payload.
 */

import { randomBytes } from 'node:crypto';

/**
 * Tetto per `crypto.randomBytes` nella sandbox. 64 KiB — un nonce è 12-16 byte,
 * una chiave 32, un salt 16: 64K copre ogni caso reale con enorme margine.
 */
export const MAX_SANDBOX_RANDOM_BYTES = 64 * 1024;

/**
 * `randomBytes` con guardia: valida `size` come intero in `[0, MAX]` PRIMA di
 * allocare sull'host. Fuori range → throw chiaro (il vendor vede l'errore nel
 * suo run, non un OOM silenzioso del container).
 */
export function guardedRandomBytes(size: number): Buffer {
  if (!Number.isInteger(size) || size < 0 || size > MAX_SANDBOX_RANDOM_BYTES) {
    throw new Error(
      `crypto.randomBytes: dimensione ${String(size)} non valida — ammesso un intero in [0, ${String(MAX_SANDBOX_RANDOM_BYTES)}] ` +
      '(guardia anti-OOM della sandbox: allocazioni host oltre questo limite sono rifiutate).',
    );
  }
  return randomBytes(size);
}
