/**
 * Test E2E (GAP 2, post-flip) — pipeline produttore→consumatore con executor REALI.
 *
 * Differenza da node-binary-ctx.e2e.test.ts (che usa nodi sintetici per provare
 * il plumbing writeBinary/readBinary): QUI girano i VERI executor stdlib
 * (action_file_read, action_file_write, action_xlsx_build, action_xlsx_parse,
 * action_pdf_generate) attraverso il VERO WorkflowEngine + registry server-side
 * + BinaryStore su filesystem reale. È il contratto del flip ref-primario al
 * livello a cui lo vede un workflow utente:
 *   1. il produttore emette `output.binary` = HANDLE encoding='ref' (mai base64);
 *   2. il consumatore a valle risolve l'handle DA SOLO (zero espressioni);
 *   3. i byte fanno round-trip FEDELE (incl. non-utf8: NUL, 0xfe/0xff);
 *   4. il base64 dei byte NON compare MAI negli step serializzati (no memory bloat).
 *
 * NIENTE pdf_parse qui: pdf-parse v1 è content-flaky sul successo e pdf.ts non
 * deve mai convivere con core-schema (fragilità pdfjs) — il routing dei byte di
 * pdf_parse è già provato con failure deterministica nei suoi test dedicati.
 * Payload binari costruiti PROGRAMMATICAMENTE (sorgente puro-ASCII, git-friendly).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { WorkflowEngine } from './workflow-engine.js';
import { BinaryStore } from '@/services/binary-store.service.js';
import { InMemoryEventBus } from '@/adapters/event-bus-memory.js';
import { isBinaryData, type BinaryData, type Workflow } from '@flowforge/core-schema';

// NUL + high bytes — round-trip fedele provabile solo con byte non-utf8.
const PAYLOAD = Buffer.from([0x25, 0x42, 0x49, 0x4e, 0x00, 0x01, 0xfe, 0xff, 0x7f, 0x80]);
const SHA256_HEX = /^[0-9a-f]{64}$/u;

let root = '';
let store: BinaryStore;
let savedDataDir: string | undefined;
let tenantFiles = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'binpipe-'));
  store = new BinaryStore(join(root, 'blobs'));
  savedDataDir = process.env.FLOWFORGE_DATA_DIR;
  // Gli executor file/xlsx risolvono la sandbox tenant da FLOWFORGE_DATA_DIR:
  // <dataDir>/tenants/default/files — la creiamo nel tmpdir isolato del test.
  process.env.FLOWFORGE_DATA_DIR = root;
  tenantFiles = join(root, 'tenants', 'default', 'files');
  await mkdir(tenantFiles, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  if (savedDataDir === undefined) delete process.env.FLOWFORGE_DATA_DIR;
  else process.env.FLOWFORGE_DATA_DIR = savedDataDir;
});

function makeWorkflow(partial: Partial<Workflow>): Workflow {
  return {
    schemaVersion: '1.0.0', id: 'wf-binpipe', name: 'BinPipe', enabled: true,
    nodes: [], edges: [], nodeDefs: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...partial,
  };
}

function makeEngine(): WorkflowEngine {
  // NESSUN nodeRegistry override → registry stdlib REALE; gli executor sono
  // risolti da resolveServerExecutor (gli stessi della produzione).
  return new WorkflowEngine(new InMemoryEventBus(), { binaryStore: store });
}

/** Output (string JSON in RunStep) parsato del nodo `nodeId`. Throw se assente. */
function stepOutput(steps: { nodeId: string; output: string }[], nodeId: string): Record<string, unknown> {
  const step = steps.find((s) => s.nodeId === nodeId);
  if (!step) throw new Error(`step ${nodeId} non trovato`);
  return JSON.parse(step.output) as Record<string, unknown>;
}

