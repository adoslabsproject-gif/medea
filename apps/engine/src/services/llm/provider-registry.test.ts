/**
 * Test del registry SSOT provider→endpoint. Tre livelli:
 *   1. UNIT esaustivo  — ogni provider: url/model/auth/tool-compat corretti.
 *   2. CONTRACT anti-drift — la spec copre ESATTAMENTE i provider del service
 *      (aggiungere un provider senza spec, o viceversa, → rosso).
 *   3. INVARIANTI — proprietà che valgono per OGNI spec (no buchi silenziosi).
 *
 * @module services/llm/provider-registry.test
 */
import { describe, it, expect } from 'vitest';
import {
  getProviderSpec,
  resolveToolEndpoint,
  chatCapableProviders,
  isKnownProvider,
  fixedOpenAiCompatTarget,
  isFixedOpenAiCompat,
  type ProviderSpec,
} from './provider-registry.js';
import { SUPPORTED_PROVIDERS, type LlmProvider } from '../llm-providers.service.js';

describe('provider-registry — CONTRACT anti-drift', () => {
  it('ogni provider di SUPPORTED_PROVIDERS ha una spec nel registry', () => {
    for (const p of SUPPORTED_PROVIDERS) {
      expect(() => getProviderSpec(p), `manca spec per "${p}"`).not.toThrow();
    }
  });

  it('il registry NON ha provider sconosciuti al service (no spec orfane)', () => {
    // chatCapableProviders + voyage devono essere ⊆ SUPPORTED_PROVIDERS
    const known = new Set<string>(SUPPORTED_PROVIDERS);
    for (const p of [...chatCapableProviders(), 'voyage' as LlmProvider]) {
      expect(known.has(p), `spec orfana: "${p}" non è in SUPPORTED_PROVIDERS`).toBe(true);
    }
  });

  it('isKnownProvider riconosce i noti e rifiuta gli ignoti', () => {
    expect(isKnownProvider('openai')).toBe(true);
    expect(isKnownProvider('grok')).toBe(true);
    expect(isKnownProvider('deepseek')).toBe(true);
    expect(isKnownProvider('bogus')).toBe(false);
  });
});

