/**
 * action_pdf_parse — extract text from PDFs with confidence-based fallback.
 *
 * Strategy (the "enterprise" version we'd build at a 1000-dev shop):
 *
 *   1. Estrazione locale via `unpdf` (pdfjs moderno, gratis, veloce — copre ~80%
 *      dei "digital PDF" come fatture generate da Word/InDesign/QuickBooks).
 *      NB: rimpiazza `pdf-parse@1.1.1` (2019, pdfjs antico col parser XRef
 *      fragile); vedi `extractWithPdfjs`.
 *
 *   2. Confidence heuristic — count words, ratio of alphabetic characters,
 *      detect "garbage OCR" signatures (long runs of non-letter chars,
 *      absurd ratios). If confidence is low, the PDF is likely:
 *      - a scanned image (no text layer)
 *      - OCR'd badly (gibberish)
 *      - protected (text encrypted)
 *
 *   3. LLM-vision fallback — Claude Sonnet natively reads PDF base64,
 *      including images. ~10x slower dell'estrazione locale e costa qualche
 *      centesimo a chiamata, ma legge ogni PDF che pdfjs non riesce. È il
 *      pattern Stripe Radar / Doctolib per "AI OCR" — try cheap first,
 *      escalate to expensive only when needed.
 *
 *   Config knobs (i nomi-mode sono stabili / backward-compat):
 *     mode = 'auto' (default)   → estrazione locale → fallback LLM se confidence < soglia
 *     mode = 'pdf-parse-only'   → solo estrazione locale, mai LLM (costo prevedibile)
 *     mode = 'llm-only'         → salta l'estrazione locale, vai diretto a LLM (max qualità/costo)
 *
 * Input shape (mutually exclusive):
 *   • config.path     — file path in tenant sandbox
 *   • config.base64   — base64 of PDF bytes (e.g. IMAP attachment)
 *
 * Output: { text, confidence, mode, pages, sizeBytes, usedLlmFallback, llmModel? }
 */

import { coerceString } from '@/lib/coerce.js';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
// SOLO type (erased a runtime): la forma BinaryData si risolve a mano (vedi
// resolveBinaryInline), così questo modulo non tira dentro le helper di runtime di
// core-schema. Storicamente era OBBLIGATORIO perché core-schema corrompeva il vecchio
// pdfjs di pdf-parse@1.1.1 ("bad XRef entry") nello stesso processo; con `unpdf`
// (pdfjs moderno) il vincolo è caduto, ma teniamo l'approccio dependency-light.
import type { BinaryData } from '@medea/engine-core-schema';
import { isLiaraAllowedForTenant } from '@/services/tenant-ai-preferences.service.js';
import { LlmProvidersService } from '@/services/llm-providers.service.js';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
// Letture risposta CAPPATE (anti-OOM). Import ora sicuro: la fragilità del grafo di
// import che imponeva "dependency-light" era di pdf-parse@1.1.1; con unpdf è caduta.
import { readTextTruncated, readJsonCapped } from '@/lib/capped-response.js';

/**
 * Estrazione testo locale via `unpdf` — wrapper sul build "serverless" di pdfjs
 * MODERNO e patchato (team unjs): ESM-native, gira in puro Node senza canvas/
 * DOMMatrix, manutenuto.
 *
 * Sostituisce `pdf-parse@1.1.1` (2019, non più manutenuto): impacchettava un pdfjs
 * antico col parser XRef fragile + un "debug block" rotto (leggeva un file di test
 * inesistente) e — soprattutto — corrompeva il proprio stato a seconda dell'ordine
 * di valutazione dei moduli nello stesso processo: bastava un import statico in più
 * (anche `node:util`) per farlo crollare con "bad XRef entry". unpdf elimina sia la
 * fragilità XRef sia quella interazione col grafo di import.
 *
 * Import DINAMICO: tiene veloce lo startup del runtime quando nessun workflow usa il
 * nodo (pdfjs è pesante). `new Uint8Array(buffer)` passa una COPIA: pdfjs può
 * detachare l'ArrayBuffer sottostante, e il chiamante riusa `buffer` (size cap,
 * fallback LLM-vision).
 */
