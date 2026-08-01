import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectImageMime, stripDataUrl, toVisionImage, extractPdfText } from './vision-render.js';

// extractText/getDocumentProxy di unpdf usano pdfjs nel ramo TESTO (no canvas-worker)
// → funziona nel bundle di produzione (provato con tsup). Qui mockiamo unpdf per
// testare la MIA logica senza la rete/pdfjs.
const u = vi.hoisted(() => ({ getDocumentProxy: vi.fn(), extractText: vi.fn() }));
vi.mock('unpdf', () => ({
  getDocumentProxy: (...a: unknown[]) => u.getDocumentProxy(...a),
  extractText: (...a: unknown[]) => u.extractText(...a),
}));

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]).toString('base64');
const GIF_B64 = Buffer.from(Buffer.from('GIF89a____', 'ascii')).toString('base64');
const WEBP_B64 = Buffer.from(Buffer.from('RIFF____WEBP', 'ascii')).toString('base64');

describe('detectImageMime', () => {
  it('riconosce PNG dai magic bytes', () => { expect(detectImageMime(PNG_B64)).toBe('image/png'); });
  it('riconosce JPEG', () => { expect(detectImageMime(JPEG_B64)).toBe('image/jpeg'); });
  it('riconosce GIF', () => { expect(detectImageMime(GIF_B64)).toBe('image/gif'); });
  it('riconosce WebP', () => { expect(detectImageMime(WEBP_B64)).toBe('image/webp'); });
  it('default jpeg su ignoto', () => { expect(detectImageMime('Zm9vYmFy')).toBe('image/jpeg'); });
});

describe('stripDataUrl', () => {
  it('estrae mime + base64 da un data-URL', () => {
    expect(stripDataUrl('data:image/png;base64,AAAA')).toEqual({ base64: 'AAAA', mimeType: 'image/png' });
  });
  it('base64 puro → passthrough senza mime', () => {
    expect(stripDataUrl('AAAA')).toEqual({ base64: 'AAAA' });
  });
  it('non confonde un base64 che CONTIENE "data:" ma non è un data-URL', () => {
    expect(stripDataUrl('ZGF0YTo=')).toEqual({ base64: 'ZGF0YTo=' });
  });
});

describe('toVisionImage', () => {
  it('data-URL → usa il mime del data-URL', () => {
    expect(toVisionImage('data:image/webp;base64,Ukl= ')).toMatchObject({ mimeType: 'image/webp' });
  });
  it('base64 puro → mime dedotto dai magic bytes', () => {
    expect(toVisionImage(PNG_B64)).toEqual({ base64: PNG_B64, mimeType: 'image/png' });
  });
});

describe('extractPdfText', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('estrae testo + totalPages (mergePages)', async () => {
    const proxy = { numPages: 3 };
    u.getDocumentProxy.mockResolvedValue(proxy);
    u.extractText.mockResolvedValue({ totalPages: 3, text: 'FATTURA n.123' });
    const r = await extractPdfText(new Uint8Array([1, 2, 3]));
    expect(r).toEqual({ text: 'FATTURA n.123', totalPages: 3 });
    // passa il PROXY a extractText (non i bytes) e merge-pages
    expect(u.extractText).toHaveBeenCalledWith(proxy, { mergePages: true });
  });

  it('🚨 PDF scansionato (testo vuoto) → ritorna testo vuoto (il chiamante lo gestisce)', async () => {
    u.getDocumentProxy.mockResolvedValue({ numPages: 1 });
    u.extractText.mockResolvedValue({ totalPages: 1, text: '' });
    const r = await extractPdfText(new Uint8Array([1]));
    expect(r).toEqual({ text: '', totalPages: 1 });
  });
});

// Guard di REGRESSIONE che avrebbe beccato il bug del render: il pdfjs di unpdf, sotto
// il bundle tsup (= produzione), apriva un worker_thread che non sa trasferire il canvas
// (DataCloneError). `extractText` invece funziona nel bundle. Questo test builda la MIA
// extractPdfText col bundle tsup ed esegue da node PURO (il path IDENTICO alla prod).
describe('extractPdfText — REGRESSIONE bundle produzione (tsup + node puro)', () => {
  it('🚨 estrae testo da un PDF reale ESEGUITA DAL BUNDLE tsup (no worker/DataClone)', async () => {
    const PDFKit = (await import('pdfkit')).default;
    const doc = new PDFKit();
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    await new Promise<void>((r) => { doc.on('end', () => r()); doc.fontSize(16).text('FATTURA n.123 totale 100 euro'); doc.addPage().text('Pagina due'); doc.end(); });

    const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
    // Dir SOTTO la root del runtime: il bundle deve risolvere `unpdf` da node_modules
    // (risalendo l'albero) — da /tmp non lo troverebbe. Nome dotted → fuori dai glob.
    const dir = mkdtempSync(join(runtimeRoot, '.tmp-pdftxt-'));
    const pdfPath = join(dir, 'doc.pdf');
    const entryPath = join(dir, 'entry.ts');
    const outDir = join(dir, 'out');
    writeFileSync(pdfPath, Buffer.concat(chunks));
    writeFileSync(entryPath, [
      `import { readFileSync } from 'node:fs';`,
      `import { extractPdfText } from ${JSON.stringify(join(runtimeRoot, 'src/lib/vision-render.ts'))};`,
      `const { text, totalPages } = await extractPdfText(new Uint8Array(readFileSync(${JSON.stringify(pdfPath)})));`,
      `process.stdout.write(JSON.stringify({ totalPages, hasFattura: text.includes('FATTURA') }));`,
    ].join('\n'));

    try {
      // tsup come la produzione (ESM, node, unpdf esterno) → poi NODE PURO sul bundle.
      execFileSync('npx', ['tsup', entryPath, '--format', 'esm', '--platform', 'node', '--external', 'unpdf', '--no-splitting', '-d', outDir], {
        cwd: runtimeRoot, encoding: 'utf-8', timeout: 120_000, stdio: ['ignore', 'ignore', 'pipe'],
      });
      const out = execFileSync(process.execPath, [join(outDir, 'entry.js')], {
        cwd: runtimeRoot, encoding: 'utf-8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const res = JSON.parse(out) as { totalPages: number; hasFattura: boolean };
      expect(res.totalPages).toBe(2);
      expect(res.hasFattura).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
