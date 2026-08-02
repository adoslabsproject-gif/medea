/**
 * Test REALI per community-nodes-bootstrap. Filesystem vero, no mock,
 * assert su file effettivamente copiati + report.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedCommunityDefaults } from './community-nodes-bootstrap.js';

let sourceDir: string;
let dataDir: string;
const ORIG_ENV = { ...process.env };

function makePackage(parent: string, vendor: string, id: string, version: string): void {
  const dir = join(parent, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ vendor, id, version }));
  writeFileSync(join(dir, 'nodedef.json'), JSON.stringify({ defId: id, label: id }));
  writeFileSync(join(dir, 'executor.js'), `module.exports = { execute(){ return {ok:true} } };`);
  writeFileSync(join(dir, 'icon.svg'), '<svg/>');
}

beforeEach(() => {
  sourceDir = mkdtempSync(join(tmpdir(), 'ff-cnb-src-'));
  dataDir = mkdtempSync(join(tmpdir(), 'ff-cnb-data-'));
  process.env.MEDEA_COMMUNITY_DEFAULTS_DIR = sourceDir;
  process.env.MEDEA_DATA_DIR = dataDir;
});

afterEach(() => {
  if (existsSync(sourceDir)) rmSync(sourceDir, { recursive: true, force: true });
  if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
  process.env = { ...ORIG_ENV };
});

describe('seedCommunityDefaults — happy path', () => {
  it('seed 7 community defaults da source → 7 dir + 4 file ciascuno in data', async () => {
    const vendors = [
      'community_telegram',
      'community_slack',
      'community_github',
      'community_notion',
      'community_stripe',
      'community_linear',
      'community_discord',
    ];
    for (const v of vendors) makePackage(sourceDir, 'flowforge-community', v, '2.0.0');

    const r = await seedCommunityDefaults();

    expect(r.seeded).toHaveLength(7);
    expect(r.skipped).toHaveLength(0);
    expect(r.errors).toHaveLength(0);

    // Verifica filesystem
    for (const v of vendors) {
      const targetDir = join(dataDir, 'installed-nodes', 'flowforge-community', v, 'v2.0.0');
      expect(existsSync(targetDir)).toBe(true);
      expect(existsSync(join(targetDir, 'manifest.json'))).toBe(true);
      expect(existsSync(join(targetDir, 'nodedef.json'))).toBe(true);
      expect(existsSync(join(targetDir, 'executor.js'))).toBe(true);
      expect(existsSync(join(targetDir, 'icon.svg'))).toBe(true);
    }
  });

  it('file copiati hanno il contenuto IDENTICO al source (no corruzione)', async () => {
    makePackage(sourceDir, 'flowforge-community', 'community_telegram', '2.0.0');
    await seedCommunityDefaults();

    const srcManifest = readFileSync(
      join(sourceDir, 'community_telegram', 'manifest.json'),
      'utf8',
    );
    const dstManifest = readFileSync(
      join(
        dataDir,
        'installed-nodes',
        'flowforge-community',
        'community_telegram',
        'v2.0.0',
        'manifest.json',
      ),
      'utf8',
    );
    expect(dstManifest).toBe(srcManifest);
  });
});

describe('seedCommunityDefaults — idempotenza', () => {
  it('seconda esecuzione → tutti skipped, nessun overwrite', async () => {
    makePackage(sourceDir, 'flowforge-community', 'community_telegram', '2.0.0');

    const first = await seedCommunityDefaults();
    expect(first.seeded).toHaveLength(1);

    const second = await seedCommunityDefaults();
    expect(second.seeded).toHaveLength(0);
    expect(second.skipped).toEqual(['flowforge-community/community_telegram@2.0.0']);
  });

  it('user ha modificato manifest in data → seeding NON sovrascrive (rispetto modifiche utente)', async () => {
    makePackage(sourceDir, 'flowforge-community', 'community_telegram', '2.0.0');
    await seedCommunityDefaults();

    const target = join(
      dataDir,
      'installed-nodes',
      'flowforge-community',
      'community_telegram',
      'v2.0.0',
      'manifest.json',
    );
    writeFileSync(target, '{"USER_MODIFIED":true}');

    await seedCommunityDefaults();

    expect(readFileSync(target, 'utf8')).toContain('USER_MODIFIED');
  });
});

describe('seedCommunityDefaults — error handling', () => {
  it('source dir inesistente → ritorna report vuoto (no throw)', async () => {
    process.env.MEDEA_COMMUNITY_DEFAULTS_DIR = '/nonexistent/path/__xyz';
    const r = await seedCommunityDefaults();
    expect(r.seeded).toHaveLength(0);
    expect(r.errors).toHaveLength(0);
  });

  it('package senza manifest.json → errore raccolto, altri continuano', async () => {
    // package ROTTO
    const brokenDir = join(sourceDir, 'community_broken');
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, 'executor.js'), 'broken');
    // package OK
    makePackage(sourceDir, 'flowforge-community', 'community_telegram', '2.0.0');

    const r = await seedCommunityDefaults();
    expect(r.seeded).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.vendor).toBe('community_broken');
  });

  it('manifest con vendor non-string → errore (validation guard)', async () => {
    const d = join(sourceDir, 'community_evil');
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, 'manifest.json'),
      JSON.stringify({ vendor: 42, id: 'x', version: '1.0' }),
    );

    const r = await seedCommunityDefaults();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.vendor).toBe('community_evil');
  });
});

describe('seedCommunityDefaults — versione management', () => {
  it('VERSIONE NUOVA della stessa community: target diverso → seeded', async () => {
    makePackage(sourceDir, 'flowforge-community', 'community_telegram', '2.0.0');
    await seedCommunityDefaults();
    // Upgrade del package source
    rmSync(join(sourceDir, 'community_telegram'), { recursive: true });
    makePackage(sourceDir, 'flowforge-community', 'community_telegram', '3.0.0');

    const r = await seedCommunityDefaults();
    expect(r.seeded).toContain('flowforge-community/community_telegram@3.0.0');
    // Vecchia versione resta installata
    expect(
      existsSync(
        join(dataDir, 'installed-nodes', 'flowforge-community', 'community_telegram', 'v2.0.0'),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(dataDir, 'installed-nodes', 'flowforge-community', 'community_telegram', 'v3.0.0'),
      ),
    ).toBe(true);
  });
});
