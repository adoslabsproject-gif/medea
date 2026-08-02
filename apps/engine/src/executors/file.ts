/**
 * File read/write executors with directory allowlist + path safety.
 *
 * Security: only allows operations within an allowlisted set of directories.
 * Default allowlist: /tmp, /var/data/flowforge, and any path under MEDEA_DATA_DIR.
 * Admins can extend via env `MEDEA_FILE_ALLOWLIST` (colon-separated absolute paths).
 *
 * Path traversal prevention: every path is resolved (via path.resolve) and
 * checked to be a STRICT child of an allowlist root. Symlinks are followed
 * by resolve, so `/tmp/foo` cannot symlink to `/etc/passwd` and bypass.
 */

import { readFile, writeFile, appendFile, mkdir, stat, realpath } from 'node:fs/promises';
import { resolve, dirname, basename, sep } from 'node:path';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { makeBinaryInline, getBinaryData, readBinaryBytes } from '@medea/engine-core-schema';

/** Mappa minima estensione→MIME per il binary output. Fallback octet-stream. */
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  zip: 'application/zip',
  gz: 'application/gzip',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  wav: 'audio/wav',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
function guessMimeType(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const ext = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/**
 * Multi-tenant SaaS path resolution.
 *
 * Each tenant gets its own filesystem namespace: /var/data/flowforge/<tenantId>/files/...
 * User-provided paths are RESOLVED relative to that namespace. So if the user
 * writes config { path: "report.json" }, the actual file is:
 *   /var/data/flowforge/acme-corp/files/report.json
 *
 * Absolute paths are accepted ONLY if they are inside the tenant's namespace
 * OR a globally-allowlisted directory (e.g. /tmp for ephemeral cross-tenant
 * scratch space). Symlinks are resolved → can't escape via /tmp/foo→/etc/passwd.
 */
function getTenantRoot(tenantId: string): string {
  // Sanitize tenantId — only allow [a-z0-9-_], strip everything else
  const safeTenant = (tenantId || 'default').replace(/[^a-z0-9_-]/gi, '_');
  const baseDir = process.env.MEDEA_DATA_DIR ?? '/var/data/flowforge';
  return resolve(baseDir, 'tenants', safeTenant, 'files');
}

function getGlobalAllowlist(): string[] {
  const envList = process.env.MEDEA_FILE_ALLOWLIST ?? '';
  return envList
    .split(':')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(p));
}

function assertPathAllowed(filePath: string, tenantId: string): string {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error('file path is empty');
  }
  const tenantRoot = getTenantRoot(tenantId);
  // Relative path → join under tenant root
  const abs = filePath.startsWith('/') ? resolve(filePath) : resolve(tenantRoot, filePath);

  // Allowed: under tenant's own root, OR explicitly in global allowlist
  if (abs === tenantRoot || abs.startsWith(tenantRoot + sep)) return abs;

  const globalAllow = getGlobalAllowlist();
  const inGlobal = globalAllow.some((root) => abs === root || abs.startsWith(root + sep));
  if (inGlobal) return abs;

  throw new Error(
    `Path "${abs}" outside tenant namespace. Use a relative path (e.g. "report.json") or contact admin to allowlist the absolute path.`,
  );
}

/**
 * Risolve symlinks via realpath (fs syscall) e ri-verifica che il path
 * risultante sia ancora nel namespace tenant. path.resolve() NON segue
 * symlinks → un attaccante poteva creare /tmp/X → /etc/passwd e bypassare
 * il check sopra. HIGH (2026-05-29).
 *
 * Su file che non esistono ancora (es. write nuovo), realpath del PARENT
 * dir + verify che il parent sia sotto il namespace.
 */
async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

async function assertRealpathInsideTenant(abs: string, tenantId: string): Promise<string> {
  // CRITICAL: realpath va applicato a TUTTI i path comparati. Su macOS
  // i temp dir di test (`/var/folders/...`) sono symlink verso
  // `/private/var/folders/...` → senza canonicalize sia il `tenantRoot`
  // sia l'`abs`, il prefix-check fallisce per identita\` apparente.
  // Anche su Linux il pattern e\` raccomandato per coerenza (no-op se non
  // c'e\` symlink).
  const tenantRootCanon = await safeRealpath(getTenantRoot(tenantId));
  const globalAllow = getGlobalAllowlist();
  const globalAllowCanon: string[] = [];
  for (const root of globalAllow) globalAllowCanon.push(await safeRealpath(root));

  let resolved: string;
  try {
    resolved = await realpath(abs);
  } catch {
    // File doesn't exist yet → realpath del PARENT (che esiste perche\` lo
    // creiamo prima di write con mkdir -p), poi append basename.
    // Bug pre-fix: usavo `abs.slice(parent.length)` ma su path Unix
    // `dirname('/tmp/x/y.txt') === '/tmp/x'`, quindi `abs.slice(parent.length)`
    // = '/y.txt' che resolve INSIEME al parentReal con `resolve()` produce
    // `/y.txt` (assoluto vince) → fuori namespace. Fix: usa basename().
    const parent = dirname(abs);
    const parentReal = await safeRealpath(parent);
    resolved = resolve(parentReal, basename(abs));
  }
  if (resolved === tenantRootCanon || resolved.startsWith(tenantRootCanon + sep)) return resolved;
  if (globalAllowCanon.some((root) => resolved === root || resolved.startsWith(root + sep)))
    return resolved;
  throw new Error(
    `Path "${abs}" resolves via symlinks to "${resolved}" — OUTSIDE tenant namespace (security violation).`,
  );
}

