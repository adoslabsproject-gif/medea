/**
 * L'ordine delle strade, e soprattutto quando ci si ferma invece di scendere.
 *
 * La cascata è facile da rompere senza accorgersene: basta trattare ogni
 * fallimento del motore come un invito a riprovare in locale, e il wizard
 * consegna in silenzio un risultato che il motore aveva già giudicato
 * insufficiente — con l'aria di aver fatto la stessa cosa.
 */

import { describe, expect, it, vi } from 'vitest';

import type { AgentStep } from '../scaffold';
import type { NodeDef, Workflow } from '../types';

const { generaColMotore, runScaffold, runWorkflowAgent, createScaffoldLlm, createAgentChat } =
  vi.hoisted(() => ({
    generaColMotore: vi.fn(),
    runScaffold: vi.fn(),
    runWorkflowAgent: vi.fn(),
    createScaffoldLlm: vi.fn(() => Promise.resolve({})),
    createAgentChat: vi.fn(() => Promise.resolve({})),
  }));

vi.mock('../scaffold', () => ({
  generaColMotore,
  runScaffold,
  runWorkflowAgent,
  createScaffoldLlm,
  createAgentChat,
}));

const { costruisciWorkflow } = await import('./strade');

const WORKFLOW: Workflow = { name: 'x', nodes: [], edges: [], executionTarget: 'local' };

function contesto(): Parameters<typeof costruisciWorkflow>[0] {
  return {
    goal: 'archivia le newsletter',
    catalogo: [] as NodeDef[],
    signal: new AbortController().signal,
    onStep: (_: AgentStep) => undefined,
    annota: () => undefined,
    onToken: () => undefined,
    interrotto: () => false,
  };
}

describe('costruisciWorkflow — l’ordine delle strade', () => {
  it('quando il motore consegna, le strade locali non partono nemmeno', async () => {
    generaColMotore.mockResolvedValueOnce({
      ok: true,
      workflow: WORKFLOW,
      note: ['dal motore'],
      modello: 'nha-v1',
      tabelleDaCreare: undefined,
    });

    const esito = await costruisciWorkflow(contesto());

    expect(esito?.ok).toBe(true);
    if (esito?.ok) expect(esito.avvisi).toEqual(['dal motore']);
    expect(runScaffold).not.toHaveBeenCalled();
    expect(runWorkflowAgent).not.toHaveBeenCalled();
  });

  /**
   * La regola che porta il peso.
   *
   * Il motore c'era, ha lavorato, e ha detto di no. Riprovare in locale — che
   * ha meno mezzi — non può che dare qualcosa di peggiore di ciò che è già
   * stato giudicato insufficiente, e consegnarlo senza dirlo lo farebbe
   * passare per la stessa cosa. Ci si ferma e si riporta il suo motivo.
   */
  it('quando il motore rifiuta, non si ripiega sulle strade locali', async () => {
    generaColMotore.mockResolvedValueOnce({
      ok: false,
      motivo: 'quality gate: 3 problemi',
      ripiegabile: false,
    });

    const esito = await costruisciWorkflow(contesto());

    expect(esito?.ok).toBe(false);
    if (esito && !esito.ok) expect(esito.motivo).toBe('quality gate: 3 problemi');
    expect(runScaffold).not.toHaveBeenCalled();
    expect(runWorkflowAgent).not.toHaveBeenCalled();
  });

  it('quando il motore non c’è, si scende alla scrittura in una volta sola', async () => {
    generaColMotore.mockResolvedValueOnce({
      ok: false,
      motivo: 'motore spento',
      ripiegabile: true,
    });
    runScaffold.mockResolvedValueOnce({
      ok: true,
      workflow: WORKFLOW,
      warnings: ['un avviso'],
      attempts: 1,
      reasoning: '',
      repairs: [],
      tablesToCreate: undefined,
    });

    const esito = await costruisciWorkflow(contesto());

    expect(esito?.ok).toBe(true);
    if (esito?.ok) expect(esito.avvisi).toEqual(['un avviso']);
    expect(runWorkflowAgent).not.toHaveBeenCalled();
  });

  it('fallita anche quella, si prova l’agente', async () => {
    generaColMotore.mockResolvedValueOnce({ ok: false, motivo: 'spento', ripiegabile: true });
    runScaffold.mockResolvedValueOnce({
      ok: false,
      reason: 'JSON illeggibile',
      attempts: 3,
      violations: [],
      qualityIssues: [],
    });
    runWorkflowAgent.mockResolvedValueOnce({
      ok: true,
      workflow: WORKFLOW,
      steps: [],
      remainingIssues: [],
    });

    const esito = await costruisciWorkflow(contesto());

    expect(esito?.ok).toBe(true);
    expect(runWorkflowAgent).toHaveBeenCalled();
  });

  it('cadute tutte e tre, riporta tutti e tre i motivi', async () => {
    generaColMotore.mockResolvedValueOnce({ ok: false, motivo: 'spento', ripiegabile: true });
    runScaffold.mockResolvedValueOnce({
      ok: false,
      reason: 'JSON illeggibile',
      attempts: 3,
      violations: [],
      qualityIssues: [],
    });
    runWorkflowAgent.mockResolvedValueOnce({
      ok: false,
      reason: 'non ha chiamato strumenti',
      steps: [],
      violations: [],
      qualityIssues: [],
    });

    const esito = await costruisciWorkflow(contesto());

    expect(esito?.ok).toBe(false);
    if (esito && !esito.ok) {
      expect(esito.motivo).toContain('Motore: spento');
      expect(esito.motivo).toContain('Scrittura in una volta sola: JSON illeggibile');
      expect(esito.motivo).toContain('Costruzione a passi: non ha chiamato strumenti');
    }
  });

  it('fermato a metà, non è né riuscito né fallito', async () => {
    generaColMotore.mockResolvedValueOnce({ ok: false, motivo: 'spento', ripiegabile: true });
    const ctx = { ...contesto(), interrotto: () => true };

    expect(await costruisciWorkflow(ctx)).toBeNull();
  });
});
