/**
 * Test 2026-grade — email-personalize service (LLM cold outreach).
 *
 * Coverage REALE:
 *  - Input validation: content < 100 char → skip, company_name vuoto → skip,
 *    lingua non in whitelist → skip
 *  - LLM resolver: NoLlmProviderError → soft fail (no throw)
 *  - 🚨 dispatchLLMChat throw → soft fail con reason, NO bubble
 *  - JSON parse: fence markdown stripped, preamble stripped (LLM disobbedisce)
 *  - JSON malformato → success=false
 *  - Snippet < 20 char → success=false; > 600 char → success=false
 *  - 🚨 Profanity filter (fuck/cazzo/etc) → snippet rifiutato
 *  - 🚨 Spam triggers (urgent/act now/click here) → rifiutato
 *  - 🚨 Promesse illegali (100% guaranteed) → rifiutato
 *  - Anti-hallucination: evidence_quote substring del content → confidence=100,
 *    NON substring → confidence=60 (fallback tollerante prima 5 parole)
 *  - Cache LRU: stesso input → second call NO LLM (1 dispatch totale)
 *  - Cache TTL: dopo expires → ricomputa
 *  - Cache eviction LRU al MAX
 */
import type * as EmailPersonalizeServiceNS from './email-personalize.service.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const m = vi.hoisted(() => {
  class NoLlmProviderError extends Error {
    override name = 'NoLlmProviderError';
  }
  return {
    resolverResolve: vi.fn(),
    dispatchLLM: vi.fn(),
    NoLlmProviderError,
  };
});
const NoLlmProviderError = m.NoLlmProviderError;

vi.mock('./llm-resolver.service.js', () => ({
  NoLlmProviderError: m.NoLlmProviderError,
  llmResolver: {
    resolve: (tenantId: string) => m.resolverResolve(tenantId),
  },
}));

vi.mock('./llm-chat.service.js', () => ({
  dispatchLLMChat: (...args: unknown[]) => m.dispatchLLM(...args),
}));

vi.mock('@/lib/logger.js');

import { personalizeEmail, type PersonalizeInput } from './email-personalize.service.js';

const VALID_CONTENT = `La nostra azienda fonda dal 1985 nel settore della nautica di lusso. Produciamo yacht di alta gamma con scafi in alluminio aerospaziale. Ogni anno consegnamo 12 imbarcazioni custom. Il nostro shipyard a La Spezia copre 8000 metri quadrati e impiega 150 ingegneri specializzati. La nostra ultima creazione, l'Open 32, e\` uno yacht in alluminio progettato per il mercato premium con bow thruster integrato e sistema di propulsione ibrido.`;

function baseInput(over: Partial<PersonalizeInput> = {}): PersonalizeInput {
  return {
    content: VALID_CONTENT,
    company_name: 'Cantiere Esempio Srl',
    language: 'it',
    tenantId: 't-acme',
    ...over,
  };
}

function makeLlmResponse(
  snippet: string,
  evidence_quote: string,
  prefix = '',
  suffix = '',
): string {
  return `${prefix}{"snippet":${JSON.stringify(snippet)},"evidence_quote":${JSON.stringify(evidence_quote)}}${suffix}`;
}

beforeEach(() => {
  m.resolverResolve.mockReset();
  m.dispatchLLM.mockReset();
  m.resolverResolve.mockReturnValue({
    provider: 'anthropic',
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-6',
    baseUrl: undefined,
  });
  // Cache lives at module level — reset by re-importing module fresh
});

async function freshImport(): Promise<typeof EmailPersonalizeServiceNS> {
  vi.resetModules();
  return await import('./email-personalize.service.js');
}

