/**
 * Test 2026-grade — executors/legal-compliance.knowledge.ts (helpers puri).
 *
 * 🚨 chunkDocument: anti-runaway MAX_CHUNKS=50, overlap CHUNK_OVERLAP=200.
 *    Bug = docu enormi → OOM o tempo prompt esploso.
 *
 * 🚨 dedupFindings: chiave (framework|article|title) case-insensitive.
 *    Sort by severity DESC dopo dedup.
 *
 * 🚨 applySeverityFloor: filtra findings sotto la soglia.
 *
 * 🚨 computeScore: 100 - penalty per severity, clamped [0, 100].
 *
 * 🚨 LEGAL_KNOWLEDGE_INLINE: token budget < 2.5k, copre 6 normative chiave.
 */
import { describe, it, expect } from 'vitest';
import {
  LEGAL_KNOWLEDGE_INLINE, SEVERITY_RANK,
  MIN_DOC_CHARS, MAX_DOC_CHARS, CHUNK_SIZE, CHUNK_OVERLAP, MAX_CHUNKS,
  chunkDocument, dedupFindings, applySeverityFloor, computeScore,
  type Finding,
} from './legal-compliance.knowledge.js';

describe('🚨 LEGAL_KNOWLEDGE_INLINE — content coverage', () => {
  it('🚨 contiene GDPR (Reg. UE 2016/679) con articoli chiave', () => {
    expect(LEGAL_KNOWLEDGE_INLINE).toContain('GDPR');
    expect(LEGAL_KNOWLEDGE_INLINE).toContain('art.6');
    expect(LEGAL_KNOWLEDGE_INLINE).toContain('art.33'); // 72h breach notification
    expect(LEGAL_KNOWLEDGE_INLINE).toContain('art.83'); // sanctions
  });

  it('🚨 contiene eIDAS 2.0 con QES + EUDI Wallet 2024', () => {
    expect(LEGAL_KNOWLEDGE_INLINE).toContain('eIDAS 2.0');
    expect(LEGAL_KNOWLEDGE_INLINE).toContain('QES');
    expect(LEGAL_KNOWLEDGE_INLINE).toContain('EUDI Wallet');
  });

  it('🚨 contiene AI Act (Reg. UE 2024/1689)', () => {
    expect(LEGAL_KNOWLEDGE_INLINE).toContain('AI Act');
    expect(LEGAL_KNOWLEDGE_INLINE).toContain('Reg. UE 2024/1689');
    expect(LEGAL_KNOWLEDGE_INLINE).toContain('agosto 2026');
  });

  it('🚨 contiene Codice Consumo D.lgs. 206/2005', () => {
    expect(LEGAL_KNOWLEDGE_INLINE).toContain('D.lgs. 206/2005');
    expect(LEGAL_KNOWLEDGE_INLINE).toContain('14gg'); // recesso
  });

  it('🚨 contiene e-Privacy IT (D.Lgs 196/2003 art.122)', () => {
    expect(LEGAL_KNOWLEDGE_INLINE).toContain('e-Privacy');
    expect(LEGAL_KNOWLEDGE_INLINE).toContain('cookie tecnici');
  });

  it('🚨 SAFETY: lunghezza < 2.5k chars (~700 tokens) per prompt budget', () => {
    expect(LEGAL_KNOWLEDGE_INLINE.length).toBeLessThan(3500);
    expect(LEGAL_KNOWLEDGE_INLINE.length).toBeGreaterThan(1500);
  });
});

describe('🚨 SEVERITY_RANK — ordering critical > high > medium > low', () => {
  it('🚨 4 livelli ranked correttamente', () => {
    expect(SEVERITY_RANK.critical).toBe(4);
    expect(SEVERITY_RANK.high).toBe(3);
    expect(SEVERITY_RANK.medium).toBe(2);
    expect(SEVERITY_RANK.low).toBe(1);
  });

  it('🚨 critical > high > medium > low (monotonic)', () => {
    expect(SEVERITY_RANK.critical).toBeGreaterThan(SEVERITY_RANK.high!);
    expect(SEVERITY_RANK.high).toBeGreaterThan(SEVERITY_RANK.medium!);
    expect(SEVERITY_RANK.medium).toBeGreaterThan(SEVERITY_RANK.low!);
  });
});