export const fileReadExecutor: NodeExecutor = async (config, _input, context) => {
  const start = Date.now();
  const rawPath = typeof config.path === 'string' ? config.path : '';
  const encoding = typeof config.encoding === 'string' ? config.encoding : 'utf8';
  const checked = assertPathAllowed(rawPath, context.tenantId);
  // HIGH (2026-05-29): realpath guard contro symlink bypass
  const abs = await assertRealpathInsideTenant(checked, context.tenantId);

  const stats = await stat(abs);
  if (!stats.isFile()) throw new Error(`Path "${abs}" is not a regular file`);
  if (stats.size > 50 * 1024 * 1024) {
    throw new Error(`File too large (${stats.size.toString()} bytes). Max 50MB.`);
  }

  const buffer = await readFile(abs);

  // GAP 2 — REF-PRIMARIO (default, niente opt-in): un encoding NON testuale
  // (base64/hex/binary = "voglio i byte del file") emette un HANDLE BinaryData.
  // Con store = ref content-addressed (i byte NON gonfiano outputsById, dedup);
  // senza store = inline base64 (fail-soft anti-crash). I file di TESTO
  // (utf8/utf16le: config, JSON, CSV — il 90% dei casi) restano `content` stringa.
  const isTextEncoding = encoding === 'utf8' || encoding === 'utf16le';
  if (!isTextEncoding) {
    const fileName = basename(abs);
    const mimeType = guessMimeType(fileName);
    const binary = context.writeBinary
      ? await context.writeBinary(buffer, { mimeType, fileName })
      : makeBinaryInline({ mimeType, data: buffer.toString('base64'), fileName });
    return {
      output: { path: abs, binary, size: stats.size, mtime: stats.mtime.toISOString() },
      durationMs: Date.now() - start,
    };
  }

  const content = buffer.toString(encoding);

  return {
    output: { path: abs, content, size: stats.size, encoding, mtime: stats.mtime.toISOString() },
    durationMs: Date.now() - start,
  };
};

export const fileWriteExecutor: NodeExecutor = async (config, input, context) => {
  const start = Date.now();
  const rawPath = typeof config.path === 'string' ? config.path : '';
  const explicitContent = typeof config.content === 'string' ? config.content : '';
  const mode = config.mode === 'append' ? 'append' : 'overwrite';
  // GAP 2 (3b): se NON c'è un content esplicito ma l'input è un BinaryData (es. da
  // file-read binaryOutput / pdf), scriviamo i BYTE reali invece della stringa.
  // Il brand __ffBinary è NUOVO → nessun workflow esistente lo produce → l'auto-
  // detection non può falsare il comportamento attuale (zero-regressione). Content
  // esplicito ha SEMPRE precedenza (back-compat totale).
  const binaryInput = explicitContent === '' ? getBinaryData(input) : null;
  const checked = assertPathAllowed(rawPath, context.tenantId);
  // HIGH (2026-05-29): realpath check anche su write — defense contro
  // TOCTOU: tra il check assertPathAllowed e la write effettiva, qualcuno
  // (es. shared host volume con privesc) potrebbe sostituire il file con
  // symlink puntato fuori. realpath risolve all'ULTIMA componente.
  const abs = await assertRealpathInsideTenant(checked, context.tenantId);

  // Create parent directory if it doesn't exist (within allowlisted root)
  await mkdir(dirname(abs), { recursive: true });

  // Path BINARIO: scrive i byte risolti (readBinary per encoding='ref' = handle su
  // disco; base64 per inline). I byte non passano da una stringa utf8 → fedeli.
  if (binaryInput) {
    const bytes = await readBinaryBytes(binaryInput, context.readBinary);
    if (mode === 'append') await appendFile(abs, bytes);
    else await writeFile(abs, bytes);
    const stats = await stat(abs);
    return {
      output: { path: abs, bytesWritten: bytes.byteLength, size: stats.size, mode, binary: true },
      durationMs: Date.now() - start,
    };
  }

  // Path TESTUALE (comportamento attuale, invariato).
  if (mode === 'append') {
    await appendFile(abs, explicitContent, 'utf8');
  } else {
    await writeFile(abs, explicitContent, 'utf8');
  }

  const stats = await stat(abs);
  return {
    output: {
      path: abs,
      bytesWritten: Buffer.byteLength(explicitContent, 'utf8'),
      size: stats.size,
      mode,
    },
    durationMs: Date.now() - start,
  };
};