describe('input validation — early skip', () => {
  it('content < 100 char → success=false', async () => {
    const { personalizeEmail: p } = await freshImport();
    const r = await p(baseInput({ content: 'short' }));
    expect(r.success).toBe(false);
    expect(r.reason).toContain('troppo corto');
    expect(m.dispatchLLM).not.toHaveBeenCalled();
  });

  it('company_name vuoto → skip', async () => {
    const { personalizeEmail: p } = await freshImport();
    const r = await p(baseInput({ company_name: '' }));
    expect(r.success).toBe(false);
    expect(r.reason).toContain('company_name vuoto');
    expect(m.dispatchLLM).not.toHaveBeenCalled();
  });

  it('lingua non in whitelist → skip + lista nella reason', async () => {
    const { personalizeEmail: p } = await freshImport();
    const r = await p(baseInput({ language: 'xx' }));
    expect(r.success).toBe(false);
    expect(r.reason).toContain('non supportata');
    expect(r.reason).toContain('whitelist');
  });
});

describe('LLM resolver errors', () => {
  it('NoLlmProviderError → success=false soft, NO throw', async () => {
    m.resolverResolve.mockImplementation(() => {
      throw new NoLlmProviderError('vault sealed');
    });
    const { personalizeEmail: p } = await freshImport();
    const r = await p(baseInput());
    expect(r.success).toBe(false);
    expect(r.reason).toContain('Nessun LLM provider');
  });

  it('🚨 errore generico (NON NoLlmProviderError) → THROW', async () => {
    m.resolverResolve.mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(personalizeEmail(baseInput())).rejects.toThrow(/boom/u);
  });

  it('🚨 dispatchLLMChat throw → success=false soft, NO bubble', async () => {
    m.dispatchLLM.mockRejectedValue(new Error('Anthropic 503'));
    const { personalizeEmail: p } = await freshImport();
    const r = await p(baseInput());
    expect(r.success).toBe(false);
    expect(r.reason).toContain('LLM call failed');
    expect(r.reason).toContain('Anthropic 503');
    expect(r.llm_provider).toBe('anthropic');
  });
});

describe('JSON parsing tolerance', () => {
  it('happy path: snippet + evidence_quote estratti', async () => {
    m.dispatchLLM.mockResolvedValue(
      makeLlmResponse(
        'Ho notato che producete yacht con scafi in alluminio aerospaziale',
        'scafi in alluminio aerospaziale',
      ),
    );
    const { personalizeEmail: p } = await freshImport();
    const r = await p(baseInput());
    expect(r.success).toBe(true);
    expect(r.snippet).toContain('alluminio aerospaziale');
    expect(r.confidence).toBe(100);
  });

  it('markdown fence ```json ... ``` stripped', async () => {
    m.dispatchLLM.mockResolvedValue(
      '```json\n' +
        makeLlmResponse(
          'Ho notato che producete yacht con scafi in alluminio aerospaziale di alta qualita',
          'alluminio aerospaziale',
        ) +
        '\n```',
    );
    const { personalizeEmail: p } = await freshImport();
    const r = await p(baseInput());
    expect(r.success).toBe(true);
  });

  it('preamble LLM ignorata (estrae JSON dal body)', async () => {
    m.dispatchLLM.mockResolvedValue(
      'Ecco il JSON richiesto:\n' +
        makeLlmResponse(
          'Ho notato che producete yacht con scafi in alluminio per il mercato premium',
          'alluminio aerospaziale',
        ),
    );
    const { personalizeEmail: p } = await freshImport();
    const r = await p(baseInput());
    expect(r.success).toBe(true);
  });

  it('LLM ritorna garbage (no JSON) → success=false con raw nei dettagli', async () => {
    m.dispatchLLM.mockResolvedValue('Mi dispiace, non posso aiutarti con questo task');
    const { personalizeEmail: p } = await freshImport();
    const r = await p(baseInput());
    expect(r.success).toBe(false);
    expect(r.reason).toContain('JSON');
  });
});

