/**
 * Test E2E (GAP 2, step 2) — binary I/O cablato nel context degli executor.
 *
 * Prova la catena COMPLETA: WorkflowEngine -> DispatchContext.binaryStore ->
 * NodeExecutorStrategy -> execCtx.{readBinary,writeBinary} -> executor reale,
 * contro un BinaryStore vero (tmpdir). NON mock: lo store scrive/legge file.
 *
 * Proprieta' "superiore a n8n" verificata: l'output del nodo che produce un file
 * e' un BinaryData encoding='ref' (handle), NON i byte base64 -> i byte non
 * entrano in outputsById (zero memory bloat). Il nodo a valle li rilegge via ref.
 *
 * Negativo: senza binaryStore configurato (noop), writeBinary FALLISCE fail-fast.
 *
 * NOTA REVIEW (igiene): i payload binari sono costruiti PROGRAMMATICAMENTE
 * (Buffer.from([...])), MAI byte raw nel sorgente -> il file resta puro-ASCII e
 * git lo tratta come testo (reviewable a git diff/grep), pur testando veri byte
 * non-utf8 (NUL 0x00, high 0xfe/0xff).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { WorkflowEngine } from './workflow-engine.js';
import { BinaryStore } from '@/services/binary-store.service.js';
import { InMemoryEventBus } from '@/adapters/event-bus-memory.js';
import { isBinaryData, type BinaryData } from '@medea/engine-core-schema';
import type { Workflow } from '@medea/engine-core-schema';
import type { NodeExecutionContext } from '@medea/engine-nodes-stdlib';

// NUL 0x00 + high bytes 0xfe/0xff, costruito programmaticamente (sorgente ASCII).
const PAYLOAD = Buffer.from([0x70, 0x61, 0x79, 0x00, 0x01, 0x02, 0xfe, 0xff]);
const SHA256_HEX = /^[0-9a-f]{64}$/u;

function makeWorkflow(partial: Partial<Workflow>): Workflow {
  return {
    schemaVersion: '1.0.0',
    id: 'wf-bin',
    name: 'Bin',
    enabled: true,
    nodes: [],
    edges: [],
    nodeDefs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

function defOf(id: string): {
  id: string;
  label: string;
  kind: 'action';
  category: string;
  inputs: string[];
  outputs: string[];
  configSchema: never;
} {
  return {
    id,
    label: id,
    kind: 'action',
    category: 'test',
    inputs: [],
    outputs: [],
    configSchema: {} as never,
  };
}

let root = '';
let store: BinaryStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'binctx-'));
  store = new BinaryStore(join(root, 'blobs'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("🚨 GAP2 step2 — execCtx.writeBinary/readBinary cablati nell'engine", () => {
  it('🚨 writer produce BinaryData ref (no byte inline) → reader lo rilegge via ref', async () => {
    let writtenBin: BinaryData | undefined;
    let readBack: Buffer | undefined;

    const writer = {
      def: defOf('bin_writer'),
      executor: async (_cfg: unknown, _in: unknown, ctx: NodeExecutionContext) => {
        writtenBin = await ctx.writeBinary!(PAYLOAD, { mimeType: 'text/plain', fileName: 'f.txt' });
        return { output: writtenBin, chosenBranch: undefined };
      },
    };
    const reader = {
      def: defOf('bin_reader'),
      executor: async (_cfg: unknown, input: unknown, ctx: NodeExecutionContext) => {
        const bin = input as BinaryData;
        readBack = await ctx.readBinary!(bin.ref!);
        return { output: { ok: true }, chosenBranch: undefined };
      },
    };

    const engine = new WorkflowEngine(new InMemoryEventBus(), {
      nodeRegistry: [writer as never, reader as never],
      binaryStore: store,
    });
    const workflow = makeWorkflow({
      nodes: [
        { id: 'n1', defId: 'bin_writer', x: 0, y: 0, config: {} },
        { id: 'n2', defId: 'bin_reader', x: 1, y: 0, config: {} },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
    });

    const result = await engine.run({ workflow, triggerInput: {} });
    expect(result.status).toBe('success');

    // 1) il writer ha prodotto un HANDLE, non i byte inline
    expect(writtenBin).toBeDefined();
    expect(isBinaryData(writtenBin)).toBe(true);
    expect(writtenBin!.encoding).toBe('ref');
    expect(writtenBin!.ref).toMatch(SHA256_HEX);
    expect(writtenBin!.data).toBeUndefined(); // niente base64 in outputsById
    expect(writtenBin!.size).toBe(PAYLOAD.byteLength);
    expect(writtenBin!.fileName).toBe('f.txt');

    // 2) il reader ha riletto gli STESSI byte via ref (round-trip su disco reale)
    expect(readBack).toBeDefined();
    expect(readBack!.equals(PAYLOAD)).toBe(true);

    // 3) il blob esiste davvero nello store, indirizzato per contenuto
    expect(await store.exists(writtenBin!.ref!)).toBe(true);
  });

  it('🚨 dedup attraverso i nodi: due writer dello stesso contenuto → 1 solo blob', async () => {
    const w = (id: string) => ({
      def: defOf(id),
      executor: async (_c: unknown, _i: unknown, ctx: NodeExecutionContext) => ({
        output: await ctx.writeBinary!(Buffer.from('same-bytes'), {
          mimeType: 'application/octet-stream',
        }),
        chosenBranch: undefined,
      }),
    });
    const engine = new WorkflowEngine(new InMemoryEventBus(), {
      nodeRegistry: [w('w_a') as never, w('w_b') as never],
      binaryStore: store,
    });
    const workflow = makeWorkflow({
      nodes: [
        { id: 'a', defId: 'w_a', x: 0, y: 0, config: {} },
        { id: 'b', defId: 'w_b', x: 1, y: 0, config: {} },
      ],
      edges: [{ from: 'a', to: 'b' }],
    });
    const result = await engine.run({ workflow, triggerInput: {} });
    expect(result.status).toBe('success');
    expect(await store.list()).toHaveLength(1); // dedup content-addressed
  });

  it("🚨 writeBinaryStream: nodo produce ref da uno STREAM multi-chunk → reader rilegge (writeStream NON e' codice morto)", async () => {
    let bin: BinaryData | undefined;
    let readBack: Buffer | undefined;
    // chunk costruiti programmaticamente (incl. high bytes 0xce/0x94) -> ASCII source
    const chunks = [
      Buffer.from('part-1-'),
      Buffer.from('part-2-'),
      Buffer.from([0xce, 0x94, 0xcf, 0x83]),
    ];
    const full = Buffer.concat(chunks);

    const writer = {
      def: defOf('s_writer'),
      executor: async (_c: unknown, _i: unknown, ctx: NodeExecutionContext) => {
        bin = await ctx.writeBinaryStream!(Readable.from(chunks), {
          mimeType: 'application/octet-stream',
          fileName: 'big.bin',
        });
        return { output: bin, chosenBranch: undefined };
      },
    };
    const reader = {
      def: defOf('s_reader'),
      executor: async (_c: unknown, input: unknown, ctx: NodeExecutionContext) => {
        readBack = await ctx.readBinary!((input as BinaryData).ref!);
        return { output: {}, chosenBranch: undefined };
      },
    };

    const engine = new WorkflowEngine(new InMemoryEventBus(), {
      nodeRegistry: [writer as never, reader as never],
      binaryStore: store,
    });
    const workflow = makeWorkflow({
      nodes: [
        { id: 'n1', defId: 's_writer', x: 0, y: 0, config: {} },
        { id: 'n2', defId: 's_reader', x: 1, y: 0, config: {} },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
    });

    const result = await engine.run({ workflow, triggerInput: {} });
    expect(result.status).toBe('success');
    expect(bin!.encoding).toBe('ref');
    expect(bin!.ref).toMatch(SHA256_HEX);
    expect(bin!.size).toBe(full.byteLength);
    expect(readBack!.equals(full)).toBe(true);
    // content-addressing COERENTE: lo stream produce lo STESSO ref di un writeBuffer
    // dello stesso contenuto -> dedup cross-path (stream vs buffer).
    const viaBuf = await store.writeBuffer(full);
    expect(viaBuf.ref).toBe(bin!.ref);
    expect(viaBuf.deduped).toBe(true); // gia' presente (scritto dallo stream)
  });

  it('🚨 NEGATIVO: senza binaryStore (noop) → writeBinary fallisce fail-fast (no perdita silenziosa)', async () => {
    let caught: Error | undefined;
    const writer = {
      def: defOf('bin_writer'),
      executor: async (_c: unknown, _i: unknown, ctx: NodeExecutionContext) => {
        try {
          await ctx.writeBinary!(Buffer.from('x'), { mimeType: 'text/plain' });
        } catch (e) {
          caught = e as Error;
          throw e;
        }
        return { output: {}, chosenBranch: undefined };
      },
    };
    // engine SENZA binaryStore -> usa noopBinaryStore (fail-fast)
    const engine = new WorkflowEngine(new InMemoryEventBus(), { nodeRegistry: [writer as never] });
    const workflow = makeWorkflow({
      nodes: [{ id: 'n1', defId: 'bin_writer', x: 0, y: 0, config: {} }],
    });
    const result = await engine.run({ workflow, triggerInput: {} });
    expect(result.status).not.toBe('success');
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/non configurato/u);
  });
});
