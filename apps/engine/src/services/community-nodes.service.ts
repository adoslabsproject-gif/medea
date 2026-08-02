/**
 * Community Nodes service — install / uninstall / list third-party nodes.
 *
 * ───── Package format ─────
 *
 * A community node ships as a `.ffnode` file: an ordinary zip archive
 * containing (paths relative to the zip root):
 *
 *   manifest.json     — { id, vendor, version, displayName, description,
 *                          license, homepage?, signature?, publicKeyPem? }
 *   nodedef.json      — A NodeDef object (validated by NodeDefSchema).
 *                       MUST set `vendor` matching manifest.vendor.
 *   executor.js       — ESM source. Must `export default async function
 *                       execute(config, input, context) { ... }` OR
 *                       `module.exports = async function ...` (CJS).
 *                       Runs in an isolated-vm sandbox (Phase 4) so most
 *                       Node APIs are unavailable — only `fetch`, `JSON`,
 *                       `Buffer.from`/`toString`, `setTimeout`, `console`.
 *   icon.svg          — optional, rendered in palette + marketplace card
 *   README.md         — optional, surfaced in the node details panel
 *
 * ───── Storage layout on disk ─────
 *
 *   $MEDEA_DATA_DIR/installed-nodes/<vendor>/<nodeId>/v<version>/
 *     ├── manifest.json
 *     ├── nodedef.json
 *     ├── executor.js
 *     ├── icon.svg
 *     └── README.md
 *
 * Multiple versions of the same node can coexist. The "active" version is
 * the highest semver one with `enabled: true` in the registry.
 *
 * ───── Hot-load ─────
 *
 * On install + on runtime boot, the service scans the directory and pushes
 * every active node into the global NodeRegistry. The marketplace
 * /api/v1/nodes endpoint then exposes them alongside the bundled stdlib.
 *
 * ───── Security ─────
 *
 *   • Manifest signature (Ed25519 over the SHA-256 of manifest|nodedef|
 *     executor) is verified against the vendor's public key. Bad sig →
 *     install rejected.
 *   • Executor runs sandboxed (Phase 4). Bad code can only ruin its own
 *     run — not the runtime, not other tenants' workflows.
 *   • Per-tenant install for the SaaS case: a tenant can install a node
 *     for themselves without affecting others. Self-hosted = global.
 */

import { createHash, verify as cryptoVerify } from 'node:crypto';
import { readBytesCapped } from '@/lib/capped-response.js';
import { mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import * as unzipper from 'unzipper';
import { Readable } from 'node:stream';
import { NodeDefSchema, type NodeDef } from '@medea/engine-core-schema';
import { logger, dedupedWarn, errorFingerprint } from '@/lib/logger.js';

export const ManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/iu),
  vendor: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  displayName: z.string().min(1),
  description: z.string().min(1),
  license: z.string().min(1),
  homepage: z.string().url().optional(),
  /**
   * Ed25519 signature (hex-encoded). Computed over
   *   sha256(canonicalize(manifestWithoutSignature) + nodedef + executor)
   * with the vendor's private key. Verified against publicKeyPem on install.
   */
  signature: z.string().optional(),
  publicKeyPem: z.string().optional(),
  /** ISO 8601 publish timestamp — informational only. */
  publishedAt: z.string().optional(),
  /** Marketplace category (used by the UI). */
  category: z.string().optional(),
});
export type CommunityNodeManifest = z.infer<typeof ManifestSchema>;

export interface InstalledNode {
  manifest: CommunityNodeManifest;
  def: NodeDef;
  executorSource: string;
  iconSvg?: string;
  readmeMd?: string;
  installedAt: string;
  /** Whether the signature was verified successfully. */
  verified: boolean;
  /** Resolved path to the installed directory. */
  storagePath: string;
}

const installedNodes = new Map<string, InstalledNode>(); // key: <vendor>/<id>
/**
 * Index by NodeDef.id → InstalledNode for O(1) lookups from the workflow
 * engine (resolveServerExecutor / resolveCommunityNodeModule). Maintained
 * by install/uninstall + loadInstalledFromDisk — never iterate
 * installedNodes for resolution.
 */
const installedByDefId = new Map<string, InstalledNode>();

function packageKey(vendor: string, id: string): string {
  return `${vendor}/${id}`;
}

