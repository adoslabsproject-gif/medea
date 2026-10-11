/**
 * Tests 2026-grade per ai-assistant.prompt.
 *
 * L'assistente si presenta come l'assistente dei workflow di Medea, su ogni
 * superficie (chat dell'editor, wizard, aiuto): non ha un nome proprio e non
 * porta il marchio di un altro prodotto.
 */
import { describe, it, expect } from 'vitest';
import * as mod from './ai-assistant.prompt.js';

describe('ai-assistant.prompt.ts — smoke', () => {
  it('modulo carica senza side-effect crash', () => {
    expect(mod).toBeDefined();
  });

  it('export buildAiAssistantSystemPrompt (function) è definito', () => {
    expect(mod.buildAiAssistantSystemPrompt).toBeDefined();
  });

  it('export buildAiAssistantUserContent (function) è definito', () => {
    expect(mod.buildAiAssistantUserContent).toBeDefined();
  });
});

const CATALOG_FIXTURE = [
  'FAMIGLIE DI NODI DISPONIBILI:',
  '  • triggers — Trigger (3 nodi)',
  'NODI PIÙ PERTINENTI ALLA RICHIESTA:',
  '- trigger_webhook (trigger, triggers): Avvia il workflow da una chiamata HTTP.',
  '- action_send_email (action, email): Invia una email via SMTP.',
].join('\n');