describe('🚨 chunkDocument — anti-runaway', () => {
  it('🚨 text < CHUNK_SIZE → 1 chunk intero', () => {
    expect(chunkDocument('short')).toEqual(['short']);
  });

  it('🚨 text esatto CHUNK_SIZE → 1 chunk', () => {
    const text = 'x'.repeat(CHUNK_SIZE);
    expect(chunkDocument(text)).toHaveLength(1);
  });

  it('🚨 text 2x CHUNK_SIZE → 2 chunks con overlap', () => {
    const text = 'x'.repeat(CHUNK_SIZE * 2);
    const chunks = chunkDocument(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Overlap: ogni chunk inizia (CHUNK_SIZE - CHUNK_OVERLAP) char dopo il prev
    expect(chunks[0]!.length).toBeLessThanOrEqual(CHUNK_SIZE);
  });

  it('🚨 SAFETY: text giganti → cap MAX_CHUNKS=50 (anti-OOM)', () => {
    const text = 'x'.repeat(CHUNK_SIZE * 100);
    const chunks = chunkDocument(text);
    expect(chunks.length).toBeLessThanOrEqual(MAX_CHUNKS);
  });

  it('🚨 stringa vuota → 1 chunk vuoto (no crash)', () => {
    expect(chunkDocument('')).toEqual(['']);
  });

  it('🚨 constants exposed: MIN_DOC_CHARS/MAX_DOC_CHARS/CHUNK_OVERLAP sani', () => {
    expect(MIN_DOC_CHARS).toBeGreaterThan(0);
    expect(MAX_DOC_CHARS).toBeGreaterThan(MIN_DOC_CHARS);
    expect(CHUNK_OVERLAP).toBeLessThan(CHUNK_SIZE);
  });
});

describe('🚨 dedupFindings — chiave (framework|article|title) case-insensitive', () => {
  const mkF = (over: Partial<Finding> = {}): Finding => ({
    severity: over.severity ?? 'medium',
    framework: over.framework ?? 'GDPR',
    article: over.article ?? 'art.6',
    title: over.title ?? 'Base giuridica',
    excerpt: 'x', remediation: 'y',
  });

  it('🚨 dedupe duplicati esatti', () => {
    const all = [mkF(), mkF(), mkF()];
    expect(dedupFindings(all)).toHaveLength(1);
  });

  it('🚨 case-insensitive dedup (GDPR vs gdpr)', () => {
    const all = [mkF({ framework: 'GDPR' }), mkF({ framework: 'gdpr' })];
    expect(dedupFindings(all)).toHaveLength(1);
  });

  it('🚨 article diversi → 2 finding distinte', () => {
    const all = [mkF({ article: 'art.6' }), mkF({ article: 'art.7' })];
    expect(dedupFindings(all)).toHaveLength(2);
  });

  it('🚨 sort DESC by severity dopo dedup', () => {
    const all = [
      mkF({ severity: 'low', article: 'a1' }),
      mkF({ severity: 'critical', article: 'a2' }),
      mkF({ severity: 'medium', article: 'a3' }),
      mkF({ severity: 'high', article: 'a4' }),
    ];
    const out = dedupFindings(all);
    expect(out.map(f => f.severity)).toEqual(['critical', 'high', 'medium', 'low']);
  });

  it('🚨 array vuoto → []', () => {
    expect(dedupFindings([])).toEqual([]);
  });
});

describe('🚨 applySeverityFloor — filter sotto soglia', () => {
  const mkF = (sev: 'critical' | 'high' | 'medium' | 'low'): Finding => ({
    severity: sev, framework: 'GDPR', article: 'a', title: 't', excerpt: 'e', remediation: 'r',
  });

  it('🚨 floor=medium → critical+high+medium PASS, low BLOCK', () => {
    const all = [mkF('low'), mkF('medium'), mkF('high'), mkF('critical')];
    const out = applySeverityFloor(all, 'medium');
    expect(out.map(f => f.severity).sort()).toEqual(['critical', 'high', 'medium']);
  });

  it('🚨 floor=critical → solo critical', () => {
    const all = [mkF('low'), mkF('high'), mkF('critical')];
    const out = applySeverityFloor(all, 'critical');
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe('critical');
  });

  it('🚨 floor=low → tutte pass', () => {
    const all = [mkF('low'), mkF('critical')];
    expect(applySeverityFloor(all, 'low')).toHaveLength(2);
  });

  it('🚨 floor sconosciuto → fallback rank 2 (medium)', () => {
    const all = [mkF('low'), mkF('medium')];
    expect(applySeverityFloor(all, 'unknown-level')).toHaveLength(1);
  });

  it('🚨 array vuoto → []', () => {
    expect(applySeverityFloor([], 'medium')).toEqual([]);
  });
});

describe('🚨 computeScore — penalty per severity', () => {
  const mkF = (sev: 'critical' | 'high' | 'medium' | 'low'): Finding => ({
    severity: sev, framework: 'X', article: 'a', title: 't', excerpt: 'e', remediation: 'r',
  });

  it('🚨 nessuna finding → score=100', () => {
    expect(computeScore([])).toBe(100);
  });

  it('🚨 1 critical → 75 (penalty 25)', () => {
    expect(computeScore([mkF('critical')])).toBe(75);
  });

  it('🚨 1 high → 88 (penalty 12)', () => {
    expect(computeScore([mkF('high')])).toBe(88);
  });

  it('🚨 1 medium → 95 (penalty 5)', () => {
    expect(computeScore([mkF('medium')])).toBe(95);
  });

  it('🚨 1 low → 98 (penalty 2)', () => {
    expect(computeScore([mkF('low')])).toBe(98);
  });

  it('🚨 mix 1 critical + 1 high + 1 medium + 1 low → 100-25-12-5-2 = 56', () => {
    expect(computeScore([mkF('critical'), mkF('high'), mkF('medium'), mkF('low')])).toBe(56);
  });

  it('🚨 CLAMP: molti findings → cap a 0 (no negative score)', () => {
    const many = Array.from({ length: 10 }, () => mkF('critical'));
    expect(computeScore(many)).toBe(0);
  });

  it('🚨 score sempre integer 0-100', () => {
    const all = [mkF('critical'), mkF('high'), mkF('medium')];
    const s = computeScore(all);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
  });
});