function dataDir(): string {
  const base = process.env.MEDEA_DATA_DIR ?? join(process.cwd(), '.flowforge-data');
  return join(base, 'installed-nodes');
}

/**
 * Canonical JSON for signature stability: keys sorted alphabetically,
 * minimal whitespace. Avoids signature failures from cosmetic re-ordering.
 */
function canonicalize(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalize).join(',')}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((obj as Record<string, unknown>)[k])}`).join(',')}}`;
}

interface ExtractedPackage {
  manifest: CommunityNodeManifest;
  def: NodeDef;
  executorSource: string;
  iconSvg?: string | undefined;
  readmeMd?: string | undefined;
}

async function extractZipBuffer(buffer: Buffer): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  const directory = await unzipper.Open.buffer(buffer);
  for (const file of directory.files) {
    if (file.type !== 'File') continue;
    out[file.path] = await file.buffer();
  }
  return out;
}

/**
 * Parse a `.ffnode` zip buffer into typed parts. Throws with a precise
 * error message on missing/invalid files so the caller can surface it.
 */
export async function parsePackage(buffer: Buffer): Promise<ExtractedPackage> {
  const files = await extractZipBuffer(buffer);
  if (!files['manifest.json']) throw new Error('Package invalido: manifest.json mancante');
  if (!files['nodedef.json']) throw new Error('Package invalido: nodedef.json mancante');
  if (!files['executor.js']) throw new Error('Package invalido: executor.js mancante');

  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(files['manifest.json'].toString('utf8'));
  } catch (err) {
    throw new Error(`manifest.json non è JSON valido: ${(err as Error).message}`);
  }
  const manifest = ManifestSchema.parse(manifestRaw);

  let defRaw: unknown;
  try {
    defRaw = JSON.parse(files['nodedef.json'].toString('utf8'));
  } catch (err) {
    throw new Error(`nodedef.json non è JSON valido: ${(err as Error).message}`);
  }
  const def = NodeDefSchema.parse(defRaw);

  if (def.vendor !== manifest.vendor) {
    throw new Error(
      `vendor mismatch: nodedef.vendor="${def.vendor ?? ''}" != manifest.vendor="${manifest.vendor}"`,
    );
  }
  if (def.id !== manifest.id) {
    throw new Error(`id mismatch: nodedef.id="${def.id}" != manifest.id="${manifest.id}"`);
  }
  if (def.version !== manifest.version) {
    throw new Error(
      `version mismatch: nodedef.version="${def.version ?? ''}" != manifest.version="${manifest.version}"`,
    );
  }

  const out: ExtractedPackage = {
    manifest,
    def,
    executorSource: files['executor.js'].toString('utf8'),
  };
  if (files['icon.svg']) out.iconSvg = files['icon.svg'].toString('utf8');
  if (files['README.md']) out.readmeMd = files['README.md'].toString('utf8');
  return out;
}

/**
 * Verify the manifest signature against the embedded publicKeyPem.
 * If no signature/publicKey is present → returns false (unverified, but
 * install still proceeds — UI shows "Unsigned" badge).
 */
export function verifyManifestSignature(pkg: ExtractedPackage): boolean {
  const { manifest, def, executorSource } = pkg;
  if (!manifest.signature || !manifest.publicKeyPem) return false;

  // Strip BOTH signature AND publicKeyPem before re-canonicalizing. The
  // sign side (community-nodes/*/build.mjs) computes its hash over the
  // manifest BEFORE adding either field — they are both content-of-trust
  // metadata, not part of the signed content. Asymmetry between sign/verify
  // here would always-fail valid packages (and that's a bug we caught in
  // the integration test suite — verify was stripping only signature).
  const manifestForVerify = { ...manifest };
  delete manifestForVerify.signature;
  delete manifestForVerify.publicKeyPem;
  const payload = canonicalize(manifestForVerify) + '|' + canonicalize(def) + '|' + executorSource;
  const digest = createHash('sha256').update(payload).digest();
  try {
    return cryptoVerify(
      null,
      digest,
      manifest.publicKeyPem,
      Buffer.from(manifest.signature, 'hex'),
    );
  } catch (err) {
    // Dedup: stesso (vendor, id) può throw N volte in fila se package
    // re-letto in loop. Fingerprint = nome op + vendor + id + error type.
    dedupedWarn(
      errorFingerprint(err, `sigVerify:${manifest.vendor}:${manifest.id}`),
      { err, vendor: manifest.vendor, id: manifest.id },
      'Signature verification threw',
    );
    return false;
  }
}

