/**
 * Test legal-compliance executor.
 *
 * Fase 2 (#14): il transport è `llmResolver` + `dispatchLLMChat` (gateway
 * metered) — il vecchio `LIARA_URL/v1/complete` diretto non esisteva più
 * (401 sempre) → i mock sono sul SERVICE, non su safe-outbound-fetch.
 * Le asserzioni di dominio (chunking, dedup, severity floor, score) sono
 * INVARIATE: fissano l'equivalenza della logica attorno al transport.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  dispatch: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock('@/services/llm-chat.service.js', () => ({
  dispatchLLMChat: (...a: unknown[]) => m.dispatch(...a),
}));
vi.mock('@/services/llm-resolver.service.js', () => ({
  llmResolver: { resolve: (...a: unknown[]) => m.resolve(...a) },
}));

import { legalComplianceExecutor } from './legal-compliance.js';

const baseContext = {
  tenantId: 'tenant-test',
  runId: 'run-1',
  nodeId: 'node-1',
} as unknown as Parameters<typeof legalComplianceExecutor>[2];

/** Il service ritorna direttamente il TESTO della risposta del modello. */
const llmText = (body: unknown): string => JSON.stringify(body);

/** System prompt della chiamata i-esima (arg posizionale 3 di dispatchLLMChat). */
const sentSystem = (i = 0): string => m.dispatch.mock.calls[i]?.[3] as string;

const SHORT_PRIVACY = 'Privacy Policy. '.repeat(20); // 320 char, > MIN_DOC_CHARS

beforeEach(() => {
  vi.clearAllMocks();
  m.resolve.mockReturnValue({ provider: 'liara', apiKey: '', model: '' });
});

describe('legal-compliance executor — validation', () => {
  it('rejecta documentText vuoto', async () => {
    await expect(
      legalComplianceExecutor({ documentText: '' }, null, baseContext),
    ).rejects.toThrow(/obbligatorio/i);
  });

  it('rejecta documentText troppo corto (<200 char)', async () => {
    await expect(
      legalComplianceExecutor({ documentText: 'short' }, null, baseContext),
    ).rejects.toThrow(/troppo corto/i);
  });

  it('rejecta documentText troppo lungo (>200KB)', async () => {
    await expect(
      legalComplianceExecutor({ documentText: 'a'.repeat(200_001) }, null, baseContext),
    ).rejects.toThrow(/troppo lungo/i);
  });
});

describe('legal-compliance executor — analysis', () => {
  it('chunk singolo → 1 chiamata LLM, system con framework + compendio', async () => {
    m.dispatch.mockResolvedValue(llmText({
      findings: [
        { severity: 'high', framework: 'gdpr', article: 'GDPR art.13', title: 'Informativa mancante lingua italiana', excerpt: '...', remediation: 'Aggiungi informativa IT' },
      ],
      recommendations: [],
      summary: 'Documento incompleto.',
      detectedType: 'privacy_policy',
    }));
    const r = await legalComplianceExecutor(
      { documentText: SHORT_PRIVACY, frameworks: 'gdpr', documentType: 'auto' },
      null,
      baseContext,
    );
    const out = r.output as { findings: { framework: string }[]; chunksProcessed: number; detectedType: string };
    expect(m.dispatch).toHaveBeenCalledOnce();
    expect(out.chunksProcessed).toBe(1);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.framework).toBe('gdpr');
    expect(out.detectedType).toBe('privacy_policy');
    expect(sentSystem()).toMatch(/gdpr/i);
    // Provider risolto dal tenant (Liara default) e passato posizionale
    expect(m.resolve).toHaveBeenCalledWith('tenant-test');
    expect(m.dispatch.mock.calls[0]?.[0]).toBe('liara');
  });

  it('documento lungo → chunking + più chiamate LLM', async () => {
    m.dispatch.mockResolvedValue(llmText({ findings: [], recommendations: [], summary: 'OK' }));
    const longDoc = 'a'.repeat(10_000); // 10k → 3 chunks (4000 con overlap 200)
    const r = await legalComplianceExecutor(
      { documentText: longDoc, frameworks: 'gdpr' },
      null,
      baseContext,
    );
    const out = r.output as { chunksProcessed: number };
    expect(out.chunksProcessed).toBeGreaterThanOrEqual(2);
    expect(m.dispatch).toHaveBeenCalledTimes(out.chunksProcessed);
  });

  it('LLM error su 1 chunk → warning + processo continua', async () => {
    let call = 0;
    m.dispatch.mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error('gateway timeout');
      return llmText({ findings: [{ severity: 'low', framework: 'gdpr', article: 'art.7', title: 'minor', excerpt: '', remediation: '' }], summary: '' });
    });
    const longDoc = 'a'.repeat(8000);
    const r = await legalComplianceExecutor(
      { documentText: longDoc, frameworks: 'gdpr', severityFloor: 'low' },
      null,
      baseContext,
    );
    const out = r.output as { warnings: string[]; findings: unknown[] };
    expect(out.warnings.some((w) => /chunk 1.*failed/i.test(w))).toBe(true);
    expect(out.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('LLM risponde JSON malformato → continue silenzioso (no findings da quel chunk)', async () => {
    m.dispatch.mockResolvedValue('not json at all');
    const r = await legalComplianceExecutor(
      { documentText: SHORT_PRIVACY, frameworks: 'gdpr' },
      null,
      baseContext,
    );
    const out = r.output as { findings: unknown[]; chunksProcessed: number };
    expect(out.findings).toEqual([]);
    expect(out.chunksProcessed).toBe(1);
  });

  it('🚨 nessun provider LLM (resolver throw) → warning, NESSUNA chiamata, no throw', async () => {
    m.resolve.mockImplementation(() => { throw new Error('nessun provider configurato'); });
    m.dispatch.mockResolvedValue(llmText({ findings: [], summary: '' }));
    const r = await legalComplianceExecutor(
      { documentText: SHORT_PRIVACY, frameworks: 'gdpr' },
      null,
      baseContext,
    );
    const out = r.output as { warnings: string[]; findings: unknown[] };
    expect(m.dispatch).not.toHaveBeenCalled();
    expect(out.warnings.some((w) => /provider non disponibile/i.test(w))).toBe(true);
    expect(out.findings).toEqual([]);
  });
});

