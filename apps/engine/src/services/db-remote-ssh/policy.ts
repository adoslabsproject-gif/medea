/**
 * Policy di sicurezza per la connessione a DB ESTERNI via tunnel SSH
 * (lettura "alla DBeaver", livello che n8n non raggiunge).
 *
 * Questo modulo è PURO e deterministico: contiene le decisioni di sicurezza —
 * NON apre socket. Il layer live (ssh2 + adapter) le applica prima di
 * connettersi. Separarle qui le rende testabili al 100% e impedisce che una
 * scorciatoia futura nel codice di rete bypassi una regola.
 *
 * Le 5 regole d'oro (ognuna è il punto dove n8n & co. tipicamente sbagliano):
 *  1. HOST-KEY PINNING OBBLIGATORIO: niente Trust-On-First-Use, niente
 *     accept-any. Senza fingerprint atteso → rifiuto. (anti-MITM)
 *  2. SSRF GUARD sull'host SSH: un IP privato/riservato/metadata (10/8,
 *     127/8, 169.254.169.254, ::1, fc00::/7…) è bloccato → niente pivot nella
 *     nostra rete interna. Gli hostname richiedono la verifica DNS al connect.
 *  3. SOLO PORT-FORWARD: l'SSH serve esclusivamente per il forward TCP verso il
 *     DB; nessun canale exec/shell (deciso dal layer live; qui non esiste alcun
 *     campo "command").
 *  4. SEGRETI SOLO PER RIFERIMENTO: chiave privata/passphrase/password vivono
 *     nel vault cifrato per-tenant; nel config viaggiano solo i `*SecretRef`.
 *  5. READ-ONLY ENFORCED: la query eseguita sul DB remoto è classificata
 *     (engine, fold al kind peggiore) e ammessa solo se SELECT/EXPLAIN.
 *
 * @module services/db-remote-ssh/policy
 */
import { z } from 'zod';
import { validateIpForFetch, isIP } from '@medea/engine-safe-fetch';
import { classifyStatement, assertSafeRawStatement } from '@medea/engine-db-studio-engine';

export class SshPolicyError extends Error {
  constructor(readonly code: 'HOST_KEY' | 'SSH_HOST_BLOCKED' | 'READ_ONLY' | 'CONFIG', message: string) {
    super(message);
    this.name = 'SshPolicyError';
  }
}

// Fingerprint host-key: accetta forma OpenSSH "SHA256:base64" o hex con ':'.
const FINGERPRINT_RE = /^(SHA256:)?[A-Za-z0-9+/=:]{16,}$/i;

const SshAuthSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('key'),
    privateKeySecretRef: z.string().min(1),
    passphraseSecretRef: z.string().min(1).optional(),
  }).strict(),
  z.object({
    method: z.literal('password'),
    passwordSecretRef: z.string().min(1),
  }).strict(),
]);

export const SshDbConnectionConfigSchema = z
  .object({
    ssh: z
      .object({
        host: z.string().min(1).max(255),
        port: z.number().int().min(1).max(65535).default(22),
        user: z.string().min(1).max(255),
        // Pinning OBBLIGATORIO: nessun default, nessun "accetta qualsiasi".
        hostKeyFingerprint: z.string().regex(FINGERPRINT_RE, 'fingerprint host-key non valido (atteso SHA256:… )'),
        auth: SshAuthSchema,
      })
      .strict(),
    db: z
      .object({
        engine: z.enum(['postgres', 'mysql', 'mssql']),
        host: z.string().min(1).max(255),
        port: z.number().int().min(1).max(65535),
        database: z.string().min(1).max(255),
        userSecretRef: z.string().min(1).optional(),
        passwordSecretRef: z.string().min(1).optional(),
      })
      .strict(),
    readOnly: z.boolean().default(true),
  })
  .strict();

export type SshDbConnectionConfig = z.infer<typeof SshDbConnectionConfigSchema>;

/** Parse + validazione del config. @throws SshPolicyError('CONFIG'). */
export function parseSshDbConfig(raw: unknown): SshDbConnectionConfig {
  const parsed = SshDbConnectionConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new SshPolicyError('CONFIG', `Config SSH/DB non valido — ${msg}`);
  }
  return parsed.data;
}

export type SshHostVerdict =
  | { kind: 'ip-allowed' }
  | { kind: 'ip-blocked'; reason: string }
  | { kind: 'hostname-needs-dns' };

/**
 * Classifica l'host SSH (PURO): un IP letterale privato/riservato è bloccato;
 * un IP pubblico è ammesso; un hostname richiede la verifica DNS-aware al
 * connect (il layer live risolve e ri-applica validateIpForFetch su OGNI IP
 * risolto — difesa anti DNS-rebinding).
 */
export function classifySshHost(host: string): SshHostVerdict {
  const h = host.trim();
  if (isIP(h) !== 0) {
    const res = validateIpForFetch(h);
    return res.ok ? { kind: 'ip-allowed' } : { kind: 'ip-blocked', reason: res.reason ?? 'BLOCKED_PRIVATE_IP' };
  }
  return { kind: 'hostname-needs-dns' };
}

/** Variante throw per l'uso nel flusso di connect. @throws SshPolicyError('SSH_HOST_BLOCKED'). */
export function assertSshHostAllowed(host: string): SshHostVerdict {
  const v = classifySshHost(host);
  if (v.kind === 'ip-blocked') {
    throw new SshPolicyError('SSH_HOST_BLOCKED', `Host SSH "${host}" è un indirizzo privato/riservato (${v.reason}): bloccato per prevenire pivot nella rete interna.`);
  }
  return v;
}

/**
 * Enforce read-only sulla query verso il DB remoto.
 * @throws SshPolicyError('READ_ONLY') se non è SELECT/EXPLAIN o usa verbi non sicuri.
 */
export function assertReadOnlyQuery(sql: string): void {
  const kind = classifyStatement(sql);
  if (kind !== 'select' && kind !== 'explain') {
    throw new SshPolicyError('READ_ONLY', `La connessione SSH-DB è in sola lettura: ammessi solo SELECT/EXPLAIN (statement classificato "${kind}").`);
  }
  try {
    assertSafeRawStatement(sql);
  } catch (e) {
    throw new SshPolicyError('READ_ONLY', e instanceof Error ? e.message : 'statement non consentito');
  }
}

/** Elenco dei riferimenti-segreto che il vault DEVE risolvere prima del connect. */
export function secretRefsOf(config: SshDbConnectionConfig): string[] {
  const refs: string[] = [];
  if (config.ssh.auth.method === 'key') {
    refs.push(config.ssh.auth.privateKeySecretRef);
    if (config.ssh.auth.passphraseSecretRef) refs.push(config.ssh.auth.passphraseSecretRef);
  } else {
    refs.push(config.ssh.auth.passwordSecretRef);
  }
  if (config.db.userSecretRef) refs.push(config.db.userSecretRef);
  if (config.db.passwordSecretRef) refs.push(config.db.passwordSecretRef);
  return refs;
}