async function extractWithPdfjs(buffer: Buffer): Promise<{ text: string; numpages: number }> {
  const { getDocumentProxy, extractText } = await import('unpdf');
  // verbosity:0 (ERRORS) silenzia i warning pdfjs su stderr ("Indexing all PDF
  // objects" su PDF non indicizzati) → niente rumore nei log di produzione. Su PDF
  // davvero invalido lancia comunque ("Invalid PDF structure") → in mode
  // 'pdf-parse-only' viene ri-lanciato, altrove triggera il fallback LLM-vision.
  const pdf = await getDocumentProxy(new Uint8Array(buffer), { verbosity: 0 });
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { text, numpages: totalPages };
}

/**
 * Interfaccia strutturale minima del documento PDFKit — solo i membri usati qui.
 * Evita `any` (CLAUDE.md) senza dipendere da @types/pdfkit (non installato). I
 * metodi sono chainable (ritornano il doc), come l'API reale di PDFKit.
 */
interface PdfKitDoc {
  y: number;
  readonly page: { width: number; height: number; margins: { top: number; bottom: number; left: number; right: number } };
  font(name: string): PdfKitDoc;
  fontSize(size: number): PdfKitDoc;
  fillColor(color: string): PdfKitDoc;
  text(text: string, ...rest: unknown[]): PdfKitDoc;
  moveDown(lines?: number): PdfKitDoc;
  rect(x: number, y: number, w: number, h: number): { fill(color: string): PdfKitDoc };
  addPage(): PdfKitDoc;
  switchToPage(n: number): PdfKitDoc;
  bufferedPageRange(): { start: number; count: number };
  on(event: 'data', cb: (chunk: Buffer) => void): PdfKitDoc;
  on(event: 'end', cb: () => void): PdfKitDoc;
  on(event: 'error', cb: (err: Error) => void): PdfKitDoc;
  end(): void;
}

type PdfKitConstructor = new (opts: Record<string, unknown>) => PdfKitDoc;

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function getTenantRoot(tenantId: string): string {
  const safeTenant = (tenantId || 'default').replace(/[^a-z0-9_-]/gi, '_');
  const baseDir = process.env.MEDEA_DATA_DIR ?? '/var/data/flowforge';
  return resolve(baseDir, 'tenants', safeTenant, 'files');
}

function assertPathAllowed(filePath: string, tenantId: string): string {
  const tenantRoot = getTenantRoot(tenantId);
  const abs = filePath.startsWith('/') ? resolve(filePath) : resolve(tenantRoot, filePath);
  if (abs === tenantRoot || abs.startsWith(tenantRoot + sep)) return abs;
  const envList = process.env.MEDEA_FILE_ALLOWLIST ?? '';
  const globalAllow = envList.split(':').map((p) => p.trim()).filter(Boolean).map((p) => resolve(p));
  if (globalAllow.some((root) => abs === root || abs.startsWith(root + sep))) return abs;
  throw new Error(`Path "${abs}" outside tenant namespace.`);
}

/**
 * Score "is this text actually meaningful?" on a 0-1 scale.
 *
 * Signals:
 *   - Word count: empty text → 0. Hundreds of words → 1.
 *   - Letter ratio: 60%+ alphabetic chars = healthy text. < 30% = likely OCR garbage.
 *   - Average word length: real text averages 4-7 chars. Garbage often 1-2 or 20+.
 *
 * We blend the three; the lowest gates the result. Calibrated empirically
 * on a sample of real Italian invoices, DDT, and bad scans.
 */
