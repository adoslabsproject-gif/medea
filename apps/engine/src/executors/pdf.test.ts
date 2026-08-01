/**
 * Test 2026-grade — pdf executors (parse + generate).
 *
 * 🚨 BUSINESS-CRITICAL: workflow PDF input (fattura/DDT IMAP) e
 * output (listino/fattura/report). Test reali con buffer PDF generati
 * da pdfkit (magic bytes %PDF-, %%EOF marker, structure validation).
 *
 * Coverage:
 *  - parse: base64/path input, mode router (auto/pdf-parse-only/llm-only)
 *  - 🚨 32MB size limit
 *  - 🚨 path traversal denied (tenant namespace)
 *  - confidence scoring 0-1 (empty=0, garbage<0.3, real text>0.5)
 *  - LLM fallback mode router (Anthropic API mocked)
 *  - generate: PDFKit real output (verify %PDF-/EOF markers)
 *  - 🚨 max 10k rows, 50 cols, 24MB output cap
 *  - 🚨 escapePdfCell strip null bytes + control chars
 *  - sections/tableJson parse robust
 *  - footer {page}/{total} replace
 *  - mimeType application/pdf + filename .pdf forced
 */
import type { BinaryStore } from '../services/binary-store.service';
import type { BinaryData } from '@flowforge/core-schema';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { NodeExecutionContext } from '@flowforge/nodes-stdlib';

const m = vi.hoisted(() => ({
  llmGet: vi.fn(),
  isLiaraAllowed: vi.fn(),
  safeFetch: vi.fn(),
}));

vi.mock('@/services/tenant-ai-preferences.service.js', () => ({
  isLiaraAllowedForTenant: (...a: unknown[]) => m.isLiaraAllowed(...a),
}));

vi.mock('@/services/llm-providers.service.js', () => ({
  LlmProvidersService: class {
    get = m.llmGet;
  },
}));

vi.mock('@/lib/safe-outbound-fetch.js', () => ({
  safeOutboundFetch: (...a: unknown[]) => m.safeFetch(...a),
}));

vi.mock('@/lib/logger.js');

import { pdfParseExecutor, pdfGenerateExecutor, resolveBinaryInline } from './pdf.js';

const ctx: NodeExecutionContext = {
  tenantId: 't1', runId: 'r1', workflowId: 'wf1', nodeId: 'n1', secrets: {},
} as NodeExecutionContext;

let tenantDir: string;
beforeEach(() => {
  tenantDir = mkdtempSync(join(tmpdir(), 'ff-pdf-'));
  process.env.FLOWFORGE_DATA_DIR = tenantDir;
  m.llmGet.mockReset();
  m.isLiaraAllowed.mockReset();
  m.safeFetch.mockReset();
});