/**
 * Persist an extracted package to disk and register it in memory.
 * Replaces any existing install of the same vendor/id (downgrades and
 * upgrades both supported).
 */
export async function installFromBuffer(
  buffer: Buffer,
  options?: { skipSignatureCheck?: boolean; requireSignature?: boolean },
): Promise<InstalledNode> {
  const pkg = await parsePackage(buffer);
  const verified = verifyManifestSignature(pkg);
  // Gate firma. skipSignatureCheck (test/dev) bypassa tutto. Altrimenti:
  //   - firma PRESENTE ma non valida → SEMPRE rifiutato (manomissione).
  //   - firma ASSENTE → rifiutato SOLO se requireSignature (es. install da
  //     registry pubblico remoto). Pre-fix l'unsigned passava sempre: per un
  //     canale non fidato è fail-open (stessa classe del bug integrità custom-node).
  if (!verified && !options?.skipSignatureCheck) {
    if (pkg.manifest.signature) {
      throw new Error('Firma manifest non valida — pacchetto rifiutato');
    }
    if (options?.requireSignature) {
      throw new Error(
        'Pacchetto NON firmato — rifiutato su questo canale di install (richiesta firma del publisher)',
      );
    }
  }
  const dir = join(dataDir(), pkg.manifest.vendor, pkg.manifest.id, `v${pkg.manifest.version}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(pkg.manifest, null, 2));
  await writeFile(join(dir, 'nodedef.json'), JSON.stringify(pkg.def, null, 2));
  await writeFile(join(dir, 'executor.js'), pkg.executorSource);
  if (pkg.iconSvg) await writeFile(join(dir, 'icon.svg'), pkg.iconSvg);
  if (pkg.readmeMd) await writeFile(join(dir, 'README.md'), pkg.readmeMd);

  const installed: InstalledNode = {
    manifest: pkg.manifest,
    def: pkg.def,
    executorSource: pkg.executorSource,
    ...(pkg.iconSvg ? { iconSvg: pkg.iconSvg } : {}),
    ...(pkg.readmeMd ? { readmeMd: pkg.readmeMd } : {}),
    installedAt: new Date().toISOString(),
    verified,
    storagePath: dir,
  };
  installedNodes.set(packageKey(pkg.manifest.vendor, pkg.manifest.id), installed);
  installedByDefId.set(pkg.def.id, installed);
  logger.info(
    { vendor: pkg.manifest.vendor, id: pkg.manifest.id, version: pkg.manifest.version, verified },
    'Community node installed',
  );
  return installed;
}

/**
 * Download `.ffnode` from URL (https only) and install.
 *
 * Registry pubblico = codice remoto NON fidato → richiede firma valida del
 * publisher per DEFAULT (fail-closed): un pacchetto non firmato o con firma
 * invalida viene rifiutato. Override esplicito per registry interni/mirror
 * fidati via env `MEDEA_ALLOW_UNSIGNED_REMOTE_NODES=1` o param.
 */
export async function installFromUrl(
  url: string,
  options?: { requireSignature?: boolean },
): Promise<InstalledNode> {
  if (!url.startsWith('https://')) throw new Error('URL deve essere https://');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download fallito: HTTP ${res.status.toString()}`);
  // Cap 50MB IN STREAMING (anti-OOM): prima `res.arrayBuffer()` leggeva l'INTERO body
  // e SOLO DOPO controllava >50MB → il cap era cosmetico, l'OOM avveniva sul read. Ora
  // readBytesCapped lancia DURANTE il download appena supera il limite.
  const buffer = await readBytesCapped(res, 50 * 1024 * 1024);
  if (buffer.length === 0) throw new Error('Download vuoto');
  const requireSignature = options?.requireSignature ?? !allowUnsignedRemoteNodes();
  return installFromBuffer(buffer, { requireSignature });
}

/** Policy: i pacchetti remoti unsigned sono ammessi? Default NO (fail-closed). */
function allowUnsignedRemoteNodes(): boolean {
  const v = process.env.MEDEA_ALLOW_UNSIGNED_REMOTE_NODES;
  return v === '1' || v === 'true';
}

