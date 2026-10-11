/**
 * GUARD — nessun modello ritirato resta scritto nel codice come scelta.
 *
 * Un modello predefinito ritirato non dà un errore di compilazione: dà un 404
 * dal provider al primo utente che non ha scritto un modello a mano. L'11
 * ottobre 2026 ce n'erano sei, sparsi in quindici file, e nessun test se ne
 * accorgeva.
 *
 * L'elenco qui sotto viene dalle pagine ufficiali dei provider, lette in quella
 * data. Quando un provider ritira un altro modello lo si aggiunge qui: il test
 * dice in quali file va sostituito.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const RADICE = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');

/** Modello ritirato → da dove lo si sa. */
const RITIRATI: Record<string, string> = {
  // platform.claude.com/docs/en/about-claude/model-deprecations
  'claude-3-5-haiku': 'Anthropic: ritirato il 19 febbraio 2026',
  'claude-3-5-sonnet': 'Anthropic: ritirato il 28 ottobre 2025',
  'claude-sonnet-4-5': 'Anthropic: deprecato, ritiro il 30 novembre 2026',
  'claude-sonnet-4.5': 'Anthropic via OpenRouter: ritiro a monte il 30 novembre 2026',
  // ai.google.dev/gemini-api/docs/models
  'gemini-2.0-': 'Google: spento',
  'gemini-1.5-': 'Google: non più in elenco',
  'gemini-2.5-pro': 'Google: riservato a chi lo usava già',
  // api-docs.deepseek.com/updates
  'deepseek-chat': 'DeepSeek: nome dismesso il 24 luglio 2026',
  'deepseek-reasoner': 'DeepSeek: nome dismesso il 24 luglio 2026',
  // docs.x.ai/developers/models
  'grok-2': 'xAI: non più in elenco',
  'grok-3': 'xAI: ritirato il 15 maggio 2026',
};

/**
 * File che nominano modelli ritirati di proposito, e perché.
 */
const ECCEZIONI: Record<string, string> = {
  'apps/engine/src/services/llm/modelli-ritirati.guard.test.ts': 'è questo elenco',
  'apps/engine/src/services/ai-budget/workflow-call-tracker.service.ts':
    'listino: serve a dare un costo alle esecuzioni già registrate con quei modelli',
  'apps/engine/src/storage/migrate.ts': 'un commento che mostra la forma di una colonna',
};

function sorgenti(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'apps', 'packages'],
    { cwd: RADICE, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split('\n')
    .filter((f) => /\/src(-tauri\/src)?\//u.test(f))
    .filter((f) => /\.(ts|tsx|rs)$/u.test(f))
    .filter((f) => !/\.(test|stories)\.tsx?$/u.test(f) && !f.includes('/__tests__/'))
    .filter((f) => !(f in ECCEZIONI));
}

describe('GUARD — modelli ritirati', () => {
  it('trova dei sorgenti da controllare (sanity)', () => {
    expect(sorgenti().length).toBeGreaterThan(500);
  });

  it('🚨 nessun sorgente nomina un modello ritirato', () => {
    const trovati: string[] = [];
    for (const file of sorgenti()) {
      let testo: string;
      try {
        testo = readFileSync(join(RADICE, file), 'utf8');
      } catch {
        continue; // tolto dal disco ma ancora nell'indice
      }
      testo.split('\n').forEach((riga, i) => {
        for (const [modello, fonte] of Object.entries(RITIRATI)) {
          if (riga.includes(modello)) {
            trovati.push(`${file}:${String(i + 1)} — ${modello} (${fonte})`);
          }
        }
      });
    }
    expect(trovati, `modelli ritirati ancora nel codice:\n${trovati.join('\n')}`).toEqual([]);
  });
});