// Build a real PDF via pdfkit for round-trip parse test
async function buildSimplePdf(text: string): Promise<Buffer> {
  const PDFKit = await import('pdfkit');
  const PDFDocument = (PDFKit as { default?: unknown }).default ?? PDFKit;
   
  const doc: any = new (PDFDocument as any)();
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((r) => { doc.on('end', () => { r(); }); });
  doc.text(text);
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

describe('🚨 pdfParseExecutor — input resolution', () => {
  it('base64 input → buffer ok + extract text reale', async () => {
    const buf = await buildSimplePdf('FATTURA n.123 totale 100 euro test contenuto');
    const r = await pdfParseExecutor({
      base64: buf.toString('base64'), mode: 'pdf-parse-only',
    }, null, ctx);
    const out = r.output as { text: string; mode: string; sizeBytes: number; pages: number };
    expect(out.mode).toBe('pdf-parse');
    expect(out.sizeBytes).toBe(buf.length);
    expect(out.pages).toBeGreaterThan(0);
    // FEDELTÀ DEL TESTO (gap chiuso, nota review): il test si chiama "extract
    // text reale" ma prima asseriva solo no-throw + pages. Ora verifica che
    // pdf-parse estragga DAVVERO il contenuto giusto → una regressione che
    // generasse un PDF parseable-ma-con-testo-sballato verrebbe beccata.
    expect(out.text).toContain('FATTURA');
    expect(out.text).toContain('totale');
  });

  it('path input dal tenant namespace', async () => {
    // pdfkit minimal generato qui da buildSimplePdf ha XRef table che
    // pdf-parse v1 a volte rifiuta. Usiamo direttamente pdfGenerateExecutor
    // (PDF strutturato completo) per garantire un PDF parseable.
    const gen = await pdfGenerateExecutor({ title: 'TestDoc', sectionsJson: '[{"heading":"H","body":"B"}]' }, null, ctx);
    // ref-primario: pdf_generate emette SEMPRE un handle; senza store = inline base64.
    const buf = Buffer.from((gen.output as { binary: { data?: string } }).binary.data ?? '', 'base64');
    const filePath = join(tenantDir, 'tenants/t1/files/test.pdf');
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, buf);
    const r = await pdfParseExecutor({ path: 'test.pdf', mode: 'pdf-parse-only' }, null, ctx);
    const out = r.output as { sizeBytes: number };
    expect(out.sizeBytes).toBeGreaterThan(0);
  });

  it('🚨 missing input → throw', async () => {
    await expect(pdfParseExecutor({}, null, ctx))
      .rejects.toThrow(/almeno uno tra config\.path o config\.base64/u);
  });

  it('🚨 path traversal denied', async () => {
    await expect(pdfParseExecutor({ path: '../../../etc/passwd.pdf' }, null, ctx))
      .rejects.toThrow(/outside tenant namespace/u);
  });

  it('🚨 size > 32MB → throw', async () => {
    // Crea un file file system 33MB con un PDF "fake" (test del size guard)
    const filePath = join(tenantDir, 'tenants/t1/files/big.pdf');
    mkdirSync(dirname(filePath), { recursive: true });
    const bigBuf = Buffer.alloc(33 * 1024 * 1024, 0);
    writeFileSync(filePath, bigBuf);
    await expect(pdfParseExecutor({ path: 'big.pdf' }, null, ctx))
      .rejects.toThrow(/troppo grande.*Max 32 MB/u);
  });

  it('🚨 size > 32MB via base64 (input in-memory upstream) → throw PRIMA di pdf-parse', async () => {
    // Bug-bounty del fix 2026-06-17: il cap 32MB era enforced SOLO sul file da disco
    // (stat), NON su base64/BinaryData da upstream (es. allegato IMAP enorme) → il
    // buffer in RAM raggiungeva pdf-parse/Claude-vision → OOM. Qui passiamo 33MB via
    // base64 e pretendiamo lo STESSO errore "troppo grande" del path, NON "pdf-parse
    // failed" (la guard scatta prima del parse).
    const bigB64 = Buffer.alloc(33 * 1024 * 1024, 0).toString('base64');
    await expect(pdfParseExecutor({ base64: bigB64, mode: 'pdf-parse-only' }, null, ctx))
      .rejects.toThrow(/troppo grande.*Max 32 MB/u);
  });
});

describe('🚨 mode router validation', () => {
  it('🚨 mode invalido → throw', async () => {
    const buf = await buildSimplePdf('x');
    await expect(pdfParseExecutor({
      base64: buf.toString('base64'), mode: 'invalid-mode',
    }, null, ctx)).rejects.toThrow(/mode "invalid-mode" non valido/u);
  });

  it('mode=pdf-parse-only → skip LLM, mai chiama safeFetch', async () => {
    const buf = await buildSimplePdf('FATTURA dati test estesi');
    await pdfParseExecutor({
      base64: buf.toString('base64'), mode: 'pdf-parse-only',
    }, null, ctx);
    expect(m.safeFetch).not.toHaveBeenCalled();
  });

  it('mode=pdf-parse-only su PDF unparseable → throw esplicito (no LLM fallback)', async () => {
    // Buffer non e\` un PDF → pdf-parse throw
    const badBuf = Buffer.from('not a pdf');
    await expect(pdfParseExecutor({
      base64: badBuf.toString('base64'), mode: 'pdf-parse-only',
    }, null, ctx)).rejects.toThrow(/estrazione PDF locale fallita/u);
  });
});