export async function uninstall(vendor: string, id: string): Promise<void> {
  const key = packageKey(vendor, id);
  const entry = installedNodes.get(key);
  if (!entry) throw new Error(`Nodo ${key} non installato`);
  // Remove ALL versions of this node (the entire vendor/id directory).
  const target = resolve(join(dataDir(), vendor, id));
  // Defense in depth: ensure we don't escape the data dir.
  if (!target.startsWith(resolve(dataDir()))) {
    throw new Error('Path traversal rifiutato');
  }
  await rm(target, { recursive: true, force: true });
  installedNodes.delete(key);
  installedByDefId.delete(entry.def.id);
  logger.info({ vendor, id }, 'Community node uninstalled');
}

/**
 * O(1) lookup by NodeDef.id — used by the workflow engine to resolve
 * community-installed nodes during dispatch.
 */
export function getInstalledByDefId(defId: string): InstalledNode | undefined {
  return installedByDefId.get(defId);
}

export function listInstalled(): InstalledNode[] {
  return Array.from(installedNodes.values());
}

export function getInstalled(vendor: string, id: string): InstalledNode | undefined {
  return installedNodes.get(packageKey(vendor, id));
}

/**
 * Scan the data directory on boot and load every installed node into memory.
 * Picks the highest semver version per vendor/id pair.
 */
export async function loadInstalledFromDisk(): Promise<number> {
  const root = dataDir();
  if (!existsSync(root)) return 0;
  let count = 0;
  const vendors = await readdir(root, { withFileTypes: true });
  for (const vendor of vendors) {
    if (!vendor.isDirectory()) continue;
    const vendorDir = join(root, vendor.name);
    const ids = await readdir(vendorDir, { withFileTypes: true });
    for (const id of ids) {
      if (!id.isDirectory()) continue;
      const idDir = join(vendorDir, id.name);
      const versions = await readdir(idDir, { withFileTypes: true });
      const versionDirs = versions
        .filter((v) => v.isDirectory() && v.name.startsWith('v'))
        .map((v) => v.name);
      if (versionDirs.length === 0) continue;
      // Pick highest semver.
      const sorted = versionDirs.sort((a, b) => compareSemver(b.slice(1), a.slice(1)));
      const activeVersionDir = join(idDir, sorted[0]!);
      try {
        const [m, d, e] = await Promise.all([
          readFile(join(activeVersionDir, 'manifest.json'), 'utf8'),
          readFile(join(activeVersionDir, 'nodedef.json'), 'utf8'),
          readFile(join(activeVersionDir, 'executor.js'), 'utf8'),
        ]);
        const manifest = ManifestSchema.parse(JSON.parse(m));
        const def = NodeDefSchema.parse(JSON.parse(d));
        const iconSvg = await readFile(join(activeVersionDir, 'icon.svg'), 'utf8').catch(
          () => undefined,
        );
        const readmeMd = await readFile(join(activeVersionDir, 'README.md'), 'utf8').catch(
          () => undefined,
        );
        const verified = verifyManifestSignature({ manifest, def, executorSource: e });
        const entry: InstalledNode = {
          manifest,
          def,
          executorSource: e,
          ...(iconSvg ? { iconSvg } : {}),
          ...(readmeMd ? { readmeMd } : {}),
          installedAt: (await stat(activeVersionDir)).ctime.toISOString(),
          verified,
          storagePath: activeVersionDir,
        };
        installedNodes.set(packageKey(vendor.name, id.name), entry);
        installedByDefId.set(def.id, entry);
        count += 1;
      } catch (err) {
        // Dedup: community node validation può fallire AD OGNI boot/reload
        // se il package ha configFields broken (ZodError ~5KB). Senza dedup,
        // 50 node broken × 5 reload/giorno = 1.2 MB di log al giorno solo
        // qui. Con dedup TTL 60s: 1 log + 1 summary per fingerprint.
        dedupedWarn(
          errorFingerprint(err, `loadNode:${vendor.name}:${id.name}`),
          { err, vendor: vendor.name, id: id.name },
          'Failed to load installed community node',
        );
      }
    }
  }
  return count;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

// Re-export Readable for the route handler (handle multipart upload form).
export { Readable };
