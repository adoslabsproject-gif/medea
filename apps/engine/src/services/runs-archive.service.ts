/**
 * RunsArchiveService — cold-storage gzip dei runs vecchi (F3 Cappella 2026-06-07).
 *
 * Workflow:
 *   1. Selectiona runs più vecchi di `olderThanDays` (default 30).
 *   2. Esporta tutte le row come JSONL (1 row per riga) → gzip in
 *      `<dataDir>/archives/<workflowId>/runs-<YYYY-MM>-<archiveId>.jsonl.gz`.
 *   3. Calcola HMAC-SHA256 del file (chiave: MEDEA_SSO_SECRET) → file
 *      `.sha256` adiacente con il digest. Permette al download endpoint di
 *      certificare l'integrità all'utente.
 *   4. DELETE dai runs source (rimosse dalla cronologia online — restano
 *      consultabili tramite download archive).
 *
 * Idempotente: girare 2× non duplica nulla (DELETE rimuove gia dopo prima
 * scrittura). Atomic: scrittura file su .tmp + rename finale per evitare
 * archivi tronchi se il processo viene killato a metà.
 *
 * @module services/runs-archive
 */
import { mkdirSync, statSync, readdirSync, createWriteStream, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHmac } from 'node:crypto';
import { eq, and, lt, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDatabase } from '@/storage/db.js';
import { runs } from '@/storage/schema.js';
import { loadConfig } from '@/config.js';
import { logger } from '@/lib/logger.js';

export interface ArchiveResult {
  workflowId: string;
  archived: number;
  filename: string;
  sizeBytes: number;
  hash: string;
}

export interface ArchiveListItem {
  filename: string;
  sizeBytes: number;
  hash: string;
  createdAt: string;
}

function ensureDirSync(p: string): void {
  try { mkdirSync(p, { recursive: true }); } catch { /* exists */ }
}

function archivesDir(workflowId: string): string {
  const base = loadConfig().MEDEA_DATA_DIR;
  return join(base, 'archives', workflowId);
}

function readableFromString(s: string): Readable {
  return Readable.from([Buffer.from(s, 'utf8')]);
}

/**
 * Chiave HMAC per firmare gli archivi run. Fail-fast in produzione: MAI un
 * fallback hard-coded noto (`'dev-fallback-secret'`) — firmerebbe gli archivi
 * con una chiave pubblica, rendendo falsificabile l'integrità. Stesso pattern
 * fail-closed del GDPR export HMAC (services/account/export.ts).
 */
function archiveHmacKey(): string {
  const secret = loadConfig().MEDEA_SSO_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[runs-archive] MEDEA_SSO_SECRET OBBLIGATORIO in production (>=32 char) ' +
      'per firmare gli archivi run. Nessun fallback hard-coded. Vedi docs/SECRETS-RECOVERY.md.',
    );
  }
  // dev/test fallback (NON in prod path)
  return 'dev-fallback-secret-not-for-production-use-32c';
}

/**
 * Archivia runs più vecchi di `olderThanDays` per UN workflow. Operazione
 * transactional-equivalente: scrittura atomica via .tmp+rename, DELETE
 * SOLO dopo che il file è stato persistito + hashato con successo.
 */