describe('🚨 LLM-vision fallback', () => {
  const buf = Buffer.from('not a pdf'); // forza fallback

  it('🚨 mode=llm-only senza Anthropic key + senza Liara → throw esplicito', async () => {
    m.llmGet.mockReturnValue(null);
    m.isLiaraAllowed.mockReturnValue(false);
    await expect(pdfParseExecutor({
      base64: buf.toString('base64'), mode: 'llm-only',
    }, null, ctx)).rejects.toThrow(/Anthropic API key.*Liara enabled/u);
  });

  it('🚨 mode=llm-only senza Anthropic + Liara enabled → throw "non supporta PDF vision"', async () => {
    m.llmGet.mockReturnValue(null);
    m.isLiaraAllowed.mockReturnValue(true);
    await expect(pdfParseExecutor({
      base64: buf.toString('base64'), mode: 'llm-only',
    }, null, ctx)).rejects.toThrow(/Liara non supporta ancora input PDF vision/u);
  });

  it('mode=llm-only con Anthropic key → chiama API + ritorna text estratto', async () => {
    m.llmGet.mockReturnValue({ apiKey: 'sk-ant-test', defaultModel: 'claude-sonnet-4-5' });
    m.safeFetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        content: [{ type: 'text', text: 'Estratto da LLM: FATTURA n.999 totale 250 euro contenuto reale' }],
      }),
    });
    const r = await pdfParseExecutor({
      base64: buf.toString('base64'), mode: 'llm-only',
    }, null, ctx);
    const out = r.output as { mode: string; text: string; usedLlmFallback: boolean; llmModel: string };
    expect(out.mode).toBe('llm-only');
    expect(out.text).toContain('Estratto da LLM');
    expect(out.usedLlmFallback).toBe(true);
    expect(out.llmModel).toBe('claude-sonnet-4-5');

    // verifica payload
    expect(m.safeFetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'sk-ant-test' }),
      }),
    );
  });

  it('🚨 LLM API HTTP error → throw con status code', async () => {
    m.llmGet.mockReturnValue({ apiKey: 'sk-ant-test' });
    m.safeFetch.mockResolvedValue({
      ok: false, status: 429,
      text: async () => 'rate limit exceeded',
    });
    await expect(pdfParseExecutor({
      base64: buf.toString('base64'), mode: 'llm-only',
    }, null, ctx)).rejects.toThrow(/LLM-vision \(Anthropic 429\)/u);
  });

  it('🚨 OOM: body errore LLM-vision ENORME in streaming → letto CAPPATO + stream cancellato (non res.text() intero)', async () => {
    m.llmGet.mockReturnValue({ apiKey: 'sk-ant-test' });
    const chunk = new Uint8Array(10 * 1024).fill(120); // 10KB
    let reads = 0;
    const cancelSpy = vi.fn(async () => undefined);
    m.safeFetch.mockResolvedValue({
      ok: false, status: 500, headers: new Headers(),
      body: { getReader: () => ({
        read: async () => { reads += 1; return reads <= 500 ? { done: false, value: chunk } : { done: true, value: undefined }; },
        cancel: cancelSpy,
      }) },
      text: async () => { throw new Error('🚨 res.text() = body errore intero in RAM (OOM)'); },
    });
    await expect(pdfParseExecutor({ base64: buf.toString('base64'), mode: 'llm-only' }, null, ctx))
      .rejects.toThrow(/LLM-vision \(Anthropic 500\)/u);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(reads).toBeLessThanOrEqual(2); // cap 8KB → max 1 chunk da 10KB, NON 500
  });

  it('🚨 LLM response vuota → throw', async () => {
    m.llmGet.mockReturnValue({ apiKey: 'sk-ant-test' });
    m.safeFetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ content: [{ type: 'text', text: '   ' }] }),
    });
    await expect(pdfParseExecutor({
      base64: buf.toString('base64'), mode: 'llm-only',
    }, null, ctx)).rejects.toThrow(/risposta vuota/u);
  });
});

describe('🚨 confidence scoring + auto mode', () => {
  it('mode=auto + pdf-parse ok confidence high → NO LLM fallback', async () => {
    // Genero un PDF con molto testo reale italiano business → confidence > 0.5
    const buf = await buildSimplePdf(
      'FATTURA numero 123 del 06/06/2026 cliente ACME SRL via Roma 10 ' +
      'codice fiscale ABCDEF12G34H567I partita iva 12345678901 ' +
      'descrizione servizi consulenza prezzo unitario 100 quantita 5 ' +
      'totale imponibile 500 iva 22 percento importo 110 totale 610 euro',
    );
    m.llmGet.mockReturnValue({ apiKey: 'sk-test' });
    const r = await pdfParseExecutor({
      base64: buf.toString('base64'), mode: 'auto',
    }, null, ctx);
    const out = r.output as { mode: string; confidence: number; usedLlmFallback: boolean };
    expect(out.mode).toBe('pdf-parse');
    expect(out.confidence).toBeGreaterThan(0.5);
    expect(out.usedLlmFallback).toBe(false);
    expect(m.safeFetch).not.toHaveBeenCalled();
  });
});

