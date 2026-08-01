/**
 * GUARDIA SOURCE-LEVEL anti-regressione. Istituzionalizza la SSOT del
 * provider-registry: gli endpoint dei provider OpenAI-compat a ENDPOINT FISSO
 * devono vivere SOLO nel registry. Se un domani qualcuno reintroduce
 * `fetch('https://api.openai.com/...')` (o x.ai/deepseek/openrouter/mistral/groq)
 * dentro un consumer invece di usare il registry → QUESTO TEST DIVENTA ROSSO.
 *
 * È il motivo per cui la tripla-duplicazione divergente (db-agent vs llm-chat vs
 * llm-test) non può tornare di nascosto.
 *
 * NB: gemini (generativelanguage), anthropic, voyage, liara, ollama hanno shape
 * NON OpenAI-compat → i loro URL restano legittimamente nei consumer e NON sono
 * sorvegliati qui.
 *
 * @module services/llm/no-hardcoded-endpoints.guard.test
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

/** I 6 host che ORA appartengono esclusivamente al registry. */
const REGISTRY_OWNED_HOSTS = [
  'api.openai.com',
  'api.x.ai',
  'api.deepseek.com',
  'openrouter.ai',
  'api.mistral.ai',
  'api.groq.com',
] as const;

/** I consumer che PRIMA duplicavano il mapping e ora devono delegare al registry. */
const CONSUMERS: Record<string, string> = {
  'routes/db-agent-chat.ts': '../../routes/db-agent-chat.ts',
  'services/llm-chat.service.ts': '../llm-chat.service.ts',
  'services/llm-test.service.ts': '../llm-test.service.ts',
};

describe('GUARDIA: nessun endpoint OpenAI-compat hardcoded fuori dal registry', () => {
  for (const [label, rel] of Object.entries(CONSUMERS)) {
    const src = read(rel);
    for (const host of REGISTRY_OWNED_HOSTS) {
      it(`${label} NON contiene "${host}" hardcoded (usa provider-registry)`, () => {
        expect(
          src.includes(host),
          `"${host}" è ricomparso hardcoded in ${label}: spostalo nel provider-registry (SSOT).`,
        ).toBe(false);
      });
    }
  }

  it('il provider-registry È la fonte: contiene tutti i 6 host sorvegliati', () => {
    const registry = read('./provider-registry.ts');
    for (const host of REGISTRY_OWNED_HOSTS) {
      expect(registry.includes(host), `registry manca ${host}`).toBe(true);
    }
  });
});