describe('🚨 E2E REALE — file_read(binary) → file_write (round-trip byte non-utf8)', () => {
  it('🚨 handle in mezzo, byte fedeli a valle, ZERO base64 negli step', async () => {
    await writeFile(join(tenantFiles, 'in.bin'), PAYLOAD);

    const workflow = makeWorkflow({
      nodes: [
        { id: 'leggi', defId: 'action_file_read', x: 0, y: 0, config: { path: 'in.bin', encoding: 'binary' } },
        { id: 'scrivi', defId: 'action_file_write', x: 1, y: 0, config: { path: 'out.bin' } },
      ],
      edges: [{ from: 'leggi', to: 'scrivi' }],
    });
    const result = await makeEngine().run({ workflow, triggerInput: {} });
    expect(result.status).toBe('success');

    // 1) il produttore ha emesso un HANDLE, non i byte
    const readOut = stepOutput(result.steps, 'leggi');
    const bin = readOut.binary as BinaryData;
    expect(isBinaryData(bin)).toBe(true);
    expect(bin.encoding).toBe('ref');
    expect(bin.ref).toMatch(SHA256_HEX);
    expect(bin.data).toBeUndefined();
    expect(await store.exists(bin.ref!)).toBe(true);

    // 2) il consumatore ha risolto l'handle DA SOLO: byte identici su disco
    const written = await readFile(join(tenantFiles, 'out.bin'));
    expect(written.equals(PAYLOAD)).toBe(true);
    const writeOut = stepOutput(result.steps, 'scrivi');
    expect(writeOut.bytesWritten).toBe(PAYLOAD.byteLength);
    expect(writeOut.binary).toBe(true); // path binario, non quello testuale

    // 3) ANTI-BLOAT: il base64 del payload non compare in NESSUNO step serializzato
    const serialized = result.steps.map((s) => s.output).join('\n');
    expect(serialized).not.toContain(PAYLOAD.toString('base64'));
  });

  it('negativo anti-overreach: encoding utf8 resta `content` stringa, NESSUN handle', async () => {
    await writeFile(join(tenantFiles, 'note.txt'), 'testo semplice', 'utf8');
    const workflow = makeWorkflow({
      nodes: [{ id: 'leggi', defId: 'action_file_read', x: 0, y: 0, config: { path: 'note.txt', encoding: 'utf8' } }],
    });
    const result = await makeEngine().run({ workflow, triggerInput: {} });
    expect(result.status).toBe('success');
    const out = stepOutput(result.steps, 'leggi');
    expect(out.content).toBe('testo semplice');
    expect(out.binary).toBeUndefined();
  });
});

describe('🚨 E2E REALE — xlsx_build → xlsx_parse (round-trip dati strutturati)', () => {
  it('🚨 righe → handle xlsx → righe rilette; il consumatore risolve senza espressioni', async () => {
    // `importo` matcha l'euristica inferFormatFromName → eur_2 e con
    // forceItalianStrings (default true) esce come STRINGA italiana "120,00 €":
    // contratto di produzione DOCUMENTATO, lo pinniamo. `nome` (testo) e `peso`
    // (nessun pattern → auto) round-trippano identici — la fedeltà dei BYTE
    // dell'xlsx attraverso l'handle è provata da questi.
    const rows = [
      { nome: 'Anna', peso: 62.5, importo: 120 },
      { nome: 'Bruno', peso: 81, importo: 45 },
    ];
    const workflow = makeWorkflow({
      nodes: [
        { id: 'costruisci', defId: 'action_xlsx_build', x: 0, y: 0, config: {} },
        { id: 'rileggi', defId: 'action_xlsx_parse', x: 1, y: 0, config: {} },
      ],
      edges: [{ from: 'costruisci', to: 'rileggi' }],
    });
    const result = await makeEngine().run({ workflow, triggerInput: rows });
    expect(result.status).toBe('success');

    const buildOut = stepOutput(result.steps, 'costruisci');
    const bin = buildOut.binary as BinaryData;
    expect(isBinaryData(bin)).toBe(true);
    expect(bin.encoding).toBe('ref');
    expect(bin.data).toBeUndefined();
    expect(buildOut.rowsWritten).toBe(2);

    const parseOut = stepOutput(result.steps, 'rileggi');
    const parsed = parseOut.rows as Record<string, unknown>[];
    expect(parseOut.totalRows).toBe(2);
    expect(parsed.map((r) => r.nome)).toEqual(['Anna', 'Bruno']);
    expect(parsed.map((r) => r.peso)).toEqual([62.5, 81]);
    expect(parsed.map((r) => r.importo)).toEqual(['120,00 €', '45,00 €']);
  });
});

describe('🚨 E2E REALE — pdf_generate → file_write (il PDF arriva su disco via handle)', () => {
  it('🚨 il file scritto È un PDF (%PDF-) e l\'output intermedio è un ref', async () => {
    const workflow = makeWorkflow({
      nodes: [
        {
          id: 'genera', defId: 'action_pdf_generate', x: 0, y: 0,
          config: {
            title: 'Report E2E',
            sectionsJson: '[{"heading":"Sezione","body":"Contenuto di prova"}]',
            filename: 'report-e2e.pdf',
          },
        },
        { id: 'salva', defId: 'action_file_write', x: 1, y: 0, config: { path: 'report.pdf' } },
      ],
      edges: [{ from: 'genera', to: 'salva' }],
    });
    const result = await makeEngine().run({ workflow, triggerInput: {} });
    expect(result.status).toBe('success');

    const genOut = stepOutput(result.steps, 'genera');
    const bin = genOut.binary as BinaryData;
    expect(isBinaryData(bin)).toBe(true);
    expect(bin.encoding).toBe('ref');
    expect(bin.ref).toMatch(SHA256_HEX);
    expect(bin.data).toBeUndefined();
    expect(bin.mimeType).toBe('application/pdf');

    const written = await readFile(join(tenantFiles, 'report.pdf'));
    expect(written.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(written.byteLength).toBeGreaterThan(500); // PDF reale, non stub

    // il blob su store e il file scritto sono gli STESSI byte (fedeltà handle)
    const blobBytes = await store.read(bin.ref!);
    expect(blobBytes.equals(written)).toBe(true);
  });
});