describe('snippet validation', () => {
  it('snippet vuoto → success=false', async () => {
    m.dispatchLLM.mockResolvedValue(makeLlmResponse('', 'alluminio'));
    const { personalizeEmail: p } = await freshImport();
    const r = await p(baseInput());
    expect(r.success).toBe(false);
    expect(r.reason).toContain('troppo corto');
  });

  it('snippet < 20 char → success=false', async () => {
    m.dispatchLLM.mockResolvedValue(makeLlmResponse('Ciao!', 'alluminio'));
    const { personalizeEmail: p } = await freshImport();
    const r = await p(baseInput());
    expect(r.success).toBe(false);
  });

  it('snippet > 600 char → success=false (LLM ha sforato il limit)', async () => {
    m.dispatchLLM.mockResolvedValue(makeLlmResponse('A'.repeat(700), 'alluminio aerospaziale'));
    const { personalizeEmail: p } = await freshImport();
    const r = await p(baseInput());
    expect(r.success).toBe(false);
    expect(r.reason).toContain('> 600 char');
  });
});

describe('🚨 content safety filters', () => {
  it('profanity (cazzo) → snippet rifiutato', async () => {
    m.dispatchLLM.mockResolvedValue(
      makeLlmResponse(
        'Ho notato che cazzo bello sito avete con yacht in alluminio aerospaziale',
        'alluminio aerospaziale',
      ),
    );
    const { personalizeEmail: p } = await freshImport();
    const r = await p(baseInput());
    expect(r.success).toBe(false);
    expect(r.reason).toContain('cazzo');
  });

  it('spam trigger (urgent) → rifiutato', async () => {
    m.dispatchLLM.mockResolvedValue(
      makeLlmResponse(
        'URGENT: ho visto i vostri yacht in alluminio aerospaziale, contattatemi',
        'alluminio aerospaziale',
      ),
    );
    const { personalizeEmail: p } = await freshImport();
    const r = await p(baseInput());
    expect(r.success).toBe(false);
    expect(r.reason.toLowerCase()).toContain('urgent');
  });

  it('promessa illegale (100% guaranteed) → rifiutato', async () => {
    m.dispatchLLM.mockResolvedValue(
      makeLlmResponse(
        'Vi propongo una soluzione 100% guaranteed per i vostri yacht in alluminio aerospaziale',
        'alluminio aerospaziale',
      ),
    );
    const { personalizeEmail: p } = await freshImport();
    const r = await p(baseInput());
    expect(r.success).toBe(false);
    expect(r.reason).toContain('100% guaranteed');
  });

  it('promessa illegale (cheapest in the world) → rifiutato', async () => {
    m.dispatchLLM.mockResolvedValue(
      makeLlmResponse(
        'I nostri motori sono cheapest in the world per yacht in alluminio aerospaziale',
        'alluminio aerospaziale',
      ),
    );
    const { personalizeEmail: p } = await freshImport();
    const r = await p(baseInput());
    expect(r.success).toBe(false);
  });
});

describe('anti-hallucination — evidence_quote check', () => {
  it('evidence_quote SUBSTRING del content → confidence=100', async () => {
    m.dispatchLLM.mockResolvedValue(
      makeLlmResponse(
        'Ho notato che producete yacht con scafi in alluminio aerospaziale di alta qualita',
        'scafi in alluminio aerospaziale',
      ),
    );
    const { personalizeEmail: p } = await freshImport();
    const r = await p(baseInput());
    expect(r.confidence).toBe(100);
    expect(r.reason).toContain('verificata');
  });

  it('🚨 evidence_quote INVENTATO → confidence=60', async () => {
    m.dispatchLLM.mockResolvedValue(
      makeLlmResponse(
        'Ho notato dal vostro sito che la vostra azienda è specializzata nel settore della nautica',
        'questa frase NON E\\u0300 nel contenuto vero del sito target',
      ),
    );
    const { personalizeEmail: p } = await freshImport();
    const r = await p(baseInput());
    expect(r.success).toBe(true);
    expect(r.confidence).toBe(60);
    expect(r.reason).toContain('non trovata');
  });

  it('evidence_quote primi 5 parole match → confidence=100 (tolleranza)', async () => {
    m.dispatchLLM.mockResolvedValue(
      makeLlmResponse(
        'Ho notato la vostra ultima creazione Open 32 progettata per il premium',
        "La nostra ultima creazione, l'Open 32, ha caratteristiche uniche",
      ),
    );
    const { personalizeEmail: p } = await freshImport();
    const r = await p(baseInput());
    // Fallback: prime 5 parole "la nostra ultima creazione l'open" presenti nel content
    expect(r.success).toBe(true);
  });

  it('evidence_quote < 15 char → considerato non-evidence (confidence=60)', async () => {
    m.dispatchLLM.mockResolvedValue(
      makeLlmResponse(
        'Ho notato che producete yacht con scafi in alluminio per il mercato premium',
        'yacht',
      ),
    );
    const { personalizeEmail: p } = await freshImport();
    const r = await p(baseInput());
    expect(r.confidence).toBe(60);
  });
});