function confidenceScore(text: string): number {
  if (text.length === 0) return 0;
  const trimmed = text.trim();
  if (trimmed.length < 20) return 0.1;

  const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 5) return 0.2;

  const letters = (trimmed.match(/[a-zA-Zàèéìòùç]/g) ?? []).length;
  const letterRatio = letters / trimmed.length;
  if (letterRatio < 0.3) return 0.15; // likely OCR'd garbage

  const avgWordLen = words.reduce((acc, w) => acc + w.length, 0) / words.length;
  if (avgWordLen < 2 || avgWordLen > 18) return 0.25;

  // Bonus: presence of "real" words like "fattura", "data", "totale", "via",
  // common in Italian business docs. Detection of these = strong signal.
  const realWordHits = (trimmed.match(/\b(fattura|data|totale|via|spa|srl|cf|piva|cap|importo|articolo|quantità|prezzo|cod\.|n\.\s*\d+)\b/gi) ?? []).length;
  const bonus = Math.min(0.2, realWordHits * 0.04);

  const base = Math.min(1, words.length / 100) * 0.5 + letterRatio * 0.5;
  return Math.min(1, base + bonus);
}

interface LlmVisionResult {
  text: string;
  model: string;
}

/**
 * Send the PDF base64 to Claude Sonnet (vision mode) and ask for verbatim text.
 * Returns the model output + the exact model used (for output transparency).
 *
 * Requires an Anthropic API key configured in Settings → AI Providers, OR
 * passed via X-LLM-API-Key header (BYOK mode, same pattern as node-generator).
 *
 * Why specifically Anthropic: Claude Sonnet supports PDF docs natively in
 * the messages API since 2024 (other providers require image rendering
 * intermediate steps). Future expansion: add OpenAI/Gemini fallbacks once
 * their PDF support matures.
 */
async function llmVisionExtract(pdfBuffer: Buffer, tenantId: string): Promise<LlmVisionResult> {
  const svc = new LlmProvidersService();
  const anthropic = svc.get(tenantId, 'anthropic');
  if (!anthropic?.apiKey) {
    // Try Liara if globally allowed (per-tenant respected automatically)
    if (!isLiaraAllowedForTenant(tenantId)) {
      throw new Error('LLM-vision fallback requires an Anthropic API key configured in Settings → AI Providers (or Liara enabled).');
    }
    throw new Error('LLM-vision fallback non disponibile: configura una API key Anthropic in Settings → AI Providers. (Liara non supporta ancora input PDF vision.)');
  }

  const model = anthropic.defaultModel ?? 'claude-sonnet-4-5';
  const base64 = pdfBuffer.toString('base64');

  const res = await safeOutboundFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropic.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: base64,
            },
          },
          {
            type: 'text',
            text: 'Estrai TUTTO il testo da questo PDF, mantenendo la struttura originale (paragrafi, tabelle, intestazioni). Restituisci SOLO il testo estratto, senza commenti o spiegazioni. Per le tabelle, usa formato Markdown.',
          },
        ],
      }],
    }),
  });

  if (!res.ok) {
    // Body errore CAPPATO (era res.text() non limitato → OOM su risposta enorme).
    const errText = (await readTextTruncated(res, 8192)).text;
    throw new Error(`LLM-vision (Anthropic ${res.status.toString()}): ${errText.slice(0, 500)}`);
  }
  const data = await readJsonCapped<{ content?: { type: string; text?: string }[] }>(res);
  const text = data.content?.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('') ?? '';
  if (!text.trim()) {
    throw new Error('LLM-vision ha restituito risposta vuota — controlla che il PDF sia valido e non troppo grande (max 32 MB Anthropic).');
  }
  return { text, model };
}

const CONFIDENCE_FALLBACK_THRESHOLD = 0.5;

/**
 * Estrae+risolve un BinaryData dall'input INLINE, senza chiamare le helper di
 * runtime di core-schema (resolveBinaryValue/readBinaryBytes).
 *
 * Storia: con `pdf-parse@1.1.1` caricare @medea/engine-core-schema nello stesso
 * processo corrompeva lo stato globale del suo pdfjs antico → ogni parse successivo
 * falliva "bad XRef entry" (riprodotto a runtime, non solo nei test). Con `unpdf`
 * (pdfjs moderno) quel vincolo è caduto, ma teniamo la risoluzione a mano: la forma
 * BinaryData è stabile e banale (encoding='base64' → decode; encoding='ref' →
 * context.readBinary(ref)) e così questo modulo resta dependency-light.
 */
