/**
 * PEC legal archive — local-filesystem implementation with integrity proof.
 *
 * Why local FS is acceptable for a studio commercialista in 2026
 * ──────────────────────────────────────────────────────────────
 * The legal requirement in Italy (DPR 445/2000, DM 17/06/2014, AgID linee
 * guida 2020) for "conservazione a norma" is:
 *   1. Immutability of the archived document.
 *   2. Verifiable integrity (cryptographic hash).
 *   3. Reliable timestamp (RFC 3161 ideal; UTC ISO acceptable for internal
 *      systems with audit trail).
 *   4. Retention period documented (10 years for fiscal docs).
 *
 * A managed cloud "conservatore accreditato AgID" (Aruba Doc, InfoCert,
 * Namirial) ADDS:
 *   – delegated qualified timestamp
 *   – delegated archive integrity (their hash, their SLA)
 *   – delegated long-term key migration
 *
 * For a local studio, satisfying 1-4 with a write-once filesystem + SHA-256
 * + ISO 8601 timestamp + audit-log JSONL is enough for internal compliance.
 * For B2B clients with explicit qualified-archive requirements, the workflow
 * MUST chain to `action_http` against the conservatore API — this node
 * exposes the metadata needed for that handoff.
 *
 * Pure (deterministic given clock + input + paths). No external network.
 *
 * @module lib/pec/legal-archive
 */

// 2026-06-04 build fix: gli import `node:*` venivano trascinati dal Vite
// bundle del browser editor (import del def via stdlib index) causando
// "node:crypto is not externalized". Refactor a lazy dynamic import dentro
// le funzioni — l'editor browser non esegue mai queste funzioni, ma il
// resolver Vite non vede l'import al top-level → bundle OK.
type CryptoModule = typeof import('node:crypto');
type FsModule = typeof import('node:fs');
type PathModule = typeof import('node:path');
let _crypto: CryptoModule | null = null;
let _fs: FsModule | null = null;
let _path: PathModule | null = null;
async function nodeCrypto(): Promise<CryptoModule> {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- `||` intenzionale per fallback su empty string/zero/false (non solo null/undefined)
  if (!_crypto) _crypto = await import('node:crypto');
  return _crypto;
}
async function nodeFs(): Promise<FsModule['promises']> {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- `||` intenzionale per fallback su empty string/zero/false (non solo null/undefined)
  if (!_fs) _fs = await import('node:fs');
  return _fs.promises;
}
async function nodePath(): Promise<PathModule> {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- `||` intenzionale per fallback su empty string/zero/false (non solo null/undefined)
  if (!_path) _path = await import('node:path');
  return _path;
}

export interface ArchiveInput {
  /** PEC eml / raw message bytes. */
  raw: string | Buffer;
  /** External message id from the IMAP server (Message-ID header). */
  messageId: string;
  /** ISO 8601 timestamp when the message was received. */
  receivedAt: string;
  /** Optional classified type (acceptance / delivery / rejection / message). */
  pecType?: string;
}

export interface ArchiveOptions {
  /** Root directory on the tenant container volume. Default `/data/pec-archive`. */
  archiveDir?: string;
  /** Retention period in days (≥365). Default 3650 = 10 years. */
  conservationDays?: number;
  /** Hash algorithm — sha256/sha384/sha512. */
  hashAlgorithm?: 'sha256' | 'sha384' | 'sha512';
  /** When true, also write `<receiptId>.<alg>` checksum sidecar. Default true. */
  writeSidecar?: boolean;
  /** Inject a custom clock (testing). Defaults to Date. */
  now?: () => Date;
}

export interface ArchiveReceipt {
  archiveId: string;
  archivePath: string;
  hashAlgorithm: string;
  hashHex: string;
  byteLength: number;
  archivedAt: string;
  conservationUntil: string;
  messageId: string;
  pecType: string | null;
  sidecarPath: string | null;
}

const DEFAULT_DIR = '/data/pec-archive';
const DEFAULT_CONSERVATION_DAYS = 3650;

/**
 * Archive a PEC message to the local filesystem with integrity proof.
 *
 * Layout:
 *   <archiveDir>/<YYYY-MM>/<receiptId>.eml
 *   <archiveDir>/<YYYY-MM>/<receiptId>.eml.sha256        (sidecar)
 *   <archiveDir>/manifest.jsonl                          (append-only audit)
 *
 * The `<receiptId>` is the SHA-256 of `messageId+receivedAt` (first 16 hex
 * chars) — deterministic so a second call with the same input is idempotent
 * (overwrites the file but the hash stays the same).
 */
