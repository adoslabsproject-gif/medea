/**
 * Test 2026-grade — auto-map-heuristic (GAP 1 (e), scaffold AI).
 *
 * Il centro del bug-bounty è la DIREZIONE dell'errore: un falso positivo
 * dell'euristica = N side-effect invece di 1 (es. N email inviate). Quindi i
 * test NEGATIVI (cosa NON deve mai essere mappato) valgono quanto i positivi,
 * e la whitelist è BLINDATA contro derive future (branchable mai consumer).
 */
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  applyAutoMapHeuristic,
  ARRAY_PRODUCER_DEFIDS,
  SINGLE_ITEM_CONSUMER_DEFIDS,
  type AutoMapEdge,
} from './auto-map-heuristic.js';

function wf(nodes: [string, string][], edges: AutoMapEdge[]) {
  return { nodes: nodes.map(([id, defId]) => ({ id, defId })), edges };
}

describe('🚨 positivi — lista → single-item ottiene auto', () => {
  it('🚨 db_query → agent_summarizer: mapMode=auto + nota leggibile', () => {
    const w = wf([['q', 'db_query'], ['s', 'agent_summarizer']], [{ from: 'q', to: 's' }]);
    const notes = applyAutoMapHeuristic(w);
    expect(w.edges[0]?.mapMode).toBe('auto');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('db_query');
    expect(notes[0]).toContain('agent_summarizer');
  });

  it('🚨 più edge qualificati → TUTTI mappati (rag_search→classifier, xlsx_parse→lead_score)', () => {
    const w = wf(
      [['r', 'rag_search'], ['c', 'agent_classifier'], ['x', 'action_xlsx_parse'], ['l', 'action_lead_score']],
      [{ from: 'r', to: 'c' }, { from: 'x', to: 'l' }],
    );
    const notes = applyAutoMapHeuristic(w);
    expect(w.edges.map((e) => e.mapMode)).toEqual(['auto', 'auto']);
    expect(notes).toHaveLength(2);
  });
});

describe('🚨 negativi — il fan-out NON deve mai sorprendere', () => {
  it('🚨 consumatore con SIDE-EFFECT (email_send) → MAI auto (anti N-email)', () => {
    const w = wf([['q', 'db_query'], ['e', 'action_email_send']], [{ from: 'q', to: 'e' }]);
    expect(applyAutoMapHeuristic(w)).toHaveLength(0);
    expect(w.edges[0]?.mapMode).toBeUndefined();
  });

  it('🚨 produttore fuori whitelist (action_http: lista NON garantita) → niente auto', () => {
    const w = wf([['h', 'action_http'], ['s', 'agent_summarizer']], [{ from: 'h', to: 's' }]);
    expect(applyAutoMapHeuristic(w)).toHaveLength(0);
    expect(w.edges[0]?.mapMode).toBeUndefined();
  });

  it('🚨 mapMode GIÀ presente (anche "off" esplicito) → MAI sovrascritto', () => {
    for (const existing of ['off', 'each', 'auto'] as const) {
      const w = wf([['q', 'db_query'], ['s', 'agent_summarizer']], [{ from: 'q', to: 's', mapMode: existing }]);
      expect(applyAutoMapHeuristic(w)).toHaveLength(0);
      expect(w.edges[0]?.mapMode).toBe(existing);
    }
  });

  it('🚨 error-edge → skip (non trasporta liste di lavoro)', () => {
    const w = wf([['q', 'db_query'], ['s', 'agent_summarizer']], [{ from: 'q', to: 's', fromPort: 'error' }]);
    expect(applyAutoMapHeuristic(w)).toHaveLength(0);
  });

  it('edge con nodo mancante (orfano) → skip senza crash', () => {
    const w = wf([['q', 'db_query']], [{ from: 'q', to: 'ghost' }, { from: 'ghost2', to: 'q' }]);
    expect(applyAutoMapHeuristic(w)).toHaveLength(0);
  });
});

describe('🚨 wiring — l\'euristica è davvero CHIAMATA dalla pipeline (anti "esiste ma nessuno la chiama")', () => {
  it('🚨 singleshot.service.ts importa e invoca applyAutoMapHeuristic dopo il reachability-heal', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'singleshot.service.ts'), 'utf8');
    expect(src).toContain("from '@/services/ai-scaffold/auto-map-heuristic.js'");
    expect(src).toContain('applyAutoMapHeuristic(parsed)');
    // ORDINE: dopo il reachability-heal, così copre anche gli edge appena creati
    expect(src.indexOf('applyAutoMapHeuristic(parsed)')).toBeGreaterThan(src.indexOf('applyReachabilityHeal(parsed)'));
  });
});

describe('🚨 whitelist BLINDATE (drift-guard contro aggiunte future pericolose)', () => {
  it('🚨 nessun BRANCHABLE/loop può MAI essere consumer (l\'engine lo rifiuterebbe a runtime)', () => {
    for (const forbidden of ['agent_intent_router', 'agent_validator', 'logic_if', 'logic_switch', 'logic_loop', 'logic_wait_signal']) {
      expect(SINGLE_ITEM_CONSUMER_DEFIDS.has(forbidden)).toBe(false);
    }
  });

  it('🚨 nessun nodo con side-effect esterno può MAI essere consumer (il fan-out lì lo decide l\'utente)', () => {
    for (const forbidden of ['action_email_send', 'action_http', 'db_insert', 'db_update', 'db_delete', 'action_pdf_generate', 'action_file_write', 'webhook_respond']) {
      expect(SINGLE_ITEM_CONSUMER_DEFIDS.has(forbidden)).toBe(false);
    }
  });

  it('🚨 i trasformatori array→array NON sono produttori-trigger (la valle vuole la lista intera)', () => {
    for (const forbidden of ['logic_group_by', 'logic_distinct', 'logic_aggregate', 'logic_convert']) {
      expect(ARRAY_PRODUCER_DEFIDS.has(forbidden)).toBe(false);
    }
  });
});