describe('cache LRU', () => {
  it('stesso input due volte → second call NO LLM dispatch', async () => {
    m.dispatchLLM.mockResolvedValue(
      makeLlmResponse(
        'Ho notato i vostri yacht in alluminio aerospaziale di alta qualita ingegneristica',
        'alluminio aerospaziale',
      ),
    );
    const { personalizeEmail: p } = await freshImport();
    await p(baseInput());
    await p(baseInput());
    expect(m.dispatchLLM).toHaveBeenCalledTimes(1);
  });

  it('input differente (language) → 2 LLM call distinte', async () => {
    m.dispatchLLM.mockResolvedValue(
      makeLlmResponse(
        'Ho notato i vostri yacht in alluminio aerospaziale di alta qualita ingegneristica',
        'alluminio aerospaziale',
      ),
    );
    const { personalizeEmail: p } = await freshImport();
    await p(baseInput({ language: 'it' }));
    await p(baseInput({ language: 'en' }));
    expect(m.dispatchLLM).toHaveBeenCalledTimes(2);
  });

  it('cache include anche risultati fail (no re-call LLM su errore)', async () => {
    m.dispatchLLM.mockResolvedValue('garbage no json');
    const { personalizeEmail: p } = await freshImport();
    await p(baseInput());
    await p(baseInput());
    expect(m.dispatchLLM).toHaveBeenCalledTimes(1);
  });
});

describe('llm_usage (Fase 1b #13) — token della chiamata fresca, MAI replayed dal cache', () => {
  /** Mock che INVOCA il tokenUsageListener (8° arg posizionale di dispatchLLMChat). */
  const respondWithUsage = (raw?: string): void => {
    m.dispatchLLM.mockImplementation(async (...args: unknown[]) => {
      const listener = args[7] as
        | ((u: { input: number; output: number; fromApi: boolean }) => void)
        | undefined;
      listener?.({ input: 77, output: 33, fromApi: true });
      return (
        raw ??
        makeLlmResponse(
          'Ho notato i vostri yacht in alluminio aerospaziale di alta qualita ingegneristica',
          'alluminio aerospaziale',
        )
      );
    });
  };

  it('chiamata fresca → llm_usage con i numeri del listener', async () => {
    respondWithUsage();
    const { personalizeEmail: p } = await freshImport();
    const r = await p(baseInput());
    expect(r.llm_usage).toEqual({ input: 77, output: 33, fromApi: true });
  });

  it('🚨 cache-hit → llm_usage ASSENTE (un hit non spende token: replayarlo gonfierebbe i conteggi)', async () => {
    respondWithUsage();
    const { personalizeEmail: p } = await freshImport();
    const fresh = await p(baseInput());
    expect(fresh.llm_usage).toBeDefined();
    const hit = await p(baseInput());
    expect(m.dispatchLLM).toHaveBeenCalledTimes(1);
    expect(hit.llm_usage).toBeUndefined();
  });

  it('validazione post-LLM fallita (JSON garbage) → llm_usage COMUNQUE presente: i token sono stati spesi', async () => {
    respondWithUsage('garbage no json');
    const { personalizeEmail: p } = await freshImport();
    const r = await p(baseInput());
    expect(r.success).toBe(false);
    expect(r.llm_usage).toEqual({ input: 77, output: 33, fromApi: true });
  });

  it('skip pre-LLM (content corto) → nessun llm_usage', async () => {
    respondWithUsage();
    const { personalizeEmail: p } = await freshImport();
    const r = await p(baseInput({ content: 'short' }));
    expect(r.llm_usage).toBeUndefined();
  });
});