describe('provider-registry — INVARIANTI per ogni spec', () => {
  const all = SUPPORTED_PROVIDERS;

  it('ogni spec ha modelli definiti (chatModel può essere "" solo se gateway)', () => {
    for (const p of all) {
      const s = getProviderSpec(p);
      expect(typeof s.chatModel, p).toBe('string');
      expect(s.pingModel.length, `pingModel vuoto per ${p}`).toBeGreaterThan(0);
    }
  });

  it('solo OpenRouter ha chatModel vuoto (gateway: model obbligatorio)', () => {
    const empties = all.filter((p) => getProviderSpec(p).chatModel === '');
    expect(empties.sort()).toEqual(['liara', 'openrouter'].sort());
    // liara: il modello è scelto dal gateway portal; openrouter: lo deve dare l'utente.
  });

  it('fixed endpoint → URL https assoluto; self-host → defaultBaseUrl + path', () => {
    for (const p of all) {
      const e = getProviderSpec(p).endpoint;
      if (e.kind === 'fixed') {
        expect(e.chatUrl, p).toMatch(/^https:\/\//u);
      } else {
        expect(e.defaultBaseUrl, p).toMatch(/^https?:\/\//u);
        expect(e.chatPath.startsWith('/'), p).toBe(true);
        expect(e.toolPath.startsWith('/'), p).toBe(true);
      }
    }
  });

  it('tool-compat ⇒ resolveToolEndpoint non-null; non-compat ⇒ null', () => {
    for (const p of all) {
      const s = getProviderSpec(p);
      const r = resolveToolEndpoint(p, '', 'https://base.test');
      if (s.openAiToolCompat) expect(r, `${p} dovrebbe essere tool-compat`).not.toBeNull();
      else expect(r, `${p} NON dovrebbe essere tool-compat`).toBeNull();
    }
  });
});

describe('provider-registry — URL endpoint esatti (anti-regressione hard)', () => {
  // I valori esatti: se cambiano, è una decisione esplicita, non un refuso.
  const CASES: [LlmProvider, string][] = [
    ['openai', 'https://api.openai.com/v1/chat/completions'],
    ['mistral', 'https://api.mistral.ai/v1/chat/completions'],
    ['groq', 'https://api.groq.com/openai/v1/chat/completions'],
    ['grok', 'https://api.x.ai/v1/chat/completions'],
    ['deepseek', 'https://api.deepseek.com/v1/chat/completions'],
    ['openrouter', 'https://openrouter.ai/api/v1/chat/completions'],
  ];
  it.each(CASES)('%s → tool endpoint %s', (provider, url) => {
    expect(resolveToolEndpoint(provider, 'm')?.url).toBe(url);
  });

  it("gemini tool-calling usa l'endpoint OpenAI-compat di Google (NON generateContent)", () => {
    const r = resolveToolEndpoint('gemini', 'gemini-2.0-flash');
    expect(r?.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(r?.url).not.toContain('generateContent');
  });

  it('anthropic NON è tool-compat (formato /v1/messages) → null, niente instradamento sbagliato', () => {
    expect(resolveToolEndpoint('anthropic', 'claude')).toBeNull();
  });

  it('voyage (embeddings) → null, non è un chat provider', () => {
    expect(resolveToolEndpoint('voyage', '')).toBeNull();
    expect(chatCapableProviders()).not.toContain('voyage');
  });

  // ── Perplexity Sonar (aggiunto 2026-06-19): OpenAI-compat per la CHAT, ma
  //    NON tool-compat (niente function-calling) → instradamento DB-agent bloccato.
  it('perplexity → chat OpenAI-compat su api.perplexity.ai, model default "sonar"', () => {
    expect(isFixedOpenAiCompat('perplexity')).toBe(true);
    const t = fixedOpenAiCompatTarget('perplexity', '');
    expect(t.url).toBe('https://api.perplexity.ai/chat/completions');
    expect(t.model).toBe('sonar');
  });

  it('perplexity NON è tool-compat → resolveToolEndpoint null (no DB-agent routing)', () => {
    expect(resolveToolEndpoint('perplexity', 'sonar')).toBeNull();
  });

  it('perplexity ∈ provider chat-capable e provider noto', () => {
    expect(chatCapableProviders()).toContain('perplexity');
    expect(isKnownProvider('perplexity')).toBe(true);
  });
});

describe('provider-registry — model default + self-host baseUrl', () => {
  it('requestedModel vuoto → usa chatModel del provider', () => {
    expect(resolveToolEndpoint('grok', '')?.model).toBe('grok-2-latest');
    expect(resolveToolEndpoint('deepseek', '   ')?.model).toBe('deepseek-chat');
  });

  it('requestedModel esplicito vince sul default', () => {
    expect(resolveToolEndpoint('openai', 'gpt-4o')?.model).toBe('gpt-4o');
  });

  it('self-host: baseUrl del chiamante → url; trailing slash normalizzato', () => {
    expect(resolveToolEndpoint('liara', '', 'https://gw.portal/api/v1/llm/')?.url).toBe(
      'https://gw.portal/api/v1/llm/chat/completions',
    );
    expect(resolveToolEndpoint('ollama', '', 'http://host:11434')?.url).toBe(
      'http://host:11434/v1/chat/completions',
    );
  });

  it('self-host senza baseUrl → defaultBaseUrl della spec', () => {
    expect(resolveToolEndpoint('ollama', '')?.url).toBe(
      'http://localhost:11434/v1/chat/completions',
    );
  });

  it('OpenRouter porta gli extraHeaders di attribution', () => {
    const r = resolveToolEndpoint('openrouter', 'openai/gpt-4o');
    expect(r?.extraHeaders?.['X-Title']).toBe('FlowForge');
    expect(r?.extraHeaders?.['HTTP-Referer']).toContain('flowforge');
  });

  it('provider sconosciuto → getProviderSpec lancia (fail-fast)', () => {
    expect(() => getProviderSpec('bogus')).toThrow(/Unknown LLM provider/u);
  });
});

// Type-only: garantisce che ProviderSpec resti esportato e usabile dai consumer.
const _typecheck: ProviderSpec = getProviderSpec('openai');
void _typecheck;
