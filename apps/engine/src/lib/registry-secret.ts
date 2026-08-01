/**
 * registry-secret — UNICA fonte del secret che firma/verifica l'integrità dei
 * pacchetti custom-node (vedi custom-node-integrity.ts).
 *
 * Era duplicato in service.ts e runtime-loader.ts: una divergenza (es. un solo
 * call-site aggiornato a un nuovo env) avrebbe prodotto signature_mismatch su
 * TUTTI i nodi al cold-load. Modulo PURO (solo node:crypto), stesso principio
 * del consolidamento internal-auth (audit #2).
 *
 * ⚠️ INCIDENTE owner 2026-06-12 (Streammy custom node bloccati): il secret NON
 * deve derivare da `FLOWFORGE_INTERNAL_TOKEN` — quello è `randomBytes(32)`
 * RIGENERATO a ogni provisioning/ricreazione del container (onboarding.ts) →
 * cambiava a ogni recreate → tutte le firme dei custom node diventavano
 * `signature_mismatch` → nodi legittimi bloccati dalla sicurezza ("Unknown
 * node def"). Ora il secret è DERIVATO da `FLOWFORGE_SSO_SECRET` (stabile,
 * segreto, sopravvive ai recreate) + tenantId → STABILE nel tempo e per-tenant.
 * I nodi già firmati col vecchio token vengono ri-firmati UNA VOLTA al boot da
 * `migrate.resignCustomNodesWithStableSecret` (azione di sistema gated da flag,
 * SOLO se i sorgenti sono integri rispetto al digest dichiarato — NON un
 * percorso self-heal per-run, che bypasserebbe la firma; vedi runtime-loader).
 */

import { createHmac } from 'node:crypto';

export function registrySecret(): string {
  // 1. Override esplicito (rotation controllata da ops).
  const explicit = process.env.FLOWFORGE_REGISTRY_SECRET;
  if (explicit) return explicit;
  // 2. Derivato STABILE da SSO_SECRET + tenantId (la via normale in prod).
  //    HMAC per-tenant: un tenant non può forgiare il secret di un altro anche
  //    conoscendo il proprio (serve SSO_SECRET, server-side).
  const sso = process.env.FLOWFORGE_SSO_SECRET ?? '';
  const tenant = process.env.FLOWFORGE_TENANT_ID ?? '';
  if (sso.length >= 16 && tenant) {
    return createHmac('sha256', sso).update(`custom-node-registry:${tenant}`).digest('hex');
  }
  // 3. Ultimo fallback (dev/test senza SSO): il vecchio token o vuoto. In prod
  //    SSO_SECRET c'è SEMPRE → non si arriva mai qui.
  return process.env.FLOWFORGE_INTERNAL_TOKEN ?? '';
}
