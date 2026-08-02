/**
 * Test — Vision tools. analyzeImage (foto → modello vision risolto) + extractDocument
 * (PDF/testo → estrazione testo). Mock di dispatchLLMVision e extractPdfText;
 * toVisionImage resta REALE (puro). Copre happy-path E path d'errore (immagine/doc
 * oltre cap, MIME non supportato, PDF scansionato, estrazione fallita).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VisionImage } from '@/lib/vision-render.js';

const m = vi.hoisted(() => ({ dispatch: vi.fn(), extractPdf: vi.fn() }));

vi.mock('./llm-vision.service.js', () => ({
  dispatchLLMVision: (...a: unknown[]) => m.dispatch(...a),
}));
vi.mock('@/lib/vision-render.js', async (orig) => {
  const actual = await orig<typeof import('@/lib/vision-render.js')>();
  return { ...actual, extractPdfText: (...a: unknown[]) => m.extractPdf(...a) };
});
vi.mock('@/lib/logger.js');

const { analyzeImage, extractDocument } = await import('./vision-tools.service.js');

const TARGET = { provider: 'liara', apiKey: '', model: '' };
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString(
  'base64',
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('analyzeImage (foto → modello vision)', () => {
  it("🚨 happy: passa l'immagine al dispatch col mime dedotto, ritorna testo", async () => {
    m.dispatch.mockResolvedValue({ ok: true, text: 'è una fattura da 100€' });
    const r = await analyzeImage(PNG_B64, 'estrai totale', TARGET);
    expect(r.ok).toBe(true);
    expect(r.text).toBe('è una fattura da 100€');
    const [target, prompt, images] = m.dispatch.mock.calls[0] as [unknown, string, VisionImage[]];
    expect(target).toBe(TARGET);
    expect(prompt).toBe('estrai totale');
    expect(images).toHaveLength(1);
    expect(images[0]!.mimeType).toBe('image/png');
  });

  it('prompt assente → prompt di default', async () => {
    m.dispatch.mockResolvedValue({ ok: true, text: 'x' });
    await analyzeImage(PNG_B64, undefined, TARGET);
    expect((m.dispatch.mock.calls[0] as [unknown, string, unknown])[1].length).toBeGreaterThan(10);
  });

  it('🚨 immagine vuota → error, NESSUN dispatch', async () => {
    const r = await analyzeImage('', undefined, TARGET);
    expect(r.ok).toBe(false);
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it('🚨 ATTACCO: immagine oltre 20MB → error PRIMA del dispatch (no OOM/costo)', async () => {
    const huge = 'A'.repeat(28 * 1024 * 1024); // ~21MB decodificati
    const r = await analyzeImage(huge, undefined, TARGET);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/troppo grande/u);
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it('🚨 dispatch fallisce → ok:false propaga error', async () => {
    m.dispatch.mockResolvedValue({ ok: false, text: '', error: 'Liara HTTP 500' });
    const r = await analyzeImage(PNG_B64, undefined, TARGET);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/500/u);
  });
});

describe('extractDocument (PDF/testo → estrazione testo)', () => {
  it('text/plain → decode UTF-8 diretto, NESSUNA estrazione PDF', async () => {
    const txt = Buffer.from('ciao mondo', 'utf-8').toString('base64');
    const r = await extractDocument(txt, 'text/plain');
    expect(r.ok).toBe(true);
    expect(r.text).toBe('ciao mondo');
    expect(m.extractPdf).not.toHaveBeenCalled();
  });

  it('🚨 PDF → estrae testo + totalPages', async () => {
    m.extractPdf.mockResolvedValue({ text: 'TESTO FATTURA', totalPages: 2 });
    const r = await extractDocument('JVBERi0=', 'application/pdf');
    expect(r.ok).toBe(true);
    expect(r.text).toBe('TESTO FATTURA');
    expect(r.pages).toBe(2);
  });

  it('🚨 PDF scansionato (testo vuoto) → error esplicito "non ancora supportato"', async () => {
    m.extractPdf.mockResolvedValue({ text: '   \n ', totalPages: 3 });
    const r = await extractDocument('JVBERi0=', 'application/pdf');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/scansionato|non è ancora supportata/u);
    expect(r.pages).toBe(3);
  });

  it('🚨 ATTACCO: documento oltre 32MB → error, NESSUNA estrazione (no OOM)', async () => {
    const huge = 'A'.repeat(45 * 1024 * 1024); // ~33MB decodificati
    const r = await extractDocument(huge, 'application/pdf');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/troppo grande/u);
    expect(m.extractPdf).not.toHaveBeenCalled();
  });

  it('🚨 MIME non supportato → error', async () => {
    const r = await extractDocument('AAAA', 'application/zip');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/non supportato/u);
  });

  it('🚨 estrazione fallisce (PDF corrotto) → ok:false', async () => {
    m.extractPdf.mockRejectedValue(new Error('bad PDF'));
    const r = await extractDocument('JVBERi0=', 'application/pdf');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/bad PDF/u);
  });
});