describe('legal-compliance executor — dedup + sort + severity floor', () => {
  it('findings duplicati cross-chunk → deduplicati', async () => {
    m.dispatch.mockResolvedValue(llmText({
      findings: [
        { severity: 'high', framework: 'gdpr', article: 'GDPR art.13', title: 'Stesso titolo', excerpt: 'a', remediation: 'fix' },
      ],
      summary: '',
    }));
    const longDoc = 'b'.repeat(10_000); // multi-chunk, ogni chunk produce stesso finding
    const r = await legalComplianceExecutor(
      { documentText: longDoc, frameworks: 'gdpr' },
      null,
      baseContext,
    );
    const out = r.output as { findings: unknown[]; chunksProcessed: number };
    expect(out.chunksProcessed).toBeGreaterThanOrEqual(2);
    expect(out.findings).toHaveLength(1); // dedupped
  });

  it('findings ordinati per severity desc (critical → high → medium → low)', async () => {
    m.dispatch.mockResolvedValue(llmText({
      findings: [
        { severity: 'low', framework: 'gdpr', article: 'a1', title: 'low one', excerpt: '', remediation: '' },
        { severity: 'critical', framework: 'gdpr', article: 'a2', title: 'crit', excerpt: '', remediation: '' },
        { severity: 'medium', framework: 'gdpr', article: 'a3', title: 'med', excerpt: '', remediation: '' },
        { severity: 'high', framework: 'gdpr', article: 'a4', title: 'high', excerpt: '', remediation: '' },
      ],
      summary: '',
    }));
    const r = await legalComplianceExecutor(
      { documentText: SHORT_PRIVACY, frameworks: 'gdpr', severityFloor: 'low' },
      null,
      baseContext,
    );
    const out = r.output as { findings: { severity: string }[] };
    expect(out.findings.map((f) => f.severity)).toEqual(['critical', 'high', 'medium', 'low']);
  });

  it('severityFloor=high → filtra low e medium', async () => {
    m.dispatch.mockResolvedValue(llmText({
      findings: [
        { severity: 'low', framework: 'gdpr', article: 'a1', title: 'low', excerpt: '', remediation: '' },
        { severity: 'medium', framework: 'gdpr', article: 'a2', title: 'med', excerpt: '', remediation: '' },
        { severity: 'high', framework: 'gdpr', article: 'a3', title: 'high', excerpt: '', remediation: '' },
        { severity: 'critical', framework: 'gdpr', article: 'a4', title: 'crit', excerpt: '', remediation: '' },
      ],
      summary: '',
    }));
    const r = await legalComplianceExecutor(
      { documentText: SHORT_PRIVACY, frameworks: 'gdpr', severityFloor: 'high' },
      null,
      baseContext,
    );
    const out = r.output as { findings: { severity: string }[] };
    expect(out.findings.map((f) => f.severity)).toEqual(['critical', 'high']);
  });
});

describe('legal-compliance executor — score', () => {
  it('compliance perfect (0 findings) → score 100', async () => {
    m.dispatch.mockResolvedValue(llmText({ findings: [], summary: 'tutto a posto' }));
    const r = await legalComplianceExecutor(
      { documentText: SHORT_PRIVACY, frameworks: 'gdpr' },
      null,
      baseContext,
    );
    expect((r.output as { score: number }).score).toBe(100);
  });

  it('1 critical → score 75', async () => {
    m.dispatch.mockResolvedValue(llmText({
      findings: [{ severity: 'critical', framework: 'gdpr', article: 'a', title: 't', excerpt: '', remediation: '' }],
    }));
    const r = await legalComplianceExecutor(
      { documentText: SHORT_PRIVACY, frameworks: 'gdpr', severityFloor: 'low' },
      null,
      baseContext,
    );
    expect((r.output as { score: number }).score).toBe(75);
  });

  it('molti findings critical → score floor 0', async () => {
    m.dispatch.mockResolvedValue(llmText({
      findings: Array.from({ length: 10 }, (_, i) => ({
        severity: 'critical', framework: 'gdpr', article: `a${String(i)}`, title: `t${String(i)}`, excerpt: '', remediation: '',
      })),
    }));
    const r = await legalComplianceExecutor(
      { documentText: SHORT_PRIVACY, frameworks: 'gdpr' },
      null,
      baseContext,
    );
    expect((r.output as { score: number }).score).toBe(0);
  });
});

