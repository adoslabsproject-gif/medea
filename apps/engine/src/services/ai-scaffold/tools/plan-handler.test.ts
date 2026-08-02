/**
 * Test REALI propose_plan + requirePlan. Ogni assert verifica BEHAVIOR
 * con valori specifici. Niente smoke fake.
 *
 * Catalogo nodi reale viene caricato (buildNodeCatalog). I defId usati nei
 * test devono esistere nel catalog vero (action_http, trigger_imap, ecc.).
 */

import { describe, it, expect } from 'vitest';
import { ScaffoldSession } from '@/services/ai-scaffold.service.js';
import { proposePlanHandler, requirePlan } from './plan-handler.js';

const ENTERPRISE_GOAL = `Document intelligence pipeline: cartella S3 con PDF in arrivo, OCR + vision AI extract entities, classifica documento (contratto/fattura/preventivo), validazione schema, branching per tipo: contratto → legal team review queue, fattura → ERP push, preventivo → CRM opportunity, in caso di low confidence routing manuale + Slack notification, summary AI giornaliero al management.`;

const REASONING_OK =
  'Goal richiede ingest PDF da S3 + OCR + classificazione + branch a 3 destinazioni differenti + low confidence routing manuale + summary giornaliero. Uso trigger_webhook per ingest, agent_extractor per OCR, agent_classifier per il tipo, logic_switch a 3 rami, ognuno con community_<vendor> per destinazione.';

function newSession(goal: string): ScaffoldSession {
  const s = new ScaffoldSession('tenant-test');
  s.goal = goal;
  return s;
}

function manyPlanned(count: number): { id: string; defId: string; purpose: string }[] {
  // Genera N nodi con defId esistenti nel catalog vero.
  // action_http esiste sempre, trigger_webhook esiste sempre.
  const out: { id: string; defId: string; purpose: string }[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      id: `n${i.toString()}`,
      defId: i === 0 ? 'trigger_webhook' : 'action_http',
      purpose: `Nodo ${i.toString()} con scopo specifico nel flow di test`,
    });
  }
  return out;
}

describe('proposePlanHandler — happy path', () => {
  it('plan valido con >= minNodes → ACCEPT + session.plan settato', () => {
    const s = newSession(ENTERPRISE_GOAL);
    const nodes = manyPlanned(22);
    const edges = nodes.slice(0, -1).map((n, i) => ({ from: n.id, to: nodes[i + 1]!.id }));

    const r = proposePlanHandler(s, { nodes, edges, reasoning: REASONING_OK });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.data as { accepted: boolean }).accepted).toBe(true);
      expect((r.data as { nodes: number }).nodes).toBe(22);
      expect((r.data as { roots: number }).roots).toBe(1);
    }
    expect(s.plan?.accepted).toBe(true);
    expect(s.plan?.nodes).toHaveLength(22);
  });

  it('plan accepted ritorna schemas per OGNI defId distinct (anti-retry loop)', () => {
    // FIX 2026-05-31: Liara consumava 3 iter/nodo per scoprire REQUIRED.
    // Server ora restituisce schemas completi nel tool_result accepted.
    const s = newSession(ENTERPRISE_GOAL);
    const nodes = manyPlanned(22); // n0=trigger_webhook, n1..n21=action_http
    const r = proposePlanHandler(s, { nodes, edges: [], reasoning: REASONING_OK });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const schemas = (
        r.data as { schemas: Record<string, { required: string[]; allFields: unknown[] }> }
      ).schemas;
      expect(schemas).toBeDefined();
      // 2 defId distinct: trigger_webhook + action_http
      expect(Object.keys(schemas).sort()).toEqual(['action_http', 'trigger_webhook']);
      // Ogni schema deve avere required + allFields
      expect(Array.isArray(schemas.action_http!.required)).toBe(true);
      expect(Array.isArray(schemas.action_http!.allFields)).toBe(true);
      expect(schemas.action_http!.allFields.length).toBeGreaterThan(0);
    }
  });
});