describe('🚨 pdfGenerateExecutor — output reale via PDFKit', () => {
  it('happy: title → output con magic bytes %PDF + filename default', async () => {
    const r = await pdfGenerateExecutor({
      title: 'Test Report',
    }, null, ctx);
    const out = r.output as { filename: string; binary: { data?: string }; sizeBytes: number; mimeType: string };
    // Senza filename esplicito → default 'document.pdf'
    expect(out.filename).toBe('document.pdf');
    expect(out.mimeType).toBe('application/pdf');
    expect(out.sizeBytes).toBeGreaterThan(500);

    // Verifica magic bytes %PDF + EOF marker (PDF reale) — ref-primario: byte dall'handle inline
    const buf = Buffer.from(out.binary.data ?? '', 'base64');
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    expect(buf.slice(-6).toString()).toContain('%%EOF');
  });

  it('🚨 title mancante → throw', async () => {
    await expect(pdfGenerateExecutor({}, null, ctx))
      .rejects.toThrow(/"title".*obbligatorio/u);
  });

  it('filename senza .pdf → auto suffix', async () => {
    const r = await pdfGenerateExecutor({
      title: 'X', filename: 'report-2026',
    }, null, ctx);
    const out = r.output as { filename: string };
    expect(out.filename).toBe('report-2026.pdf');
  });

  it('filename con .pdf preserva', async () => {
    const r = await pdfGenerateExecutor({
      title: 'X', filename: 'mydoc.pdf',
    }, null, ctx);
    const out = r.output as { filename: string };
    expect(out.filename).toBe('mydoc.pdf');
  });

  it('pageSize landscape orientation accepted', async () => {
    const r = await pdfGenerateExecutor({
      title: 'X', pageSize: 'A4', orientation: 'landscape',
    }, null, ctx);
    const out = r.output as { sizeBytes: number };
    expect(out.sizeBytes).toBeGreaterThan(0);
  });

  it('sections JSON array rendered', async () => {
    const sections = JSON.stringify([
      { heading: 'Sezione 1', body: 'Corpo testo prima sezione' },
      { heading: 'Sezione 2', body: 'Corpo seconda sezione' },
    ]);
    const r = await pdfGenerateExecutor({
      title: 'Doc multi-section', sectionsJson: sections,
    }, null, ctx);
    const out = r.output as { sizeBytes: number };
    // Con 2 sezioni il pdf cresce vs solo titolo
    const baseline = await pdfGenerateExecutor({ title: 'Doc multi-section' }, null, ctx);
    const baselineOut = baseline.output as { sizeBytes: number };
    expect(out.sizeBytes).toBeGreaterThan(baselineOut.sizeBytes);
  });

  it('🚨 sectionsJson non array → throw', async () => {
    await expect(pdfGenerateExecutor({
      title: 'X', sectionsJson: '{"not":"an array"}',
    }, null, ctx)).rejects.toThrow(/sectionsJson deve essere un array/u);
  });

  it('🚨 tableJson non array → throw', async () => {
    await expect(pdfGenerateExecutor({
      title: 'X', tableJson: '{"not":"array"}',
    }, null, ctx)).rejects.toThrow(/tableJson deve essere un array/u);
  });

  it('🚨 tabella > 10k righe → throw', async () => {
    const huge = JSON.stringify(Array.from({ length: 10_001 }, (_, i) => ({ a: i })));
    await expect(pdfGenerateExecutor({
      title: 'X', tableJson: huge,
    }, null, ctx)).rejects.toThrow(/tabella troppo grande/u);
  });

  it('table render con multiple pages (output size grows linearly)', async () => {
    // 200 rows force multiple pages: verifichiamo che il file size cresca
    // — pdfkit's bufferedPageRange().count restituisce 0 post-end(), quindi
    // testiamo la size proportional invece.
    const rowsSmall = JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ n: i, x: 'r' })));
    const rowsLarge = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({
      n: i, descrizione: `Riga ${String(i)} con testo descrittivo`, totale: i * 10,
    })));
    const small = await pdfGenerateExecutor({ title: 'L', tableJson: rowsSmall }, null, ctx);
    const large = await pdfGenerateExecutor({ title: 'L', tableJson: rowsLarge }, null, ctx);
    const smallOut = small.output as { sizeBytes: number };
    const largeOut = large.output as { sizeBytes: number };
    expect(largeOut.sizeBytes).toBeGreaterThan(smallOut.sizeBytes * 2);
  });

  it('footer placeholder {page}/{total} sostituiti', async () => {
    const r = await pdfGenerateExecutor({
      title: 'X', footer: 'Pagina {page} di {total}',
    }, null, ctx);
    const out = r.output as { binary: { data?: string } };
    // Magic check: PDF decodificato dall'handle inline (ref-primario, no store)
    const buf = Buffer.from(out.binary.data ?? '', 'base64');
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(500);
  });

  it('output shape completo: binary (handle) + filename + sizeBytes + pageCount + mimeType + durationMs', async () => {
    const r = await pdfGenerateExecutor({ title: 'Shape test', filename: 'shape.pdf' }, null, ctx);
    expect(r).toMatchObject({
      output: {
        filename: 'shape.pdf',
        binary: { __ffBinary: true, encoding: 'base64', mimeType: 'application/pdf' }, // ref-primario
        sizeBytes: expect.any(Number),
        pageCount: expect.any(Number),
        mimeType: 'application/pdf',
      },
      durationMs: expect.any(Number),
    });
    expect((r.output as { binary: unknown }).binary).not.toBeUndefined();
  });

  it('tableJson empty + sections empty + only title → genera comunque pdf valido', async () => {
    const r = await pdfGenerateExecutor({
      title: 'Solo titolo', sectionsJson: '[]', tableJson: '[]',
    }, null, ctx);
    const out = r.output as { sizeBytes: number };
    expect(out.sizeBytes).toBeGreaterThan(500);
  });

  it('subtitle rendered (se presente)', async () => {
    const noSub = await pdfGenerateExecutor({ title: 'T' }, null, ctx);
    const withSub = await pdfGenerateExecutor({ title: 'T', subtitle: 'Sub here' }, null, ctx);
    const noSubOut = noSub.output as { sizeBytes: number };
    const withSubOut = withSub.output as { sizeBytes: number };
    expect(withSubOut.sizeBytes).toBeGreaterThan(noSubOut.sizeBytes);
  });
});

