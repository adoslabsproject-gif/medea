/**
 * Bug-bounty UNIT — executors/email-personalize.ts (audit coverage 2026-06-12:
 * 6%). Il service (LLM-backed) è mockato; si pinna la RESPONSABILITÀ
 * dell'executor: validazione dei 3 campi obbligatori, normalizzazione
 * (language lowercase, tone whitelist formal/conversational, trim),
 * propagazione del tenantId dal context, senderProductContext solo se
 * presente, mapping completo dell'output.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const personalizeMock = vi.fn();
vi.mock('@/services/email-personalize.service.js', () => ({
  personalizeEmail: (...a: unknown[]) => personalizeMock(...a),
}));

import { emailPersonalizeExecutor } from './email-personalize.js';

const ctx = (tenantId = 'tenant-x') =>
  ({
    workflowId: 'wf',
    runId: 'r',
    nodeId: 'n',
    tenantId,
    userId: 'u',
    defId: 'action_email_personalize',
    secrets: {},
    llmProviders: [],
    nodeOutputs: {},
  }) as unknown as Parameters<typeof emailPersonalizeExecutor>[2];

const run = (config: Record<string, unknown>, tenantId?: string) =>
  emailPersonalizeExecutor(config as never, null as never, ctx(tenantId));

const VALID = { content: 'azienda nautica', company_name: 'Cantiere X', language: 'IT' };

beforeEach(() => {
  personalizeMock.mockReset();
  personalizeMock.mockResolvedValue({
    snippet: 'ciao',
    evidence_quote: 'nautica',
    confidence: 80,
    success: true,
    reason: 'ok',
    llm_provider: 'liara',
    llm_model: 'qwen',
  });
});

describe('email-personalize — validazione (3 obbligatori)', () => {
  it('content mancante → throw', async () => {
    await expect(run({ company_name: 'X', language: 'it' })).rejects.toThrow(
      /content è obbligatorio/,
    );
  });
  it('company_name mancante → throw', async () => {
    await expect(run({ content: 'x', language: 'it' })).rejects.toThrow(
      /company_name è obbligatorio/,
    );
  });
  it('language mancante → throw (codice 2-letter)', async () => {
    await expect(run({ content: 'x', company_name: 'X' })).rejects.toThrow(
      /language è obbligatorio/,
    );
  });
  it('validazione fallita → il service NON viene chiamato', async () => {
    await run({}).catch(() => undefined);
    expect(personalizeMock).not.toHaveBeenCalled();
  });
});

describe('email-personalize — normalizzazione argomenti', () => {
  it('language → lowercase; tenantId preso dal context', async () => {
    await run({ ...VALID, language: 'IT' }, 'tenant-42');
    const arg = personalizeMock.mock.calls[0]![0] as { language: string; tenantId: string };
    expect(arg.language).toBe('it');
    expect(arg.tenantId).toBe('tenant-42');
  });

  it('tone: valore ignoto → fallback "formal"; "conversational" preservato', async () => {
    await run({ ...VALID, tone: 'aggressive' });
    expect((personalizeMock.mock.calls[0]![0] as { tone: string }).tone).toBe('formal');
    await run({ ...VALID, tone: 'conversational' });
    expect((personalizeMock.mock.calls[1]![0] as { tone: string }).tone).toBe('conversational');
  });

  it('senderProductContext: presente → passato; assente → chiave OMESSA (non stringa vuota)', async () => {
    await run({ ...VALID, sender_product_context: '  eliche di prua  ' });
    expect(
      (personalizeMock.mock.calls[0]![0] as { senderProductContext?: string }).senderProductContext,
    ).toBe('eliche di prua');
    await run({ ...VALID });
    expect('senderProductContext' in (personalizeMock.mock.calls[1]![0] as object)).toBe(false);
  });
});

describe('email-personalize — mapping output', () => {
  it('tutti i campi del service mappati 1:1 nell output del nodo', async () => {
    const res = await run(VALID);
    expect(res.output).toEqual({
      snippet: 'ciao',
      evidence_quote: 'nautica',
      confidence: 80,
      success: true,
      reason: 'ok',
      llm_provider: 'liara',
      llm_model: 'qwen',
    });
  });

  it('llm_provider/llm_model assenti dal service → null (non undefined)', async () => {
    personalizeMock.mockResolvedValue({
      snippet: '',
      evidence_quote: '',
      confidence: 0,
      success: false,
      reason: 'llm fail',
    });
    const res = await run(VALID);
    const o = res.output as { llm_provider: unknown; llm_model: unknown; success: boolean };
    expect(o.llm_provider).toBeNull();
    expect(o.llm_model).toBeNull();
    expect(o.success).toBe(false);
  });

  // Fase 1b (#13): llm_usage del service → campo standard _llm del nodo.
  it('service con llm_usage → output._llm standard {inputTokens,outputTokens,model,provider,fromApi}', async () => {
    personalizeMock.mockResolvedValue({
      snippet: 'ciao',
      evidence_quote: 'nautica',
      confidence: 80,
      success: true,
      reason: 'ok',
      llm_provider: 'liara',
      llm_model: 'qwen',
      llm_usage: { input: 77, output: 33, fromApi: true },
    });
    const res = await run(VALID);
    expect((res.output as { _llm: unknown })._llm).toEqual({
      inputTokens: 77,
      outputTokens: 33,
      model: 'qwen',
      provider: 'liara',
      fromApi: true,
    });
  });

  it('service SENZA llm_usage (cache-hit / skip pre-LLM) → output SENZA chiave _llm', async () => {
    const res = await run(VALID);
    expect('_llm' in (res.output as Record<string, unknown>)).toBe(false);
  });
});
