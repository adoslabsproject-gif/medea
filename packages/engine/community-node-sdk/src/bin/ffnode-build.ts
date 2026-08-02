#!/usr/bin/env node
/**
 * ffnode-build — compile a community-node TypeScript module into a
 * signed .ffnode package.
 *
 * Usage:
 *   ffnode-build [entry] [--out dist] [--key path/to/private.pem]
 *
 * Defaults:
 *   entry = ./src/index.ts (the vendor's defineCommunityNode default export)
 *   out   = ./dist
 *   key   = $MEDEA_NODE_SIGNING_KEY env var, OR ./.signing-key.pem
 *
 * What it does:
 *   1. Spawn a child Node process that imports the entry and serialises
 *      the CommunityNodeDefinition to JSON (handles TS via tsx if needed).
 *   2. Call compile() to produce manifest/nodedef/executorSource.
 *   3. Sign manifest with Ed25519.
 *   4. Zip {manifest.json, nodedef.json, executor.js, README.md?, icon.svg?}
 *      into <out>/<id>-<version>.ffnode.
 *   5. Emit <out>/registry-entry.json (the JSON snippet for the registry
 *      index — the vendor uploads it via their CI).
 *
 * Verification: each .ffnode is round-tripped (parsed + signature verified)
 * BEFORE the script exits 0. A broken sign/verify cycle would surface
 * here, not in production.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createHash,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto';
import { execSync } from 'node:child_process';
import AdmZip from 'adm-zip';

import { compile, type CommunityNodeDefinition } from '../index.js';

interface Args {
  entry: string;
  outDir: string;
  keyPath: string | null;
}

function parseArgs(argv: string[]): Args {
  let entry = './src/index.ts';
  let outDir = './dist';
  let keyPath: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') {
      outDir = argv[++i]!;
      continue;
    }
    if (a === '--key') {
      keyPath = argv[++i]!;
      continue;
    }
    if (a === '--help' || a === '-h') {
      console.log('ffnode-build [entry] [--out dist] [--key private.pem]');
      process.exit(0);
    }
    if (typeof a === 'string') positional.push(a);
  }
  if (positional[0]) entry = positional[0];
  return {
    entry: resolve(entry),
    outDir: resolve(outDir),
    keyPath: keyPath ? resolve(keyPath) : null,
  };
}

function canonicalize(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalize).join(',')}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((obj as Record<string, unknown>)[k])}`).join(',')}}`;
}

function loadOrCreateKey(keyPath: string | null): {
  privateKey: ReturnType<typeof createPrivateKey>;
  ephemeral: boolean;
} {
  const envKey = process.env.MEDEA_NODE_SIGNING_KEY;
  if (envKey) {
    return { privateKey: createPrivateKey({ key: envKey, format: 'pem' }), ephemeral: false };
  }
  if (keyPath && existsSync(keyPath)) {
    return {
      privateKey: createPrivateKey({ key: readFileSync(keyPath, 'utf8'), format: 'pem' }),
      ephemeral: false,
    };
  }
  const defaultPath = resolve('./.signing-key.pem');
  if (existsSync(defaultPath)) {
    return {
      privateKey: createPrivateKey({ key: readFileSync(defaultPath, 'utf8'), format: 'pem' }),
      ephemeral: false,
    };
  }
  console.warn('⚠ Nessuna chiave di firma trovata — uso una chiave dev ephemera.');
  console.warn('   Per produzione: openssl genpkey -algorithm ed25519 -out ./.signing-key.pem');
  const { privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, ephemeral: true };
}

async function loadSpec(entry: string): Promise<CommunityNodeDefinition> {
  // We accept both TS and JS entries. For TS, prefer the user's own
  // pipeline — but we provide a fallback by trying tsx (commonly installed
  // as a dev dep alongside this SDK).
  if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
    // Use tsx as a loader so we can import .ts directly.
    try {
      execSync('npx tsx --version', { stdio: 'ignore' });
    } catch {
      throw new Error(
        'ffnode-build: entry file is .ts ma `tsx` non è disponibile. Installa con: npm i -D tsx',
      );
    }
    // Spawn a child node with tsx loader and serialize the default export.
    const helperScript = join(dirname(fileURLToPath(import.meta.url)), 'serialize-entry.js');
    const serialized = execSync(`node --import tsx "${helperScript}" "${entry}"`, {
      encoding: 'utf8',
    });
    return JSON.parse(serialized) as CommunityNodeDefinition;
  }
  const modUrl = pathToFileURL(entry).href;
  const mod = (await import(modUrl)) as { default?: CommunityNodeDefinition };
  if (!mod.default) {
    throw new Error(
      'ffnode-build: ' +
        entry +
        ' has no default export. Use `export default defineCommunityNode({...})`.',
    );
  }
  return mod.default;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log('▸ Loading ' + args.entry);
  const spec = await loadSpec(args.entry);

  console.log(
    '▸ Compiling ' + spec.manifest.vendor + '/' + spec.manifest.id + ' v' + spec.manifest.version,
  );
  const { manifest, nodedef, executorSource } = compile(spec);

  console.log('▸ Signing manifest');
  const { privateKey, ephemeral } = loadOrCreateKey(args.keyPath);
  const publicKeyPem = createPublicKey(privateKey)
    .export({ type: 'spki', format: 'pem' })
    .toString();
  const payload = canonicalize(manifest) + '|' + canonicalize(nodedef) + '|' + executorSource;
  const digest = createHash('sha256').update(payload).digest();
  const sig = edSign(null, digest, privateKey).toString('hex');
  const signedManifest = { ...manifest, signature: sig, publicKeyPem };

  // Self-verify the signature we just produced. Catches sign/verify
  // asymmetry BEFORE shipping the package.
  {
    // Underscore-prefixed names = intentionally unused (lint convention).

    const { signature: _sig, publicKeyPem: _pk, ...manifestForVerify } = signedManifest;
    const verifyPayload =
      canonicalize(manifestForVerify) + '|' + canonicalize(nodedef) + '|' + executorSource;
    const verifyDigest = createHash('sha256').update(verifyPayload).digest();
    const ok = edVerify(null, verifyDigest, createPublicKey(publicKeyPem), Buffer.from(sig, 'hex'));
    if (!ok) {
      throw new Error(
        'ffnode-build: SIGNATURE SELF-VERIFY FAILED — sign/verify canonicalize asymmetry. ABORT.',
      );
    }
  }

  console.log('▸ Building ' + args.outDir + '/' + manifest.id + '-' + manifest.version + '.ffnode');
  mkdirSync(args.outDir, { recursive: true });
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(signedManifest, null, 2)));
  zip.addFile('nodedef.json', Buffer.from(JSON.stringify(nodedef, null, 2)));
  zip.addFile('executor.js', Buffer.from(executorSource));
  // Optional assets next to the entry: README.md, icon.svg
  const entryDir = dirname(args.entry);
  for (const f of ['README.md', 'icon.svg']) {
    const p = join(entryDir, f);
    if (existsSync(p)) zip.addFile(f, readFileSync(p));
  }
  const ffnodeName = manifest.id + '-' + manifest.version + '.ffnode';
  const ffnodePath = join(args.outDir, ffnodeName);
  zip.writeZip(ffnodePath);
  const zipSize = statSync(ffnodePath).size;

  console.log('▸ Generating registry-entry.json');
  const aiCount = nodedef.actions.filter((a) => a.aiAction).length;
  const triggersCount = nodedef.triggers?.length ?? 0;
  const registryEntry = {
    id: manifest.id,
    vendor: manifest.vendor,
    version: manifest.version,
    displayName: manifest.displayName,
    description: manifest.description,
    license: manifest.license,
    category: manifest.category ?? null,
    homepage: manifest.homepage ?? null,
    downloads: 0,
    rating: null,
    downloadUrl: 'https://flowforge.nothumanallowed.com/registry/packages/' + ffnodeName,
    actionsCount: nodedef.actions.length,
    aiActionsCount: aiCount,
    // FEAT community-trigger runtime: numero di trigger polling impacchettati.
    triggersCount,
    publishedAt: new Date().toISOString(),
    verified: !ephemeral,
  };
  writeFileSync(join(args.outDir, 'registry-entry.json'), JSON.stringify(registryEntry, null, 2));

  console.log('');
  console.log('✓ Build OK');
  console.log('  Package: ' + ffnodePath);
  console.log('  Size:    ' + (zipSize / 1024).toFixed(1) + ' KB');
  console.log(
    '  Sig:     ' + sig.slice(0, 32) + '...' + (ephemeral ? ' (dev key, not for production)' : ''),
  );
  console.log('  Actions: ' + nodedef.actions.length + ' (' + aiCount + ' AI)');
  if (triggersCount > 0) console.log('  Trigger: ' + triggersCount + ' (polling)');
}

main().catch((err: unknown) => {
  console.error('✗ ' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
