import { describe, it, expect } from 'vitest';
import { applyReachabilityHeal, enforceCoverageAndInject, type PpWorkflow } from './postprocess.js';
import { AiScaffoldError } from './types.js';

describe('applyReachabilityHeal — auto-collega i nodi referenziati ma non a monte', () => {
  it('db referenzia enrich (parallelo, non a monte) → aggiunge enrich→db', () => {
    const wf: PpWorkflow = {
      nodes: [
        { id: 'a', defId: 'trigger_manual', config: {} },
        { id: 'enrich', defId: 'action_json_extract', config: {} },
        { id: 'db', defId: 'db_insert', config: { rowJson: '{{$node.enrich.json}}' } },
      ],
      edges: [
        { from: 'a', to: 'enrich' },
        { from: 'a', to: 'db' },
      ],
    };
    applyReachabilityHeal(wf);
    expect(wf.edges).toContainEqual({ from: 'enrich', to: 'db' });
  });

  it('niente da collegare → edges invariati', () => {
    const wf: PpWorkflow = { nodes: [{ id: 'a', defId: 'trigger_manual', config: {} }], edges: [] };
    applyReachabilityHeal(wf);
    expect(wf.edges).toEqual([]);
  });
});

describe('enforceCoverageAndInject — il workflow deve FARE quello che è chiesto', () => {
  it('nessuna capability mancante → [] e zero mutazioni', () => {
    const wf: PpWorkflow = {
      nodes: [
        { id: 'a', defId: 'trigger_webhook', config: {} },
        { id: 'h', defId: 'action_http', config: {} },
      ],
      edges: [],
    };
    const before = wf.nodes.length;
    expect(enforceCoverageAndInject(wf, 'quando arriva un webhook chiama una api', false)).toEqual(
      [],
    );
    expect(wf.nodes.length).toBe(before);
  });

  it('capability mancante + NON ultimo tentativo → throw AiScaffoldError (il retry rigenera)', () => {
    const wf: PpWorkflow = { nodes: [{ id: 'a', defId: 'action_http', config: {} }], edges: [] };
    expect(() => enforceCoverageAndInject(wf, 'mandami un grafico via email', false)).toThrow(
      AiScaffoldError,
    );
    expect(wf.nodes).toHaveLength(1); // non muta su reject
  });

  it('capability mancante + ULTIMO tentativo → INIETTA il nodo + ritorna warning ✨ (no throw)', () => {
    const wf: PpWorkflow = {
      nodes: [{ id: 'src', defId: 'action_aggregate', config: {} }],
      edges: [],
    };
    const warnings = enforceCoverageAndInject(wf, 'mandami un grafico storico', true);
    expect(wf.nodes.some((n) => n.defId === 'action_generate_chart')).toBe(true);
    expect(wf.edges.some((e) => e.to === 'action_generate_chart_auto')).toBe(true); // cablato
    expect(warnings[0]).toContain('✨');
  });
});