describe('SYSTEM_PROMPT identity — l’assistente dei workflow di Medea', () => {
  it('si presenta come l’assistente dell’editor di workflow di Medea', () => {
    const prompt = mod.buildAiAssistantSystemPrompt(CATALOG_FIXTURE);
    expect(prompt).toMatch(/You are the AI assistant of Medea's workflow editor/);
    expect(prompt).toMatch(/IDENTITY: you are Medea's workflow assistant/);
  });

  it('REGRESSION: NON contiene più "FlowForge AI" come nome assistente', () => {
    const prompt = mod.buildAiAssistantSystemPrompt(CATALOG_FIXTURE);
    expect(prompt).not.toMatch(/You are .*FlowForge AI/);
    expect(prompt).not.toMatch(/Sono FlowForge AI/i);
  });

  it('segue la lingua dell’utente', () => {
    const prompt = mod.buildAiAssistantSystemPrompt(CATALOG_FIXTURE);
    expect(prompt).toMatch(/Match the user.*language/i);
  });

  // FIX 2026-06-28: a "crealo tu" il modello descriveva senza emettere la patch → canvas vuota.
  it('istruisce a EMETTERE patch sui build request + modificabilità + wizard', () => {
    const prompt = mod.buildAiAssistantSystemPrompt(CATALOG_FIXTURE);
    expect(prompt).toMatch(/BUILD\/CREATE requests MUST emit a "patch"/i);
    expect(prompt).toMatch(/add, remove or modify/i); // modificabilità annunciata
    expect(prompt).toMatch(/Wizard/); // suggerisce il wizard per build grandi
    expect(prompt).toMatch(/Never reply .*the workflow is empty/i); // anti il caso osservato
  });

  it('mantiene il JSON envelope strict (message + patch fields)', () => {
    // Regression: il fix dell'identità NON deve rompere la JSON discipline.
    const prompt = mod.buildAiAssistantSystemPrompt(CATALOG_FIXTURE);
    expect(prompt).toMatch(/single JSON object/);
    expect(prompt).toMatch(/"message"/);
    expect(prompt).toMatch(/"patch"/);
    expect(prompt).toMatch(/addNodes.*removeNodeIds.*addEdges/);
  });

  it('inietta il catalogBlock RETRIEVED passato dalla route (non più catalogo completo)', () => {
    const prompt = mod.buildAiAssistantSystemPrompt(CATALOG_FIXTURE);
    // Il blocco passato (famiglie + nodi pertinenti) finisce nel prompt.
    expect(prompt).toContain('FAMIGLIE DI NODI DISPONIBILI');
    expect(prompt).toMatch(/trigger_webhook|action_send_email/);
    // Niente più dump del catalogo completo hardcoded nel builder.
    expect(prompt).not.toMatch(/full catalog is:/i);
  });

  it('non porta il nome di un’azienda: Medea è un client neutro', () => {
    const prompt = mod.buildAiAssistantSystemPrompt(CATALOG_FIXTURE);
    expect(prompt.split('\n')[0]).not.toMatch(/SRL|FlowForge/);
  });
});

describe('patchHasOps logic — strip empty patch (FIX 2026-05-30 user-segnalato)', () => {
  // Bug: utente scrive "ciao" → il modello risponde solo conversazionalmente
  // (no patch reale) ma il LLM ritornava patch:{} → frontend renderizzava
  // "Modifica proposta" con bottone Applica vuoto + nessun item.
  // Fix backend: strip patch dal response se zero ops totali.

  // Mock helper identico a quello in routes/ai-assistant.ts post-fix.
  function patchHasOps(p: Record<string, unknown[] | undefined> | undefined | null): boolean {
    if (!p) return false;
    return (
      ((p.addNodes as unknown[] | undefined)?.length ?? 0) > 0 ||
      ((p.removeNodeIds as unknown[] | undefined)?.length ?? 0) > 0 ||
      ((p.addEdges as unknown[] | undefined)?.length ?? 0) > 0 ||
      ((p.removeEdgeIds as unknown[] | undefined)?.length ?? 0) > 0 ||
      ((p.updateNodes as unknown[] | undefined)?.length ?? 0) > 0
    );
  }

  it('patch undefined → false (LLM ha omesso intenzionalmente)', () => {
    expect(patchHasOps(undefined)).toBe(false);
  });

  it('patch null → false (defensive)', () => {
    expect(patchHasOps(null)).toBe(false);
  });

  it('patch={} object vuoto → false (caso "ciao" user-segnalato)', () => {
    expect(patchHasOps({})).toBe(false);
  });

  it('patch con tutti array vuoti → false', () => {
    expect(
      patchHasOps({
        addNodes: [],
        removeNodeIds: [],
        addEdges: [],
        removeEdgeIds: [],
        updateNodes: [],
      }),
    ).toBe(false);
  });

  it('patch con UN addNodes → true', () => {
    expect(patchHasOps({ addNodes: [{ id: 'n1', defId: 'trigger_webhook' }] })).toBe(true);
  });

  it('patch con UN removeEdgeId → true', () => {
    expect(patchHasOps({ removeEdgeIds: ['e1'] })).toBe(true);
  });

  it('patch con SOLO updateNodes (no add/remove) → true', () => {
    expect(
      patchHasOps({
        updateNodes: [
          { id: 'n1', patch: { x: 100 } as unknown as unknown[] },
        ] as unknown as unknown[],
      }),
    ).toBe(true);
  });
});

describe('cap context chat (incidente owner 2026-06-12 — 400 del modello, 92408>40960)', () => {
  it('il builder NON dumpa più il catalogo completo — lo riceve dal RETRIEVAL (route)', async () => {
    const mod = await import('./ai-assistant.prompt.js');
    // Senza catalogBlock: il prompt non deve contenere alcun catalogo hardcoded.
    const empty = mod.buildAiAssistantSystemPrompt('');
    const catalogLines = empty
      .split('\n')
      .filter((l) => l.startsWith('- action_') || l.startsWith('- trigger_'));
    expect(catalogLines.length, 'il builder non deve avere un catalogo proprio').toBe(0);
    // Il cap del contesto ora è garantito dal retrieval top-k a monte, non da
    // un dump troncato: il prompt base è piccolo a prescindere dal n. di nodi.
    expect(empty.length).toBeLessThan(2500);
  });

  it('compactWorkflowJson: niente pretty-print + valori config lunghi troncati', async () => {
    const mod = await import('./ai-assistant.prompt.js');
    const longCode = 'x'.repeat(5000);
    const wf = {
      nodes: [{ id: 'n1', defId: 'action_run_js', config: { code: longCode } }],
      edges: [],
    };
    const out = mod.compactWorkflowJson(wf);
    expect(out).not.toContain('\n  '); // no indentazione pretty-print
    expect(out.length).toBeLessThan(2000); // 5000 char di code troncati
    expect(out).toContain('char troncati');
    // struttura preservata
    const parsed = JSON.parse(out) as { nodes: { id: string; defId: string }[] };
    expect(parsed.nodes[0]!.id).toBe('n1');
    expect(parsed.nodes[0]!.defId).toBe('action_run_js');
  });

  it('compactWorkflowJson: valori config corti restano INTATTI', async () => {
    const mod = await import('./ai-assistant.prompt.js');
    const wf = {
      nodes: [{ id: 'n1', defId: 'action_send_email', config: { to: 'a@b.it' } }],
      edges: [],
    };
    const parsed = JSON.parse(mod.compactWorkflowJson(wf)) as {
      nodes: { config: { to: string } }[];
    };
    expect(parsed.nodes[0]!.config.to).toBe('a@b.it');
  });
});
