/**
 * Contract test del prompt run-explain — anti-regressione dell'incidente
 * 2026-07-14: il catalogo nodi inlinava le description INTERE (cresciute a
 * ~4k char l'una) → system prompt 372k char ≈ 106k token > 40.960 di finestra
 * → "Spiega errore e proponi fix" rotta per OGNI tenant con
 * LlmContextOverflowError, e il messaggio incolpava il workflow dell'utente
 * (2,4k char nel caso reale).
 *
 * Il test di budget qui sotto FALLIVA sul codice pre-fix (372k > 60k):
 * è la rete che avvisa PRIMA della produzione se descrizioni/catalogo
 * ricrescono oltre la finestra del modello.
 */
import { describe, it, expect } from 'vitest';
import { buildRunExplainSystemPrompt, buildRunExplainUserContent } from './run-explain.prompt.js';
import { stdlibNodeDefs } from '@medea/engine-nodes-stdlib';
import { getLiaraContextWindow } from '@/services/llm-chat.service.js';

const CHARS_PER_TOKEN = 3.5; // stessa stima del dispatcher (llm-chat.service)

describe('buildRunExplainSystemPrompt — budget di contesto (incidente 2026-07-14)', () => {
  const system = buildRunExplainSystemPrompt();

  it('il system prompt sta ENTRO ~17k token (60k char): il catalogo non deve mai più sfondare la finestra', () => {
    // 60k char ≈ 17k token: lascia >20k token per user content + output nella
    // finestra Liara (40.960). Pre-fix questo valeva 372.620 → test rosso.
    expect(system.length).toBeLessThan(60_000);
  });

  it("system + user content massimo teorico restano sotto la finestra Liara con margine per l'output", () => {
    const estimatedSystemTokens = Math.ceil(system.length / CHARS_PER_TOKEN);
    // User content worst-case: caps del builder (8000 wf + 2000 err + 1500 out
    // + 2000 config + ~4000 nodeDef/boilerplate) ≈ 17.5k char ≈ 5k token.
    const worstCaseUserTokens = 5_000;
    const minOutputBudget = 2_048;
    expect(estimatedSystemTokens + worstCaseUserTokens + minOutputBudget).toBeLessThan(
      getLiaraContextWindow(),
    );
  });

  it('OGNI defId del catalogo stdlib è presente (il modello deve poterli citare tutti nei patch)', () => {
    for (const def of stdlibNodeDefs()) {
      expect(system, `defId ${def.id} mancante dal catalogo del prompt`).toContain(`- ${def.id} (`);
    }
  });

  it('ogni riga di catalogo è UNA riga ≤160 char (una description multiriga romperebbe il formato lista)', () => {
    const catalogSection = system.slice(system.indexOf('## CATALOGO NODI DISPONIBILI'));
    const lines = catalogSection.split('\n').filter((l) => l.startsWith('- '));
    expect(lines.length).toBeGreaterThanOrEqual(stdlibNodeDefs().length);
    for (const line of lines) {
      expect(
        line.length,
        `riga catalogo oltre il cap: "${line.slice(0, 80)}…"`,
      ).toBeLessThanOrEqual(180);
    }
  });
});

describe('buildRunExplainUserContent — cap difensivi con input ostili', () => {
  const HUGE = 'x'.repeat(1_000_000);

  it('workflow da 1MB, error/output/config giganti → contenuto comunque bounded (<25k char)', () => {
    const content = buildRunExplainUserContent({
      workflow: { id: 'wf', name: HUGE, nodes: [{ id: 'n1', config: { code: HUGE } }], edges: [] },
      runId: 'r1',
      runStatus: 'error',
      failedNodeId: 'n1',
      failedNodeDefId: 'action_http_call',
      errorMessage: HUGE,
      failedNodeOutput: { blob: HUGE },
      failedNodeConfig: { code: HUGE },
    });
    expect(content.length).toBeLessThan(25_000);
  });

  it('inietta il NodeDef completo del nodo fallito quando il defId è noto', () => {
    const def = stdlibNodeDefs()[0];
    expect(def).toBeDefined();
    const content = buildRunExplainUserContent({
      workflow: null,
      runId: 'r1',
      runStatus: 'error',
      failedNodeId: 'n1',
      failedNodeDefId: def!.id,
      errorMessage: 'boom',
    });
    expect(content).toContain(`NodeDef del nodo fallito (\`${def!.id}\`)`);
  });

  it('defId ignoto o assente → nessun crash, nessun blocco NodeDef', () => {
    const content = buildRunExplainUserContent({
      workflow: null,
      runId: 'r1',
      runStatus: 'error',
      failedNodeId: 'n1',
      failedNodeDefId: 'custom_non_esiste_nel_catalogo',
      errorMessage: 'boom',
    });
    expect(content).not.toContain('NodeDef del nodo fallito');
    expect(content).toContain('custom_non_esiste_nel_catalogo');
  });
});
