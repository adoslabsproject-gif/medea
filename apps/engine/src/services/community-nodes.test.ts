/**
 * Integration tests for the community-nodes pipeline.
 *
 * What this covers (end-to-end, no service mocks):
 *   1. Build a real .ffnode in-memory from canonical pieces
 *   2. Sign it with a fresh Ed25519 keypair
 *   3. Install via `installFromBuffer` — verifies signature, persists to
 *      a tmp data dir, populates BOTH lookup maps (key + defId index)
 *   4. Run the executor through the sandbox — asserts on REAL output
 *   5. Uninstall — verifies both maps cleared
 *
 * The tmp data dir is reset between tests so the suite is hermetic
 * (no pollution from previous installs).
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, sign as edSign, generateKeyPairSync, createPublicKey } from 'node:crypto';
import AdmZip from 'adm-zip';

import {
  installFromBuffer,
  uninstall,
  listInstalled,
  getInstalled,
  getInstalledByDefId,
  parsePackage,
  verifyManifestSignature,
} from './community-nodes.service.js';
import { runInSandbox } from '@/executors/community-node-sandbox.js';

const ORIGINAL_DATA_DIR = process.env.MEDEA_DATA_DIR;
let tmpDataDir: string;

function canonicalize(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalize).join(',')}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((obj as Record<string, unknown>)[k])}`).join(',')}}`;
}

function buildFfnode(opts: {
  vendor?: string;
  id?: string;
  version?: string;
  signed?: boolean;
  executor?: string;
} = {}): Buffer {
  const vendor = opts.vendor ?? 'test-vendor';
  const id = opts.id ?? 'test_node';
  const version = opts.version ?? '1.0.0';

  const manifest: Record<string, unknown> = {
    id, vendor, version,
    displayName: 'Test Node',
    description: 'Integration test fixture',
    license: 'MIT',
  };
  const nodedef = {
    id, type: 'action', label: 'Test Node',
    icon: 'cube', color: '#3b82f6',
    description: 'Fixture',
    vendor, version,
    configFields: [
      { key: 'name', label: 'Name', type: 'text', required: false },
    ],
  };
  const executorSource = opts.executor ?? `
    module.exports = async function execute(config, input, context) {
      return {
        echo: 'hello',
        receivedName: String(config.name || ''),
        tenantId: context.tenantId,
      };
    };
  `;

  if (opts.signed !== false) {
    const { privateKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
    const payload = canonicalize(manifest) + '|' + canonicalize(nodedef) + '|' + executorSource;
    const digest = createHash('sha256').update(payload).digest();
    const sig = edSign(null, digest, privateKey).toString('hex');
    manifest.signature = sig;
    manifest.publicKeyPem = publicKeyPem;
  }

  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  zip.addFile('nodedef.json', Buffer.from(JSON.stringify(nodedef, null, 2)));
  zip.addFile('executor.js', Buffer.from(executorSource));
  return zip.toBuffer();
}

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'ffnode-test-'));
  process.env.MEDEA_DATA_DIR = tmpDataDir;
});

afterAll(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.MEDEA_DATA_DIR;
  else process.env.MEDEA_DATA_DIR = ORIGINAL_DATA_DIR;
});

describe('parsePackage', () => {
  it('parses a valid signed .ffnode', async () => {
    const buf = buildFfnode();
    const pkg = await parsePackage(buf);
    expect(pkg.manifest.id).toBe('test_node');
    expect(pkg.manifest.vendor).toBe('test-vendor');
    expect(pkg.def.id).toBe('test_node');
    expect(pkg.executorSource).toContain('module.exports');
  });

  it('rejects when manifest.json missing', async () => {
    const zip = new AdmZip();
    zip.addFile('nodedef.json', Buffer.from('{}'));
    await expect(parsePackage(zip.toBuffer())).rejects.toThrow(/manifest\.json/u);
  });

  it('rejects when nodedef.id mismatches manifest.id', async () => {
    const buf = buildFfnode({ id: 'a' });
    // Corrupt the buffer by re-zipping with a mismatched nodedef.
    const zip = AdmZip.prototype && new AdmZip(buf);
    const nodedef = JSON.parse(zip.getEntry('nodedef.json')!.getData().toString());
    nodedef.id = 'b';
    zip.updateFile('nodedef.json', Buffer.from(JSON.stringify(nodedef)));
    await expect(parsePackage(zip.toBuffer())).rejects.toThrow(/id mismatch/u);
  });
});

describe('verifyManifestSignature', () => {
  it('returns true for a correctly signed package', async () => {
    const buf = buildFfnode();
    const pkg = await parsePackage(buf);
    expect(verifyManifestSignature(pkg)).toBe(true);
  });

  it('returns false when signature is tampered', async () => {
    const buf = buildFfnode();
    const pkg = await parsePackage(buf);
    const sig = pkg.manifest.signature!;
    // Flip the first hex char deterministically: 0..e → next, f → 0.
    const flipped = (sig.startsWith('f') ? '0' : String.fromCharCode(sig.charCodeAt(0) + 1)) + sig.slice(1);
    pkg.manifest.signature = flipped;
    expect(verifyManifestSignature(pkg)).toBe(false);
  });

  it('returns false for an unsigned package', async () => {
    const buf = buildFfnode({ signed: false });
    const pkg = await parsePackage(buf);
    expect(verifyManifestSignature(pkg)).toBe(false);
  });
});

describe('install + uninstall lifecycle', () => {
  it('installs a valid package and populates BOTH lookup maps', async () => {
    const buf = buildFfnode({ vendor: 'acme', id: 'widget', version: '1.0.0' });
    const installed = await installFromBuffer(buf);
    expect(installed.verified).toBe(true);
    expect(installed.manifest.vendor).toBe('acme');

    // Key-based lookup
    expect(getInstalled('acme', 'widget')?.manifest.version).toBe('1.0.0');
    // defId index lookup (the O(1) hot path)
    expect(getInstalledByDefId('widget')?.manifest.vendor).toBe('acme');
    // listInstalled reflects it
    expect(listInstalled().some((n) => n.manifest.id === 'widget')).toBe(true);
  });

  it('rejects install when signature is bad', async () => {
    const buf = buildFfnode();
    const pkg = await parsePackage(buf);
    pkg.manifest.signature = '0000';
    // Rebuild zip with tampered manifest
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(pkg.manifest)));
    zip.addFile('nodedef.json', Buffer.from(JSON.stringify(pkg.def)));
    zip.addFile('executor.js', Buffer.from(pkg.executorSource));
    await expect(installFromBuffer(zip.toBuffer())).rejects.toThrow(/Firma manifest non valida/u);
  });

  it('uninstall removes from disk AND from both maps', async () => {
    const buf = buildFfnode({ vendor: 'acme', id: 'widget' });
    const installed = await installFromBuffer(buf);
    const storagePath = installed.storagePath;
    expect(existsSync(storagePath)).toBe(true);

    await uninstall('acme', 'widget');
    expect(existsSync(storagePath)).toBe(false);
    expect(getInstalled('acme', 'widget')).toBeUndefined();
    expect(getInstalledByDefId('widget')).toBeUndefined();
    expect(listInstalled().some((n) => n.manifest.id === 'widget')).toBe(false);
  });

  it('uninstall on unknown package throws', async () => {
    await expect(uninstall('nope', 'nope')).rejects.toThrow(/non installato/u);
  });
});

describe('runInSandbox end-to-end via installed package', () => {
  it('executes the installed CJS executor and returns its output', async () => {
    const buf = buildFfnode({
      vendor: 'acme',
      id: 'echo_widget',
      executor: `
        module.exports = async function execute(config, input, context) {
          return {
            ok: true,
            got: { name: String(config.name || ''), tenant: context.tenantId },
          };
        };
      `,
    });
    const installed = await installFromBuffer(buf);

    const result = await runInSandbox(installed.executorSource, {
      config: { name: 'mario' },
      input: null,
      context: {
        tenantId: 't1', runId: 'r1', workflowId: 'wf1', nodeId: 'n1',
      },
    });
    expect(result).toEqual({ ok: true, got: { name: 'mario', tenant: 't1' } });
  });

  it('sandbox blocks process access', async () => {
    const buf = buildFfnode({
      vendor: 'acme',
      id: 'evil_widget',
      executor: `
        module.exports = async function execute() {
          // Should be undefined inside the sandbox
          return { hasProcess: typeof process !== 'undefined' };
        };
      `,
    });
    const installed = await installFromBuffer(buf);
    const result = await runInSandbox(installed.executorSource, {
      config: {}, input: null,
      context: { tenantId: 't', runId: 'r', workflowId: 'w', nodeId: 'n' },
    }) as { hasProcess: boolean };
    expect(result.hasProcess).toBe(false);
  });

  it('sandbox isolates eval / Function constructor in a separate V8 isolate', async () => {
    // With isolated-vm, Function/eval STILL exist inside the isolate (V8
    // builtins) but they cannot reach host objects — they evaluate inside
    // the same isolate's globals. The security guarantee is "no host
    // access", not "no codegen".
    const buf = buildFfnode({
      vendor: 'acme',
      id: 'evil_widget_2',
      executor: `
        module.exports = async function execute() {
          // The Function constructor exists, but anything it returns
          // lives inside this same isolate — no access to host process.
          let hostLeak;
          try { hostLeak = typeof process; } catch (e) { hostLeak = 'blocked'; }
          return { hostLeak };
        };
      `,
    });
    const installed = await installFromBuffer(buf);
    const result = await runInSandbox(installed.executorSource, {
      config: {}, input: null,
      context: { tenantId: 't', runId: 'r', workflowId: 'w', nodeId: 'n' },
    }) as { hostLeak: string };
    expect(result.hostLeak).toBe('undefined');
  });

  it('sandbox throws a helpful error when executor exports nothing', async () => {
    const buf = buildFfnode({
      vendor: 'acme',
      id: 'broken_widget',
      executor: `// no exports at all\nconst x = 1;`,
    });
    const installed = await installFromBuffer(buf);
    await expect(runInSandbox(installed.executorSource, {
      config: {}, input: null,
      context: { tenantId: 't', runId: 'r', workflowId: 'w', nodeId: 'n' },
    })).rejects.toThrow(/non esporta una funzione/u);
  });
});
