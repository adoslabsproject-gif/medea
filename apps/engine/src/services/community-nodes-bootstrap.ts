/**
 * community-nodes-bootstrap — seed automatico dei community nodes "default"
 * dall'image runtime al data dir tenant al primo boot.
 *
 * Motivazione (2026-05-30): pre-fix, ogni tenant nuovo aveva 0 community
 * nodes installati. L'agente AI Scaffold a quel punto:
 *   1. cercava community_telegram / community_slack / etc.
 *   2. list_node_catalog ritornava empty
 *   3. abortiva con "nodo non disponibile" (hallucinato — vedi abort-gate.ts)
 * Risultato: ogni tenant doveva installarsi i community a mano via UI.
 *
 * Post-fix: l'image Docker contiene i 7 community ufficiali (telegram, slack,
 * github, notion, stripe, linear, discord) in `/app/community-defaults/`.
 * Al boot del container, se il data dir tenant NON ha gia\` quei nodi
 * installati, li copiamo a `/data/installed-nodes/flowforge-community/...`.
 *
 * Layout source (image, read-only):
 *   /app/community-defaults/<vendor-id>/{manifest.json,nodedef.json,executor.js,icon.svg}
 *
 * Layout target (data dir tenant, persistente):
 *   /data/installed-nodes/flowforge-community/<vendor-id>/v<version>/<files>
 *
 * Idempotenza: copiamo SOLO se il target NON esiste gia\`. Cosi\`:
 *   - boot fresco: tutti seedati
 *   - boot con install precedenti: nulla viene sovrascritto
 *   - tenant ha gia\` rimosso un community (uninstall esplicito): non lo re-seedi
 *     (per ora siamo conservativi — re-seed automatico sarebbe sorpresa per l'utente)
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@/lib/logger.js';

/**
 * Letto lazy a ogni chiamata: i test override via env, ed evitiamo capture
 * a module-load time che imprigionano il default.
 */
function sourceDefaultsDir(): string {
  return process.env.FLOWFORGE_COMMUNITY_DEFAULTS_DIR ?? '/app/community-defaults';
}

const FILES_TO_COPY = ['manifest.json', 'nodedef.json', 'executor.js', 'icon.svg'];

interface ManifestMinimal {
  vendor: string;
  id: string;
  version: string;
}

function dataDir(): string {
  const base = process.env.FLOWFORGE_DATA_DIR ?? process.cwd();
  return join(base, 'installed-nodes');
}

async function readManifestMinimal(dir: string): Promise<ManifestMinimal | null> {
  try {
    const raw = await readFile(join(dir, 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw) as { vendor?: unknown; id?: unknown; version?: unknown };
    if (
      typeof parsed.vendor !== 'string' ||
      typeof parsed.id !== 'string' ||
      typeof parsed.version !== 'string'
    ) return null;
    return { vendor: parsed.vendor, id: parsed.id, version: parsed.version };
  } catch {
    return null;
  }
}

export interface SeedResult {
  seeded: string[];
  skipped: string[];
  errors: { vendor: string; error: string }[];
}

/**
 * Copia dal SOURCE i community defaults al data dir, SOLO se target manca.
 * Ritorna report. Non throw — gli errori sono per-package e raccolti.
 */
export async function seedCommunityDefaults(): Promise<SeedResult> {
  const result: SeedResult = { seeded: [], skipped: [], errors: [] };

  if (!existsSync(sourceDefaultsDir())) {
    logger.info({ source: sourceDefaultsDir() }, 'community defaults dir not present in image — skip seeding');
    return result;
  }

  let entries: string[];
  try {
    entries = await readdir(sourceDefaultsDir());
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'community defaults readdir failed');
    return result;
  }

  for (const entry of entries) {
    const srcDir = join(sourceDefaultsDir(), entry);
    const manifest = await readManifestMinimal(srcDir);
    if (!manifest) {
      result.errors.push({ vendor: entry, error: 'manifest.json mancante o invalido' });
      continue;
    }

    const targetDir = join(dataDir(), manifest.vendor, manifest.id, `v${manifest.version}`);

    if (existsSync(targetDir)) {
      result.skipped.push(`${manifest.vendor}/${manifest.id}@${manifest.version}`);
      continue;
    }

    try {
      await mkdir(targetDir, { recursive: true });
      for (const fname of FILES_TO_COPY) {
        const src = join(srcDir, fname);
        if (existsSync(src)) {
          await copyFile(src, join(targetDir, fname));
        }
      }
      result.seeded.push(`${manifest.vendor}/${manifest.id}@${manifest.version}`);
      logger.info({ vendor: manifest.vendor, id: manifest.id, version: manifest.version }, 'community default seeded');
    } catch (err) {
      result.errors.push({
        vendor: `${manifest.vendor}/${manifest.id}`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info(
    { seeded: result.seeded.length, skipped: result.skipped.length, errors: result.errors.length },
    'community defaults seeding completed',
  );
  return result;
}