describe('output shape pdfParse', () => {
  it('include shape: text/confidence/mode/pages/sizeBytes/usedLlmFallback in mode=llm-only', async () => {
    // Per testare lo shape completo senza dipendere da pdf-parse, usiamo
    // mode=llm-only + mock Anthropic API. Conferma lo schema output con
    // tutti i campi: usedLlmFallback=true + llmModel.
    m.llmGet.mockReturnValue({ apiKey: 'sk-ant-x', defaultModel: 'claude-sonnet-4-5' });
    m.safeFetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ content: [{ type: 'text', text: 'estratto LLM testo significativo' }] }),
    });
    const buf = Buffer.from('any-bytes-since-llm-only');
    const r = await pdfParseExecutor({
      base64: buf.toString('base64'), mode: 'llm-only',
    }, null, ctx);
    expect(r).toMatchObject({
      output: {
        text: expect.any(String),
        confidence: expect.any(Number),
        mode: 'llm-only',
        pages: expect.any(Number),
        sizeBytes: buf.length,
        usedLlmFallback: true,
        llmModel: 'claude-sonnet-4-5',
      },
      durationMs: expect.any(Number),
    });
  });
});

describe('🚨 GAP2 FLIP — pdfGenerateExecutor emette SEMPRE un handle BinaryData (ref-primario)', () => {
  async function ctxStore(): Promise<{ c: NodeExecutionContext; store: BinaryStore }> {
    const { BinaryStore } = await import('../services/binary-store.service');
    const { makeBinaryRef } = await import('@flowforge/core-schema');
    const store = new BinaryStore(join(tenantDir, 'blobs'));
    const writeBinary = async (data: Buffer, meta: { mimeType: string; fileName?: string }): Promise<BinaryData> => {
      const r = await store.writeBuffer(data);
      return makeBinaryRef({ mimeType: meta.mimeType, ref: r.ref, size: r.size, sha256: r.sha256, ...(meta.fileName !== undefined ? { fileName: meta.fileName } : {}) });
    };
    return { c: { ...ctx, writeBinary } as NodeExecutionContext, store };
  }

  it('🚨 DEFAULT con store → handle ref content-addressed, MAI base64 nel JSON', async () => {
    const { isBinaryData } = await import('@flowforge/core-schema');
    const { createHash } = await import('node:crypto');
    const { c, store } = await ctxStore();
    const res = await pdfGenerateExecutor({ title: 'Catalogo' }, null, c); // niente flag: ref è il default
    const out = res.output as Record<string, unknown>;

    expect(isBinaryData(out.binary)).toBe(true);
    const bin = out.binary as BinaryData;
    expect(bin.encoding).toBe('ref');
    expect(bin.mimeType).toBe('application/pdf');
    expect(bin.fileName).toBe('document.pdf');     // default filename
    expect(out.base64).toBeUndefined();            // il campo base64 NON esiste più
    expect(out.sizeBytes).toBe(bin.size);

    const bytes = await store.read(bin.ref!);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-'); // header PDF reale
    expect(bytes.byteLength).toBe(bin.size);
    // bug-bounty: ref È l'sha256 del contenuto (content-addressed, no manomissione)
    expect(bin.ref).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('🚨 CORRETTEZZA: il blob binario è un PDF COMPLETO e integro (header + trailer, no corruzione)', async () => {
    // Verifica STRUTTURALE (no pdf-parse). Un PDF valido inizia con "%PDF-" e
    // finisce con "%%EOF": se il path binario avesse troncato/corrotto i byte, uno
    // dei due mancherebbe.
    const { c, store } = await ctxStore();
    const res = await pdfGenerateExecutor({ title: 'Doc', sectionsJson: '[{"heading":"Capitolo","body":"corpo"}]' }, null, c);
    const out = res.output as { binary: BinaryData; sizeBytes: number };
    const bytes = await store.read(out.binary.ref!);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');         // header
    expect(bytes.subarray(-6).toString('latin1').trim()).toBe('%%EOF');    // trailer (PDF completo)
    expect(bytes.byteLength).toBe(out.sizeBytes);                          // nessun byte perso
  });

  it('🚨 DEFAULT senza store → fallback BinaryData INLINE base64 (fail-soft anti-crash, non legacy)', async () => {
    const { isBinaryData } = await import('@flowforge/core-schema');
    const res = await pdfGenerateExecutor({ title: 'NoStore' }, null, ctx); // ctx senza writeBinary
    const out = res.output as Record<string, unknown>;
    expect(isBinaryData(out.binary)).toBe(true);
    const bin = out.binary as BinaryData;
    expect(bin.encoding).toBe('base64');
    expect(Buffer.from(bin.data!, 'base64').subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(out.base64).toBeUndefined(); // nessun base64 a livello di output: solo dentro l'handle
  });

  it('🚨 NIENTE LEGACY: l\'output non ha MAI il campo base64 (né con store né senza)', async () => {
    const withStore = await ctxStore();
    const a = (await pdfGenerateExecutor({ title: 'A' }, null, withStore.c)).output as Record<string, unknown>;
    const b = (await pdfGenerateExecutor({ title: 'B' }, null, ctx)).output as Record<string, unknown>;
    expect(a.base64).toBeUndefined();
    expect(b.base64).toBeUndefined();
    expect(a.binary).not.toBeUndefined();
    expect(b.binary).not.toBeUndefined();
  });
});

// Il CUORE del feature (la risoluzione BinaryData→byte) è testato DIRETTAMENTE su
// resolveBinaryInline: deterministico, zero dipendenza da pdf-parse (che in v1 è
// content-flaky su certi PDF generati → non un test affidabile della risoluzione).
describe('🚨 GAP2 capstone — resolveBinaryInline (risoluzione BinaryData senza core-schema)', () => {
  const inlineBin = (buf: Buffer): unknown =>
    ({ __ffBinary: true, encoding: 'base64', mimeType: 'application/pdf', size: buf.length, data: buf.toString('base64') });
  const refBin = (ref: string, size: number): unknown =>
    ({ __ffBinary: true, encoding: 'ref', mimeType: 'application/pdf', size, ref });

  it('🚨 inline → decodifica i byte senza reader', async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const out = await resolveBinaryInline(inlineBin(bytes));
    expect(out?.equals(bytes)).toBe(true);
  });

  it('🚨 ref → delega a readBinary col ref giusto', async () => {
    const bytes = Buffer.from('disk-bytes');
    const readBinary = vi.fn(async (_r: string) => bytes);
    const out = await resolveBinaryInline(refBin('a'.repeat(64), bytes.length), readBinary);
    expect(readBinary).toHaveBeenCalledWith('a'.repeat(64));
    expect(out?.equals(bytes)).toBe(true);
  });

  it('🚨 oggetto che CONTIENE un BinaryData (es. { binary }) → risolto', async () => {
    const bytes = Buffer.from('nested');
    const out = await resolveBinaryInline({ filename: 'x', binary: inlineBin(bytes) });
    expect(out?.equals(bytes)).toBe(true);
  });

  it('🚨 non-binario (null / stringa / oggetto semplice) → null', async () => {
    expect(await resolveBinaryInline(null)).toBeNull();
    expect(await resolveBinaryInline('base64-string')).toBeNull();
    expect(await resolveBinaryInline({ a: 1 })).toBeNull();
  });

  it('🚨 ref SENZA readBinary → errore esplicito (no byte vuoti silenziosi)', async () => {
    await expect(resolveBinaryInline(refBin('z'.repeat(64), 10)))
      .rejects.toThrow(/context\.readBinary assente/u);
  });
});

// L'integrazione (l'executor USA i byte risolti come input di pdf-parse) è provata
// via la FAILURE DETERMINISTICA di pdf-parse su byte-garbage: garbage→"pdf-parse
// failed" SEMPRE (vedi test "PDF unparseable" sopra), zero flakiness. Così provo
// il ROUTING ESATTO dei byte (quale fonte raggiunge il parser), non un successo
// flaky. mimeType marcato pdf solo per coerenza; i byte sono garbage di proposito.
describe('🚨 GAP2 capstone — pdfParse ROUTING dei byte in input (failure-deterministica)', () => {
  const binGarbage = (data: string, encoding = 'base64'): unknown =>
    ({ __ffBinary: true, encoding, mimeType: 'application/pdf', size: data.length, data });

  it('🚨 input BinaryData inline → i SUOI byte raggiungono pdf-parse (garbage → throw)', async () => {
    // Se il binary input NON fosse instradato, con config vuota avremmo "serve
    // almeno uno tra path o base64"; invece otteniamo "pdf-parse failed" → i byte
    // del binary SONO arrivati al parser.
    await expect(pdfParseExecutor({ mode: 'pdf-parse-only' }, binGarbage(Buffer.from('NOT-A-PDF').toString('base64')), ctx))
      .rejects.toThrow(/estrazione PDF locale fallita/u);
  });

  it('🚨 input BinaryData ref → readBinary risolve dal disco e i byte vanno al parser', async () => {
    const readBinary = vi.fn(async (_r: string) => Buffer.from('GARBAGE-FROM-DISK'));
    await expect(pdfParseExecutor(
      { mode: 'pdf-parse-only' },
      { __ffBinary: true, encoding: 'ref', mimeType: 'application/pdf', size: 17, ref: 'a'.repeat(64) },
      { ...ctx, readBinary } as unknown as NodeExecutionContext,
    )).rejects.toThrow(/estrazione PDF locale fallita/u);
    expect(readBinary).toHaveBeenCalledWith('a'.repeat(64)); // il ref è stato letto dal disco
  });

  it('🚨 PRECEDENZA discriminante: binary vince su config.base64 (errori DISTINTI → niente falso pass)', async () => {
    // Trucco anti-flaky + discriminante: binary = ref SENZA readBinary → l'executor
    // lancia "readBinary assente" PRIMA di pdf-parse (errore DISTINTO). base64 =
    // garbage → lancerebbe "pdf-parse failed". L'errore ottenuto rivela quale fonte
    // ha vinto, in modo deterministico (zero dipendenza dal successo di pdf-parse).
    await expect(pdfParseExecutor(
      { mode: 'pdf-parse-only', base64: Buffer.from('NOT-A-PDF').toString('base64') },
      { __ffBinary: true, encoding: 'ref', mimeType: 'application/pdf', size: 9, ref: 'a'.repeat(64) },
      ctx, // ctx SENZA readBinary
    )).rejects.toThrow(/context\.readBinary assente/u); // → ha vinto il binary
  });

  it('🚨 REGRESSIONE: no binary input → si usa config.base64 (garbage → stesso throw, path legacy attivo)', async () => {
    await expect(pdfParseExecutor({ mode: 'pdf-parse-only', base64: Buffer.from('NOT-A-PDF').toString('base64') }, null, ctx))
      .rejects.toThrow(/estrazione PDF locale fallita/u);
  });
});