describe('legal-compliance executor — knowledge mode', () => {
  it('system prompt include SEMPRE il compendio normative inline', async () => {
    m.dispatch.mockResolvedValue(llmText({ findings: [], summary: '' }));
    await legalComplianceExecutor(
      { documentText: SHORT_PRIVACY, frameworks: 'gdpr' },
      null,
      baseContext,
    );
    expect(sentSystem()).toMatch(/GDPR[\s\S]*art\.5/i);
    expect(sentSystem()).toMatch(/eIDAS|AI Act|DPR 445/);
  });

  it('🚨 useExternalKb=true → warning esplicito (KB esterno era feature del vecchio endpoint, MAI funzionante) + knowledgeMode inline', async () => {
    m.dispatch.mockResolvedValue(llmText({ findings: [], summary: '' }));
    const r = await legalComplianceExecutor(
      { documentText: SHORT_PRIVACY, frameworks: 'gdpr', useExternalKb: 'true' },
      null,
      baseContext,
    );
    const out = r.output as { knowledgeMode: string; warnings: string[] };
    expect(out.knowledgeMode).toBe('inline_compendium');
    expect(out.warnings.some((w) => /KB esterno non supportato/i.test(w))).toBe(true);
  });

  it('output include knowledgeMode = inline_compendium di default', async () => {
    m.dispatch.mockResolvedValue(llmText({ findings: [], summary: '' }));
    const r = await legalComplianceExecutor(
      { documentText: SHORT_PRIVACY, frameworks: 'gdpr' },
      null,
      baseContext,
    );
    expect((r.output as { knowledgeMode: string }).knowledgeMode).toBe('inline_compendium');
  });
});

describe('legal-compliance executor — _llm usage (Fase 2 #14)', () => {
  it('usage CUMULATIVO sui chunk: N chiamate → somma in output._llm', async () => {
    m.dispatch.mockImplementation(async (...args: unknown[]) => {
      const listener = args[7] as ((u: { input: number; output: number; fromApi: boolean }) => void) | undefined;
      listener?.({ input: 100, output: 30, fromApi: true });
      return llmText({ findings: [], summary: '' });
    });
    const longDoc = 'a'.repeat(8000); // ≥ 2 chunk
    const r = await legalComplianceExecutor(
      { documentText: longDoc, frameworks: 'gdpr' },
      null,
      baseContext,
    );
    const out = r.output as { _llm: { inputTokens: number; outputTokens: number; provider: string; model: string; fromApi: boolean }; chunksProcessed: number };
    expect(out.chunksProcessed).toBeGreaterThanOrEqual(2);
    expect(out._llm.inputTokens).toBe(100 * out.chunksProcessed);
    expect(out._llm.outputTokens).toBe(30 * out.chunksProcessed);
    expect(out._llm).toMatchObject({ provider: 'liara', model: 'liara-default', fromApi: true });
  });

  it('una chiamata stimata (fromApi:false) → fromApi cumulativo false', async () => {
    let call = 0;
    m.dispatch.mockImplementation(async (...args: unknown[]) => {
      call++;
      const listener = args[7] as ((u: { input: number; output: number; fromApi: boolean }) => void) | undefined;
      listener?.({ input: 10, output: 5, fromApi: call !== 2 });
      return llmText({ findings: [], summary: '' });
    });
    const r = await legalComplianceExecutor(
      { documentText: 'a'.repeat(8000), frameworks: 'gdpr' },
      null,
      baseContext,
    );
    expect((r.output as { _llm: { fromApi: boolean } })._llm.fromApi).toBe(false);
  });

  it('nessuna chiamata riuscita a fare usage (provider assente) → output SENZA _llm', async () => {
    m.resolve.mockImplementation(() => { throw new Error('no provider'); });
    const r = await legalComplianceExecutor(
      { documentText: SHORT_PRIVACY, frameworks: 'gdpr' },
      null,
      baseContext,
    );
    expect('_llm' in (r.output as Record<string, unknown>)).toBe(false);
  });
});

describe('legal-compliance executor — output shape', () => {
  it('output contiene frameworks parsed + checkedAt ISO', async () => {
    m.dispatch.mockResolvedValue(llmText({ findings: [], summary: 's' }));
    const r = await legalComplianceExecutor(
      { documentText: SHORT_PRIVACY, frameworks: 'gdpr,eidas,ai_act' },
      null,
      baseContext,
    );
    const out = r.output as { frameworks: string[]; checkedAt: string; summary: string };
    expect(out.frameworks).toEqual(['gdpr', 'eidas', 'ai_act']);
    expect(out.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(out.summary).toBe('s');
  });
});