describe('proposePlanHandler — validation', () => {
  it('reasoning vuoto → REJECT', () => {
    const s = newSession(ENTERPRISE_GOAL);
    const r = proposePlanHandler(s, { nodes: manyPlanned(22), edges: [], reasoning: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('reasoning');
    expect(s.plan).toBe(null);
  });

  it('reasoning < 60 char → REJECT', () => {
    const s = newSession(ENTERPRISE_GOAL);
    const r = proposePlanHandler(s, {
      nodes: manyPlanned(22),
      edges: [],
      reasoning: 'troppo corto',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('troppo corto');
  });

  it('nodes vuoto → REJECT', () => {
    const s = newSession(ENTERPRISE_GOAL);
    const r = proposePlanHandler(s, { nodes: [], edges: [], reasoning: REASONING_OK });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('nodes');
  });

  it('node senza defId → REJECT con error specifico', () => {
    const s = newSession(ENTERPRISE_GOAL);
    const r = proposePlanHandler(s, {
      nodes: [{ id: 'n1', defId: '', purpose: 'test placeholder' }, ...manyPlanned(21)],
      edges: [],
      reasoning: REASONING_OK,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('defId');
  });

  it('defId non nel catalogo → REJECT', () => {
    const s = newSession(ENTERPRISE_GOAL);
    const r = proposePlanHandler(s, {
      nodes: [{ id: 'n1', defId: 'INESISTENTE_FAKE_NODE', purpose: 'test' }, ...manyPlanned(21)],
      edges: [],
      reasoning: REASONING_OK,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('INESISTENTE_FAKE_NODE');
      expect(r.error).toContain('list_node_catalog');
    }
  });

  it('purpose < 10 char → REJECT', () => {
    const s = newSession(ENTERPRISE_GOAL);
    const bad = manyPlanned(22);
    bad[0]!.purpose = 'ok'; // troppo corto
    const r = proposePlanHandler(s, { nodes: bad, edges: [], reasoning: REASONING_OK });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('purpose');
  });

  it('id duplicato → REJECT', () => {
    const s = newSession(ENTERPRISE_GOAL);
    const dup = manyPlanned(22);
    dup[1]!.id = dup[0]!.id;
    const r = proposePlanHandler(s, { nodes: dup, edges: [], reasoning: REASONING_OK });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('duplicato');
  });

  it('edge.from non in nodes → REJECT', () => {
    const s = newSession(ENTERPRISE_GOAL);
    const r = proposePlanHandler(s, {
      nodes: manyPlanned(22),
      edges: [{ from: 'GHOST', to: 'n0' }],
      reasoning: REASONING_OK,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('GHOST');
  });

  it('plan < minNodes (complexity gate) → REJECT con stima', () => {
    const s = newSession(ENTERPRISE_GOAL);
    const r = proposePlanHandler(s, {
      nodes: manyPlanned(3), // troppo pochi per goal enterprise
      edges: [],
      reasoning: REASONING_OK,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('plan troppo corto');
      expect(r.error).toContain('enterprise');
    }
  });

  it('plan SENZA root (tutti nodi hanno incoming edge) → REJECT', () => {
    const s = newSession(ENTERPRISE_GOAL);
    const nodes = manyPlanned(22);
    // Edge ciclico: ogni nodo ha incoming
    const edges = nodes.map((n, i) => ({ from: nodes[(i + 1) % nodes.length]!.id, to: n.id }));
    const r = proposePlanHandler(s, { nodes, edges, reasoning: REASONING_OK });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('root');
  });
});

describe('requirePlan — gate per mutation handlers', () => {
  it('session senza plan → REJECT con messaggio prescrittivo', () => {
    const s = newSession(ENTERPRISE_GOAL);
    const r = requirePlan(s, 'add_node');
    expect(r).not.toBe(null);
    if (r) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain('propose_plan');
        expect(r.error).toContain('PHASE 0');
        expect(r.error).toContain('add_node');
      }
    }
  });

  it('session con plan accepted → ACCEPT (ritorna null = nessun reject)', () => {
    const s = newSession(ENTERPRISE_GOAL);
    s.plan = { accepted: true, proposedAt: Date.now(), reasoning: 'ok', nodes: [], edges: [] };
    expect(requirePlan(s, 'add_node')).toBe(null);
  });

  it('session con plan accepted=false → REJECT', () => {
    const s = newSession(ENTERPRISE_GOAL);
    s.plan = { accepted: false, proposedAt: Date.now(), reasoning: 'ok', nodes: [], edges: [] };
    expect(requirePlan(s, 'add_node')).not.toBe(null);
  });
});

describe('proposePlanHandler — riproposta plan dopo correzione', () => {
  it('plan accepted → si può ri-proporre un plan più grande (override accettato)', () => {
    const s = newSession(ENTERPRISE_GOAL);
    proposePlanHandler(s, { nodes: manyPlanned(22), edges: [], reasoning: REASONING_OK });
    expect(s.plan?.nodes).toHaveLength(22);

    // Liara aggiunge altri 3 nodi via re-propose
    proposePlanHandler(s, { nodes: manyPlanned(25), edges: [], reasoning: REASONING_OK });
    expect(s.plan?.nodes).toHaveLength(25);
  });
});
