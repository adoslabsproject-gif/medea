import { describe, it, expect } from 'vitest';
import { assembleWorkflow } from './assemble-workflow.js';

const baseNode = (id: string, defId: string, extra: Record<string, unknown> = {}) => ({ id, defId, config: {}, ...extra });

describe('assembleWorkflow — parsed→Workflow', () => {
  it('posizionamento default: x=idx*220, y=200 se la LLM non li dà', () => {
    const wf = assembleWorkflow({ name: 'W', nodes: [baseNode('a', 'trigger_webhook'), baseNode('b', 'action_http')], edges: [{ from: 'a', to: 'b' }] });
    expect(wf.nodes[0]).toMatchObject({ id: 'a', x: 0, y: 200 });
    expect(wf.nodes[1]).toMatchObject({ id: 'b', x: 220, y: 200 });
  });

  it('rispetta x/y espliciti della LLM', () => {
    const wf = assembleWorkflow({ name: 'W', nodes: [baseNode('a', 'trigger_webhook', { x: 999, y: 7 }), baseNode('b', 'action_http')], edges: [] });
    expect(wf.nodes[0]).toMatchObject({ x: 999, y: 7 });
  });

  it('serializza i config non-string in JSON (string passa intatta)', () => {
    const wf = assembleWorkflow({ name: 'W', nodes: [baseNode('a', 'action_http', { config: { url: 'x', retries: 3, opts: { a: 1 } } }), baseNode('b', 'action_http')], edges: [] });
    expect(wf.nodes[0]!.config).toEqual({ url: 'x', retries: '3', opts: '{"a":1}' });
  });

  it('label → name sul nodo', () => {
    const wf = assembleWorkflow({ name: 'W', nodes: [baseNode('a', 'action_http', { label: 'Chiamata' }), baseNode('b', 'action_http')], edges: [] });
    expect((wf.nodes[0] as { name?: string }).name).toBe('Chiamata');
  });

  it('produce la struttura canonica (schemaVersion, enabled:false, nodeDefs vuoto, edges passthrough)', () => {
    const wf = assembleWorkflow({ name: 'W', description: 'D', nodes: [baseNode('a', 'trigger_webhook'), baseNode('b', 'action_http')], edges: [{ from: 'a', to: 'b' }] });
    expect(wf.schemaVersion).toBe('1.0.0');
    expect(wf.enabled).toBe(false);
    expect(wf.nodeDefs).toEqual([]);
    expect(wf.edges).toEqual([{ from: 'a', to: 'b' }]);
    expect(wf.name).toBe('W');
  });

  it('🚨 CONTRATTO GAP 1: mapMode messo dall\'euristica SOPRAVVIVE a WorkflowSchema.parse (zod non lo strippa)', () => {
    // Punto fragile reale: z.object STRIPPA i campi sconosciuti — se EdgeSchema
    // perdesse mapMode in un refactor, l'auto-map dello scaffold verrebbe
    // silenziosamente annullato QUI (stessa classe di bug ingest↔retrieval
    // del caso chunking_version: scritto a monte, filtrato via a valle).
    const wf = assembleWorkflow({
      name: 'W',
      nodes: [baseNode('a', 'db_query'), baseNode('b', 'agent_summarizer')],
      edges: [{ from: 'a', to: 'b', mapMode: 'auto' } as never],
    });
    expect(wf.edges[0]).toMatchObject({ from: 'a', to: 'b', mapMode: 'auto' });
  });
});
