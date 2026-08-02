#!/usr/bin/env node
/**
 * ffnode-test — esegue i fixture "test-as-data" di un community node in CI.
 *
 * Usage:
 *   ffnode-test <node-entry> <fixtures.(json|js|mjs|ts)>
 *
 *   node-entry : modulo che esporta (default) la CommunityNodeDefinition.
 *   fixtures   : file .json (array di NodeFixture) oppure modulo JS/TS che
 *                esporta (default o `fixtures`) l'array.
 *
 * Per entry/fixtures in TypeScript, lancia via `tsx` (come ffnode-build):
 *   tsx node_modules/.bin/ffnode-test ./src/index.ts ./src/node.fixture.ts
 *
 * Exit code: 0 se tutti i fixture passano, 1 se almeno uno fallisce, 2 su
 * errore d'uso/caricamento → integrabile direttamente in una pipeline CI.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runNodeFixtures, type NodeFixture } from '../fixtures.js';
import type { CommunityNodeDefinition } from '../index.js';

async function importDefault<T>(path: string): Promise<T> {
  const mod = (await import(pathToFileURL(resolve(path)).href)) as Record<string, unknown>;
  return (mod.default ?? mod) as T;
}

async function loadFixtures(path: string): Promise<NodeFixture[]> {
  if (path.endsWith('.json')) {
    return JSON.parse(readFileSync(resolve(path), 'utf8')) as NodeFixture[];
  }
  const mod = (await import(pathToFileURL(resolve(path)).href)) as Record<string, unknown>;
  const arr = (mod.default ?? mod.fixtures) as NodeFixture[] | undefined;
  if (!Array.isArray(arr))
    throw new Error(`Il file fixtures "${path}" deve esportare un array (default o "fixtures")`);
  return arr;
}

async function main(): Promise<void> {
  const [, , entryArg, fixtureArg] = process.argv;
  if (!entryArg || !fixtureArg) {
    console.error('Usage: ffnode-test <node-entry> <fixtures.(json|js|mjs|ts)>');
    process.exit(2);
  }
  const spec = await importDefault<CommunityNodeDefinition>(entryArg);
  const fixtures = await loadFixtures(fixtureArg);
  const summary = await runNodeFixtures(spec, fixtures);

  for (const r of summary.results) {
    if (r.passed) {
      console.log(`  ✓ ${r.name}`);
    } else {
      console.log(`  ✗ ${r.name}\n      ${r.detail.replace(/\n/gu, '\n      ')}`);
    }
  }
  console.log(
    `\n${String(summary.passed)}/${String(summary.total)} fixture passati${summary.failed > 0 ? ` — ${String(summary.failed)} falliti` : ''}`,
  );
  process.exit(summary.failed > 0 ? 1 : 0);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
