/**
 * custom-node-integrity — integrità + autenticità dei pacchetti custom-node
 * pubblicati nel registry community.
 *
 * Problema: quando un tenant installa un nodo dal registry, niente garantisce
 * che `sourceExecutor`/`sourceDefinition`/`sourceSchema` non siano stati
 * MANOMESSI tra publish e install (riga DB alterata, MITM su replica, vendor
 * malevolo che modifica una versione già approvata). Senza verifica, un nodo
 * "approvato" potrebbe eseguire codice diverso da quello revisionato.
 *
 * Difesa a due livelli (entrambi con node:crypto, confronto timing-safe):
 *   1. DIGEST content-addressed (sha256 su serializzazione canonica): rileva
 *      qualunque modifica ai sorgenti. Non richiede segreti → chiunque può
 *      ricalcolarlo e confrontarlo.
 *   2. FIRMA HMAC-SHA256 col secret del registry: garantisce che il record di
 *      integrità sia stato prodotto DAL registry e non forgiato (un attaccante
 *      che altera i sorgenti E ricalcola il digest fallisce comunque la firma
 *      senza il secret). Stesso modello di trust del PORTAL_CALLBACK_TOKEN
 *      condiviso runtime↔portal.
 *
 * PURO: nessun I/O, nessuno stato globale. La serializzazione è length-prefixed
 * (non delimiter-based) → nessuna ambiguità/iniezione tra campi anche se un
 * sorgente contiene i caratteri separatori.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const INTEGRITY_ALGO = 'sha256+hmac-sha256' as const;

/**
 * I campi del pacchetto che definiscono l'identità verificabile del nodo.
 *
 * `compiledExecutor` è NELLA firma: è il bundle che il sandbox ESEGUE davvero
 * (i source_* sono ciò che utente/reviewer vedono). Una firma che coprisse
 * solo i sorgenti lascerebbe l'artefatto eseguito manomettibile senza
 * detection — esattamente il bypass del threat model "riga DB alterata".
 */
export interface CustomNodePackage {
  slug: string;
  semver: string;
  sourceExecutor: string;
  sourceDefinition: string;
  sourceSchema: string;
  compiledExecutor: string;
}

/**
 * Chiave in `system_flags`: settata dal backfill one-time a boot (migrate.ts)
 * quando ogni nodo compilato esistente ha ricevuto digest+firma. Da quel
 * momento il loader BLOCCA i nodi runnable senza record di integrità: un
 * record assente non è più "nodo legacy" ma uno strip-attack (UPDATE che
 * azzera le colonne integrity_* per ricadere nel percorso fail-open).
 */
export const INTEGRITY_ENFORCED_FLAG = 'custom_nodes_integrity_enforced_at';

export interface PackageIntegrity {
  algo: typeof INTEGRITY_ALGO;
  /** sha256 esadecimale della serializzazione canonica del pacchetto. */
  digest: string;
  /** HMAC-SHA256(secret, digest) esadecimale — autenticità del registry. */
  signature: string;
}

export type IntegrityFailureReason =
  | 'digest_mismatch'      // i sorgenti non corrispondono al digest dichiarato (manomissione)
  | 'signature_mismatch'   // firma non valida col secret corrente (forgiata / secret sbagliato)
  | 'algo_unsupported'     // algoritmo non riconosciuto
  | 'malformed';           // record di integrità incompleto

export interface IntegrityVerdict {
  valid: boolean;
  reason?: IntegrityFailureReason;
}

/**
 * Serializzazione CANONICA e deterministica: per ogni campo, in ordine fisso,
 * emette `<len>:<bytes>`. Lunghezza in byte UTF-8 → nessun campo può "sforare"
 * nel successivo (impossibile costruire due pacchetti diversi con la stessa
 * serializzazione).
 */
function canonicalize(pkg: CustomNodePackage): Buffer {
  // Ordine FISSO — non cambiare senza invalidare tutti i digest esistenti.
  const fields: (keyof CustomNodePackage)[] = [
    'slug', 'semver', 'sourceExecutor', 'sourceDefinition', 'sourceSchema', 'compiledExecutor',
  ];
  const parts: Buffer[] = [];
  for (const f of fields) {
    const value = Buffer.from(pkg[f], 'utf8');
    parts.push(Buffer.from(`${f}=${value.length}:`, 'utf8'));
    parts.push(value);
    parts.push(Buffer.from('\n', 'utf8'));
  }
  return Buffer.concat(parts);
}

/** sha256 esadecimale della serializzazione canonica. Puro, no secret. */
export function computePackageDigest(pkg: CustomNodePackage): string {
  return createHash('sha256').update(canonicalize(pkg)).digest('hex');
}

/** HMAC-SHA256(secret, digest) esadecimale. */
function hmacOfDigest(digest: string, secret: string): string {
  return createHmac('sha256', secret).update(digest).digest('hex');
}

/**
 * Produce il record di integrità (digest + firma) per un pacchetto. Da chiamare
 * al momento del publish nel registry, persistendo il risultato con la versione.
 */
export function makePackageIntegrity(pkg: CustomNodePackage, registrySecret: string): PackageIntegrity {
  if (!registrySecret) throw new Error('registrySecret mancante: impossibile firmare il pacchetto.');
  const digest = computePackageDigest(pkg);
  return { algo: INTEGRITY_ALGO, digest, signature: hmacOfDigest(digest, registrySecret) };
}

/** Confronto timing-safe di due hex; false se lunghezze diverse (no leak). */
function safeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Verifica un pacchetto contro il suo record di integrità + il secret del
 * registry. Ricalcola SEMPRE il digest dai sorgenti reali (non si fida del
 * digest dichiarato) → rileva la manomissione anche se il record è coerente
 * internamente ma forgiato.
 *
 * Ordine dei check: malformed → algo → digest (manomissione sorgenti) →
 * signature (autenticità). Il digest prima della firma così un sorgente
 * manomesso dà `digest_mismatch` (causa più utile) invece di `signature_mismatch`.
 */
export function verifyPackageIntegrity(
  pkg: CustomNodePackage,
  integrity: Partial<PackageIntegrity> | null | undefined,
  registrySecret: string,
): IntegrityVerdict {
  if (!integrity || typeof integrity.digest !== 'string' || typeof integrity.signature !== 'string') {
    return { valid: false, reason: 'malformed' };
  }
  if (integrity.algo !== INTEGRITY_ALGO) {
    return { valid: false, reason: 'algo_unsupported' };
  }
  const recomputed = computePackageDigest(pkg);
  if (!safeHexEqual(recomputed, integrity.digest)) {
    return { valid: false, reason: 'digest_mismatch' };
  }
  const expectedSig = hmacOfDigest(integrity.digest, registrySecret);
  if (!safeHexEqual(expectedSig, integrity.signature)) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  return { valid: true };
}