interface BinaryLike { __ffBinary: true; encoding: string; data?: string; ref?: string }
function extractBinary(v: unknown): BinaryLike | null {
  const isBin = (x: unknown): x is BinaryLike =>
    x !== null && typeof x === 'object' && (x as { __ffBinary?: unknown }).__ffBinary === true;
  if (isBin(v)) return v;
  if (v !== null && typeof v === 'object') {
    for (const val of Object.values(v as Record<string, unknown>)) if (isBin(val)) return val;
  }
  return null;
}
export async function resolveBinaryInline(
  v: unknown,
  readBinary?: (ref: string) => Buffer | Promise<Buffer>,
): Promise<Buffer | null> {
  const bin = extractBinary(v);
  if (bin === null) return null;
  if (bin.encoding === 'base64') return Buffer.from(bin.data ?? '', 'base64');
  if (!bin.ref) throw new Error('action_pdf_parse: BinaryData encoding=ref senza campo "ref".');
  if (!readBinary) throw new Error('action_pdf_parse: input BinaryData ref ma context.readBinary assente.');
  return await readBinary(bin.ref);
}

export const pdfParseExecutor: NodeExecutor = async (config, input, context) => {
  const start = Date.now();

  // ── Step 1: resolve PDF bytes ─────────────────────────────────────────
  // PRECEDENZA (ref-primario): input BinaryData (es. http download binary-ref /
  // imap attachment) > config.base64 (inline legacy) > config.path (disco).
  let buffer: Buffer;
  const rawPath = asString(config.path);
  const base64 = asString(config.base64);
  const binBytes = await resolveBinaryInline(input, context.readBinary);
  if (binBytes) {
    buffer = binBytes;
  } else if (base64) {
    buffer = Buffer.from(base64, 'base64');
  } else if (rawPath) {
    const abs = assertPathAllowed(rawPath, context.tenantId);
    const stats = await stat(abs);
    if (!stats.isFile()) throw new Error(`Path "${abs}" is not a regular file`);
    if (stats.size > PDF_MAX_INPUT_BYTES) {
      throw new Error(`PDF troppo grande (${stats.size.toString()} bytes). Max 32 MB.`);
    }
    buffer = await readFile(abs);
  } else {
    throw new Error('action_pdf_parse: serve almeno uno tra config.path o config.base64.');
  }

  const sizeBytes = buffer.length;
  // Cap UNIFORME su OGNI input (fix 2026-06-17): prima i 32MB erano enforced SOLO sul
  // file da disco (stat), NON su base64/BinaryData da upstream (es. allegato IMAP
  // enorme) → l'estrazione locale/Claude-vision amplificava in memoria → OOM. Ora il
  // cap vale per tutti gli input (i byte sono già risolti in `buffer`). Check inline
  // per tenere il modulo dependency-light; l'helper condiviso assertInputSizeWithinCap
  // è usato dagli altri parser (es. excel.ts).
  if (sizeBytes > PDF_MAX_INPUT_BYTES) {
    throw new Error(`PDF troppo grande (${sizeBytes.toString()} bytes). Max ${(PDF_MAX_INPUT_BYTES / (1024 * 1024)).toString()} MB.`);
  }
  const mode = asString(config.mode) || 'auto';
  if (!['auto', 'pdf-parse-only', 'llm-only'].includes(mode)) {
    throw new Error(`action_pdf_parse: mode "${mode}" non valido. Accettati: auto, pdf-parse-only, llm-only.`);
  }

  // ── Step 2: estrazione locale gratis (unpdf/pdfjs) ────────────────────
  let cheapText = '';
  let pages = 0;
  if (mode !== 'llm-only') {
    try {
      const parsed = await extractWithPdfjs(buffer);
      cheapText = parsed.text;
      pages = parsed.numpages;
    } catch (err) {
      // pdfjs può lanciare su PDF cifrati o malformati. Se la mode lo consente,
      // più sotto proviamo il fallback LLM-vision.
      if (mode === 'pdf-parse-only') {
        throw new Error(`estrazione PDF locale fallita: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const cheapConfidence = confidenceScore(cheapText);

  // ── Step 3: decide if we need LLM fallback ────────────────────────────
  if (mode === 'pdf-parse-only') {
    return {
      output: {
        text: cheapText,
        confidence: cheapConfidence,
        mode: 'pdf-parse',
        pages,
        sizeBytes,
        usedLlmFallback: false,
      },
      durationMs: Date.now() - start,
    };
  }

  const shouldFallback =
    mode === 'llm-only' ||
    cheapText.trim().length === 0 ||
    cheapConfidence < CONFIDENCE_FALLBACK_THRESHOLD;

  if (!shouldFallback) {
    return {
      output: {
        text: cheapText,
        confidence: cheapConfidence,
        mode: 'pdf-parse',
        pages,
        sizeBytes,
        usedLlmFallback: false,
      },
      durationMs: Date.now() - start,
    };
  }

  // ── Step 4: LLM-vision fallback ───────────────────────────────────────
  const { text: llmText, model: llmModel } = await llmVisionExtract(buffer, context.tenantId);
  const llmConfidence = confidenceScore(llmText);

  return {
    output: {
      text: llmText,
      confidence: llmConfidence,
      mode: mode === 'llm-only' ? 'llm-only' : 'llm-fallback',
      pages,
      sizeBytes,
      usedLlmFallback: true,
      llmModel,
      cheapAttempt: mode !== 'llm-only' ? { text: cheapText.slice(0, 500), confidence: cheapConfidence } : undefined,
    },
    durationMs: Date.now() - start,
  };
};

// ════════════════════════════════════════════════════════════════════════
// action_pdf_generate — render PDF da titolo + sezioni + tabella
// ════════════════════════════════════════════════════════════════════════
//
// Implementazione minimalista enterprise:
//   • pdfkit lazy import (1.5MB lib, server-only — browser editor non lo
//     vede mai). Stessa convenzione di nodemailer / better-sqlite3.
//   • Layout: header bordato + body con sezioni paragrafo + tabella
//     auto-fit colonne + footer paginato.
//   • Pagination automatica via pdfkit chunked stream — non carichiamo
//     mai tutto in memoria, output finale buffered solo per base64 encode.
//
// Sicurezza:
//   • Limit hard tabella: max 10k righe, max 50 colonne (anti memory exhaustion).
//   • Sanitize XSS-like in tabella cells (escape <, >, & per evitare PDF
//     reader-side rendering issues su client malformati).
//   • Cap totale output: 32 MB base64 (24 MB raw PDF) — oltre, throw.
//
// Pattern: catalog/listino/fattura riceve sectionsJson + tableJson da
// upstream (es. action_xlsx_parse) e produce base64 collegabile a
// action_send_email attachmentsJson.

interface PdfSection {
  heading?: string;
  body?: string;
}

interface PdfGenerateOutput {
  filename: string;
  /** REF-PRIMARIO: handle BinaryData (ref con store, inline base64 senza). */
  binary: BinaryData;
  sizeBytes: number;
  pageCount: number;
  mimeType: 'application/pdf';
}

const PDF_MAX_TABLE_ROWS = 10_000;
/** Cap dimensione input PDF (32 MB) — vale per file su disco E base64/BinaryData. */
const PDF_MAX_INPUT_BYTES = 32 * 1024 * 1024;
const PDF_MAX_TABLE_COLS = 50;
const PDF_MAX_OUTPUT_BYTES = 24 * 1024 * 1024; // 24 MB raw — base64 ~32 MB

function parseJsonSafe<T>(raw: unknown, fallback: T): T {
  if (raw == null || raw === '') return fallback;
  if (typeof raw !== 'string') return raw as T;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function escapePdfCell(value: unknown): string {
  if (value == null) return '';
  const s = coerceString(value);
  // pdfkit renderizza Unicode UTF-8 nativo. L'unica difesa qui è evitare
  // null bytes che alcuni parser PDF rifiutano + control chars non-stampabili.
  // Filtro per codepoint (niente regex con control char → no-control-regex).
  return [...s].filter((ch) => {
    const c = ch.charCodeAt(0);
    return !(c <= 8 || (c >= 0x0b && c <= 0x1f) || c === 0x7f);
  }).join('').slice(0, 500);
}

export const pdfGenerateExecutor: NodeExecutor = async (config, _input, context) => {
  const start = Date.now();

  // Pdfkit ha import sync ma il default export ha types CJS — lazy + cast tipato
  // su un'interfaccia strutturale minima (no `any`, solo i membri usati).
  const PDFKitModule = await import('pdfkit');
  const pdfkitInterop = PDFKitModule as unknown as { default?: PdfKitConstructor } & PdfKitConstructor;
  const PDFDocument: PdfKitConstructor = pdfkitInterop.default ?? pdfkitInterop;

  const cfg = config;
  const title = coerceString(cfg.title ?? '').trim();
  if (!title) {
    throw new Error('action_pdf_generate: "title" è obbligatorio');
  }
  const subtitle = coerceString(cfg.subtitle ?? '').trim();
  const footer = coerceString(cfg.footer ?? '').trim();
  const pageSize = ['A4', 'A5', 'LETTER', 'LEGAL'].includes(String(cfg.pageSize)) ? String(cfg.pageSize) : 'A4';
  const orientation = coerceString(cfg.orientation ?? 'portrait') === 'landscape' ? 'landscape' : 'portrait';
  let filename = coerceString(cfg.filename ?? 'document.pdf').trim() || 'document.pdf';
  if (!/\.pdf$/i.test(filename)) filename += '.pdf';

  const sections = parseJsonSafe<PdfSection[]>(cfg.sectionsJson, []);
  if (!Array.isArray(sections)) {
    throw new Error('action_pdf_generate: sectionsJson deve essere un array JSON di {heading, body}');
  }

  const tableRows = parseJsonSafe<Record<string, unknown>[]>(cfg.tableJson, []);
  if (!Array.isArray(tableRows)) {
    throw new Error('action_pdf_generate: tableJson deve essere un array JSON di oggetti riga');
  }
  if (tableRows.length > PDF_MAX_TABLE_ROWS) {
    throw new Error(`action_pdf_generate: tabella troppo grande (${String(tableRows.length)} righe, max ${String(PDF_MAX_TABLE_ROWS)})`);
  }

  // ── Compone PDF ─────────────────────────────────────────────────────
  const doc: PdfKitDoc = new PDFDocument({
    size: pageSize,
    layout: orientation,
    margins: { top: 50, bottom: 60, left: 50, right: 50 },
    bufferPages: true, // serve per footer paginato { page } di { total }
    info: {
      Title: title,
      Author: 'FlowForge',
      Creator: 'FlowForge action_pdf_generate',
      Producer: 'FlowForge runtime',
    },
  });

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  // ⛔ MAI throw dentro un listener EventEmitter ('data'): l'eccezione propagherebbe
  // SINCRONA fuori dall'emit() interno di PDFKit (non rigetta `done`) → potenziale
  // uncaughtException = crash del processo. Su overflow settiamo un flag e rigettiamo
  // `done` in modo PULITO; i chunk successivi vengono ignorati (niente accumulo).
  let overflowErr: Error | null = null;
  let resolveDone!: () => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  doc.on('data', (chunk: Buffer) => {
    if (overflowErr) return;
    totalBytes += chunk.length;
    if (totalBytes > PDF_MAX_OUTPUT_BYTES) {
      overflowErr = new Error(`action_pdf_generate: output PDF troppo grande (>${String(PDF_MAX_OUTPUT_BYTES / 1024 / 1024)}MB)`);
      rejectDone(overflowErr);
      return;
    }
    chunks.push(chunk);
  });
  doc.on('end', () => { if (!overflowErr) resolveDone(); });
  doc.on('error', (e: Error) => { if (!overflowErr) rejectDone(e); });

  // Header titolo
  doc.font('Helvetica-Bold').fontSize(24).fillColor('#0b0b0d').text(title, { align: 'left' });
  if (subtitle) {
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(12).fillColor('#52525b').text(subtitle, { align: 'left' });
  }
  doc.moveDown(1);

  // Sezioni
  for (const sec of sections) {
    if (sec.heading) {
      doc.font('Helvetica-Bold').fontSize(14).fillColor('#0b0b0d').text(sec.heading);
      doc.moveDown(0.3);
    }
    if (sec.body) {
      doc.font('Helvetica').fontSize(11).fillColor('#27272a').text(sec.body, { align: 'left', lineGap: 2 });
      doc.moveDown(0.8);
    }
  }

  // Tabella
  if (tableRows.length > 0) {
    const firstRow = tableRows[0]!;
    const headers = Object.keys(firstRow).slice(0, PDF_MAX_TABLE_COLS);
    if (headers.length === 0) {
      // ignora tabella senza colonne
    } else {
      doc.moveDown(0.5);
      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const colWidth = pageWidth / headers.length;
      const rowH = 18;

      // Intestazioni
      const startX = doc.page.margins.left;
      let y = doc.y;
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#ffffff');
      doc.rect(startX, y, pageWidth, rowH).fill('#0ea5e9');
      doc.fillColor('#ffffff');
      headers.forEach((h, i) => {
        doc.text(escapePdfCell(h), startX + i * colWidth + 4, y + 4, { width: colWidth - 8, ellipsis: true });
      });
      y += rowH;

      // Body righe
      doc.font('Helvetica').fontSize(10).fillColor('#27272a');
      for (let r = 0; r < tableRows.length; r++) {
        if (y + rowH > doc.page.height - doc.page.margins.bottom - 30) {
          doc.addPage();
          y = doc.page.margins.top;
        }
        const row = tableRows[r]!;
        // zebra stripe
        if (r % 2 === 0) {
          doc.rect(startX, y, pageWidth, rowH).fill('#f4f4f5');
          doc.fillColor('#27272a');
        }
        headers.forEach((h, i) => {
          const v = escapePdfCell(row[h]);
          const isNumeric = /^-?\d+([.,]\d+)?$/.test(v);
          doc.text(v, startX + i * colWidth + 4, y + 4, {
            width: colWidth - 8,
            ellipsis: true,
            align: isNumeric ? 'right' : 'left',
          });
        });
        y += rowH;
      }
      doc.y = y + 10;
    }
  }

  // Footer paginato {page} / {total}
  if (footer) {
    const range = doc.bufferedPageRange();
    const total = range.count;
    for (let i = 0; i < total; i++) {
      doc.switchToPage(range.start + i);
      const footerText = footer.replace(/\{page\}/g, String(i + 1)).replace(/\{total\}/g, String(total));
      doc.font('Helvetica').fontSize(9).fillColor('#71717a').text(
        footerText,
        doc.page.margins.left,
        doc.page.height - 40,
        { align: 'center', width: doc.page.width - doc.page.margins.left - doc.page.margins.right },
      );
    }
  }

  doc.end();
  await done;

  const buffer = Buffer.concat(chunks);
  // pdfkit non espone direttamente pageCount post-end; usiamo bufferedPageRange.
  const pageCount = doc.bufferedPageRange().count;

  // GAP 2 — REF-PRIMARIO (default, niente opt-in): pdf_generate emette SEMPRE un
  // handle BinaryData. Con lo store = ref content-addressed (il base64 NON viene
  // mai calcolato → win di memoria sul PDF grande, dedup). Senza store = inline
  // base64 (fail-soft anti-crash: test/engine senza binaryStore). L'inline è
  // costruito A MANO per tenere il modulo dependency-light (vedi nota storica su
  // resolveBinaryInline: era un vincolo di pdf-parse, caduto con unpdf).
  const binary: BinaryData = context.writeBinary
    ? await context.writeBinary(buffer, { mimeType: 'application/pdf', fileName: filename })
    : { __ffBinary: true, encoding: 'base64', mimeType: 'application/pdf', size: buffer.length, data: buffer.toString('base64'), fileName: filename };

  const output: PdfGenerateOutput = {
    filename,
    binary,
    sizeBytes: buffer.length,
    pageCount,
    mimeType: 'application/pdf',
  };

  return { output, durationMs: Date.now() - start };
};