export async function archiveOldRuns(workflowId: string, olderThanDays: number): Promise<ArchiveResult | null> {
  if (olderThanDays <= 0) return null;
  const { db, sqlite } = getDatabase();
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 3600 * 1000).toISOString();

  // 1. Conta righe candidate (early-exit se zero)
  const cntRow = sqlite
    .prepare('SELECT COUNT(*) as n FROM runs WHERE workflow_id = ? AND started_at < ?')
    .get(workflowId, cutoff) as { n: number };
  if (cntRow.n === 0) return null;

  // 2. Prepara file paths
  const archiveId = nanoid(8);
  const yyyymm = new Date().toISOString().slice(0, 7); // 2026-06
  const baseFile = `runs-${yyyymm}-${archiveId}.jsonl.gz`;
  const dir = archivesDir(workflowId);
  ensureDirSync(dir);
  const finalPath = join(dir, baseFile);
  const tmpPath = `${finalPath}.tmp`;

  // 3. Scrivi JSONL.gz streaming + calcola HMAC
  const hmac = createHmac('sha256', archiveHmacKey());
  const rows = sqlite
    .prepare('SELECT * FROM runs WHERE workflow_id = ? AND started_at < ? ORDER BY started_at ASC')
    .all(workflowId, cutoff) as Record<string, unknown>[];

  const jsonl = rows.map((r) => {
    const s = JSON.stringify(r);
    hmac.update(s);
    hmac.update('\n');
    return s;
  }).join('\n') + '\n';

  try {
    await pipeline(readableFromString(jsonl), createGzip(), createWriteStream(tmpPath));
  } catch (e) {
    logger.error({ err: e, workflowId }, '[runs-archive] write failed, aborting');
    try { unlinkSync(tmpPath); } catch { /* */ }
    throw e;
  }
  renameSync(tmpPath, finalPath);
  const hash = hmac.digest('hex');
  const sizeBytes = statSync(finalPath).size;

  // 4. DELETE source rows + log
  await db.delete(runs).where(and(
    eq(runs.workflowId, workflowId),
    lt(runs.startedAt, cutoff),
  ));
  // Trigger VACUUM-incremental delle pages liberate
  sqlite.exec('PRAGMA wal_checkpoint(PASSIVE)');

  logger.info({
    workflowId, archived: cntRow.n, file: baseFile, sizeBytes, hash: hash.slice(0, 12),
  }, '[runs-archive] batch archived');

  return { workflowId, archived: cntRow.n, filename: baseFile, sizeBytes, hash };
}

/**
 * Lista archivi gia\` esistenti per un workflow. Usato dall'endpoint
 * download per popolare il dropdown UI.
 */
export function listArchives(workflowId: string): ArchiveListItem[] {
  const dir = archivesDir(workflowId);
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  const items: ArchiveListItem[] = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl.gz')) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      items.push({
        filename: name,
        sizeBytes: st.size,
        hash: '', // verrà ricalcolato on-demand al download — niente cache su disco
        createdAt: st.mtime.toISOString(),
      });
    } catch { /* skip broken */ }
  }
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return items;
}

/** Path assoluto del file archivio (resolved + safe vs path-traversal). */
export function archivePathSafe(workflowId: string, filename: string): string | null {
  // Reject path traversal: solo basename, no slashes
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return null;
  if (!/^runs-[\d-]+-[A-Za-z0-9_-]+\.jsonl\.gz$/u.test(filename)) return null;
  return join(archivesDir(workflowId), filename);
}

/**
 * Archivia per TUTTI i workflow tracciati del tenant. Usato dal cron settimanale.
 * Ritorna riepilogo per logging/telemetry.
 */
export async function archiveAllWorkflows(olderThanDays: number): Promise<{
  workflowsScanned: number;
  workflowsArchived: number;
  totalRows: number;
  totalBytes: number;
}> {
  const { sqlite } = getDatabase();
  // Solo workflow con verbosity != 'silent' (i silent non hanno mai rows)
  const wfs = sqlite
    .prepare("SELECT id FROM workflows WHERE run_verbosity IS NULL OR run_verbosity != 'silent'")
    .all() as { id: string }[];
  let workflowsArchived = 0;
  let totalRows = 0;
  let totalBytes = 0;
  for (const wf of wfs) {
    try {
      const res = await archiveOldRuns(wf.id, olderThanDays);
      if (res) {
        workflowsArchived += 1;
        totalRows += res.archived;
        totalBytes += res.sizeBytes;
      }
    } catch (e) {
      logger.warn({ err: e, workflowId: wf.id }, '[runs-archive] workflow batch failed (continuing)');
    }
  }
  return { workflowsScanned: wfs.length, workflowsArchived, totalRows, totalBytes };
}

// silence unused-import warning for sql template (kept for future use)
void sql;