export async function archivePec(
  input: ArchiveInput,
  opts: ArchiveOptions = {},
): Promise<ArchiveReceipt> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
  if (!input || typeof input !== 'object') throw new TypeError('[legal-archive] input required');
  if (!input.messageId) throw new TypeError('[legal-archive] messageId required');
  if (!input.receivedAt) throw new TypeError('[legal-archive] receivedAt required');
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
  if (input.raw === undefined || input.raw === null) {
    throw new TypeError('[legal-archive] raw eml content required');
  }

  const archiveDir = opts.archiveDir ?? DEFAULT_DIR;
  const conservationDays = Math.max(365, opts.conservationDays ?? DEFAULT_CONSERVATION_DAYS);
  const hashAlg = opts.hashAlgorithm ?? 'sha256';
  const now = (opts.now ?? (() => new Date()))();

  const rawBuf = typeof input.raw === 'string' ? Buffer.from(input.raw, 'utf8') : input.raw;
  const fullHash = (await nodeCrypto()).createHash(hashAlg).update(rawBuf).digest('hex');
  // receiptId = SHA-256(messageId+receivedAt) → deterministic for idempotency.
  const receiptId = (await nodeCrypto())
    .createHash('sha256')
    .update(`${input.messageId}|${input.receivedAt}`)
    .digest('hex')
    .slice(0, 16);

  const yyyymm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const dir = (await nodePath()).join(archiveDir, yyyymm);
  await (await nodeFs()).mkdir(dir, { recursive: true });

  const archivePath = (await nodePath()).join(dir, `${receiptId}.eml`);
  await (await nodeFs()).writeFile(archivePath, rawBuf, { mode: 0o600, flag: 'w' });

  let sidecarPath: string | null = null;
  if (opts.writeSidecar !== false) {
    sidecarPath = `${archivePath}.${hashAlg}`;
    await (
      await nodeFs()
    ).writeFile(sidecarPath, `${fullHash}  ${receiptId}.eml\n`, { mode: 0o600, flag: 'w' });
  }

  const archivedAt = now.toISOString();
  const conservationUntil = new Date(now.getTime() + conservationDays * 86_400_000).toISOString();

  const receipt: ArchiveReceipt = {
    archiveId: receiptId,
    archivePath,
    hashAlgorithm: hashAlg,
    hashHex: fullHash,
    byteLength: rawBuf.length,
    archivedAt,
    conservationUntil,
    messageId: input.messageId,
    pecType: input.pecType ?? null,
    sidecarPath,
  };

  // Append to manifest JSONL — operator-readable audit trail. fsync via fd
  // close ensures the line lands on disk before the receipt is returned to
  // the caller (an early crash would otherwise risk a phantom "archived"
  // event without manifest entry).
  const manifestPath = (await nodePath()).join(archiveDir, 'manifest.jsonl');
  const line =
    JSON.stringify({
      ts: archivedAt,
      op: 'archive',
      archiveId: receiptId,
      messageId: input.messageId,
      pecType: input.pecType ?? null,
      byteLength: rawBuf.length,
      hashAlgorithm: hashAlg,
      hashHex: fullHash,
      archivePath,
      conservationUntil,
    }) + '\n';
  const fh = await (await nodeFs()).open(manifestPath, 'a');
  try {
    await fh.appendFile(line, { encoding: 'utf8' });
    await fh.sync();
  } finally {
    await fh.close();
  }

  return receipt;
}

/**
 * Re-compute the hash of a previously archived file and compare to the
 * sidecar. Returns `{ ok: boolean, expectedHash, actualHash }`. The caller
 * decides whether to surface the mismatch as audit warning / hard failure.
 */
export async function verifyArchive(
  archivePath: string,
  hashAlgorithm: 'sha256' | 'sha384' | 'sha512' = 'sha256',
): Promise<{ ok: boolean; expectedHash: string | null; actualHash: string }> {
  const buf = await (await nodeFs()).readFile(archivePath);
  const actualHash = (await nodeCrypto()).createHash(hashAlgorithm).update(buf).digest('hex');
  let expectedHash: string | null = null;
  try {
    const sidecar = await (await nodeFs()).readFile(`${archivePath}.${hashAlgorithm}`, 'utf8');
    expectedHash = sidecar.trim().split(/\s+/)[0] ?? null;
  } catch {
    /* sidecar missing — caller will see expectedHash=null */
  }
  return { ok: expectedHash === actualHash, expectedHash, actualHash };
}
