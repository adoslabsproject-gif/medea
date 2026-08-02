/**
 * Template-cache signature helpers — pure function tests.
 *
 * Asserzioni su VALORI specifici (non smoke). Coverage:
 *   - computeGraphSignature: ordina + DFS deterministico, gestisce multi-trigger + orphan
 *   - tokenizePrompt: lowercase, stopwords, dedup
 *   - jaccardSimilarity: intersection / union
 *   - defIdOverlap: max-denominator asymmetric
 *   - cosineSimilarity: standard dot / (||a|| · ||b||)
 *   - computeRetrievalScore: weighted combo somma a 1
 */
import { describe, it, expect } from 'vitest';
import {
  computeGraphSignature,
  extractDefIds,
  tokenizePrompt,
  jaccardSimilarity,
  defIdOverlap,
  cosineSimilarity,
  computeRetrievalScore,
} from './signature.js';

describe('computeGraphSignature', () => {
  it('linear chain: trigger_cron → action_http → db_insert', () => {
    const sig = computeGraphSignature(
      [
        { id: 'c', defId: 'trigger_cron' },
        { id: 'h', defId: 'action_http' },
        { id: 'd', defId: 'db_insert' },
      ],
      [
        { from: 'c', to: 'h' },
        { from: 'h', to: 'd' },
      ],
    );
    expect(sig).toBe('trigger_cron>action_http>db_insert');
  });

  it('multi-trigger: due chain separati da |', () => {
    const sig = computeGraphSignature(
      [
        { id: 'f', defId: 'trigger_file_watch' },
        { id: 'p', defId: 'action_pdf_parse' },
        { id: 'c', defId: 'trigger_cron' },
        { id: 'q', defId: 'db_query' },
      ],
      [
        { from: 'f', to: 'p' },
        { from: 'c', to: 'q' },
      ],
    );
    // Sort triggers by defId: trigger_cron before trigger_file_watch
    expect(sig).toBe('trigger_cron>db_query|trigger_file_watch>action_pdf_parse');
  });

  it('orphan nodes (no trigger ancestor) → suffix #orphan>...', () => {
    const sig = computeGraphSignature(
      [
        { id: 't', defId: 'trigger_cron' },
        { id: 'h', defId: 'action_http' },
        { id: 'x', defId: 'agent_summarizer' },
      ],
      [{ from: 't', to: 'h' }],
    );
    expect(sig).toContain('#orphan>agent_summarizer');
  });

  it('empty workflow → "#empty"', () => {
    expect(computeGraphSignature([], [])).toBe('#empty');
  });

  it('deterministic: stesso input → stesso output (DFS sort)', () => {
    // 2 esecuzioni della stessa stringa di nodi/edges deve ritornare
    // bit-identico, anche se l'array input è in ordine diverso.
    const nodes = [
      { id: 'a', defId: 'trigger_cron' },
      { id: 'b', defId: 'action_http' },
      { id: 'c', defId: 'community_slack' },
      { id: 'd', defId: 'community_telegram' },
    ];
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'b', to: 'd' },
    ];
    const sig1 = computeGraphSignature(nodes, edges);
    const sig2 = computeGraphSignature([...nodes].reverse(), [...edges].reverse());
    expect(sig1).toBe(sig2);
  });

  it('switch branching: visita tutti i rami', () => {
    const sig = computeGraphSignature(
      [
        { id: 't', defId: 'trigger_webhook' },
        { id: 'sw', defId: 'logic_switch' },
        { id: 'a', defId: 'action_http' },
        { id: 'b', defId: 'db_insert' },
      ],
      [
        { from: 't', to: 'sw' },
        { from: 'sw', to: 'a' },
        { from: 'sw', to: 'b' },
      ],
    );
    // Sort edges destination alphabetically: action_http before db_insert
    expect(sig).toBe('trigger_webhook>logic_switch>action_http>db_insert');
  });
});

describe('extractDefIds', () => {
  it('deduplica + ordina alfabeticamente', () => {
    const ids = extractDefIds([
      { defId: 'action_http' },
      { defId: 'action_http' },
      { defId: 'trigger_cron' },
      { defId: 'db_insert' },
    ]);
    expect(ids).toEqual(['action_http', 'db_insert', 'trigger_cron']);
  });

  it('empty → []', () => {
    expect(extractDefIds([])).toEqual([]);
  });
});

describe('tokenizePrompt', () => {
  it('lowercase + rimuovi stopwords + dedup', () => {
    const t = tokenizePrompt('Quando arriva una email IMAP, parse il PDF e salvalo nel database');
    expect(t).not.toContain('quando');
    expect(t).not.toContain('una');
    expect(t).not.toContain('il');
    expect(t).not.toContain('e');
    expect(t).toContain('email');
    expect(t).toContain('imap');
    expect(t).toContain('parse');
    expect(t).toContain('pdf');
    expect(t).toContain('database');
  });

  it('caratteri accentati IT preservati (per\\`, perche\\`)', () => {
    const t = tokenizePrompt('elabora perché serve');
    expect(t).toContain('elabora');
    expect(t).toContain('serve');
  });

  it('token < 3 char ignored', () => {
    const t = tokenizePrompt('AI di lavoro IO so');
    expect(t).not.toContain('ai');
    expect(t).not.toContain('di');
    expect(t).not.toContain('io');
    expect(t).not.toContain('so');
    expect(t).toContain('lavoro');
  });

  it('output ordinato e deduplicato', () => {
    const t = tokenizePrompt('email email PDF pdf SCAN scan');
    expect(t).toEqual(['email', 'pdf', 'scan']);
  });
});

describe('jaccardSimilarity', () => {
  it('identical sets → 1.0', () => {
    expect(jaccardSimilarity(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
  });

  it('disjoint sets → 0.0', () => {
    expect(jaccardSimilarity(['a', 'b'], ['c', 'd'])).toBe(0);
  });

  it('parziale: 2/4 intersection / 4 union = 0.5', () => {
    expect(jaccardSimilarity(['a', 'b', 'c'], ['b', 'c', 'd'])).toBeCloseTo(0.5, 5);
  });

  it('entrambi vuoti → 1.0 (edge case neutral)', () => {
    expect(jaccardSimilarity([], [])).toBe(1);
  });

  it('uno vuoto → 0.0', () => {
    expect(jaccardSimilarity([], ['a'])).toBe(0);
    expect(jaccardSimilarity(['a'], [])).toBe(0);
  });
});

describe('defIdOverlap', () => {
  it('query identico al template → 1.0', () => {
    expect(defIdOverlap(['trigger_cron', 'action_http'], ['trigger_cron', 'action_http'])).toBe(1);
  });

  it('template piu\\` grande del query → penalizzato', () => {
    // query 2 defId, template ne ha 10 → overlap = 2 / max(2, 10) = 0.2
    expect(
      defIdOverlap(['a', 'b'], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']),
    ).toBeCloseTo(0.2, 5);
  });

  it('query piu\\` grande del template → penalizzato', () => {
    expect(defIdOverlap(['a', 'b', 'c', 'd', 'e'], ['a'])).toBeCloseTo(0.2, 5);
  });

  it('disjoint → 0', () => {
    expect(defIdOverlap(['a', 'b'], ['x', 'y'])).toBe(0);
  });
});

describe('cosineSimilarity', () => {
  it('vettori identici → 1.0', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 5);
  });

  it('vettori opposti → -1.0', () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 5);
  });

  it('vettori ortogonali → 0.0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it('dimensioni diverse → 0', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('vettore zero → 0 (evita NaN)', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });
});

describe('computeRetrievalScore — pesi BUG FIX 2026-05-31', () => {
  it('pesi disponibili pre-LLM sommano a 1.0 (graph=0 reserved)', () => {
    // jaccard=1, cosine=1, success=1 → 0.50+0.40+0.10 = 1.0
    expect(
      computeRetrievalScore({ graphOverlap: 0, promptJaccard: 1, successRate: 1, cosine: 1 }),
    ).toBeCloseTo(1, 5);
  });

  it('prompt IDENTICO + cosine 1.0 + success 0.5 → 0.95 use_direct', () => {
    // SCENARIO REALE: utente fa stessa richiesta 2 volte.
    // = 0.50*1.0 + 0.40*1.0 + 0.10*0.5 = 0.50 + 0.40 + 0.05 = 0.95
    expect(
      computeRetrievalScore({ graphOverlap: 0, promptJaccard: 1.0, successRate: 0.5, cosine: 1.0 }),
    ).toBeCloseTo(0.95, 5);
  });

  it('prompt SIMILE (jaccard 0.7) + cosine 0.8 → 0.72 inject_fewshot', () => {
    expect(
      computeRetrievalScore({ graphOverlap: 0, promptJaccard: 0.7, successRate: 0.5, cosine: 0.8 }),
    ).toBeCloseTo(0.72, 5);
  });

  it('senza cosine (embedding fail): prompt identico → 0.55 inject_fewshot', () => {
    // jaccard=1, cosine=0, success=0.5 → 0.50 + 0 + 0.05 = 0.55
    expect(
      computeRetrievalScore({ graphOverlap: 0, promptJaccard: 1, successRate: 0.5, cosine: 0 }),
    ).toBeCloseTo(0.55, 5);
  });

  it('graphOverlap NON contribuisce (peso 0, reserved per second-pass)', () => {
    // Stesso input con graph 0 vs 1 → stesso score
    const a = computeRetrievalScore({
      graphOverlap: 0,
      promptJaccard: 0.5,
      successRate: 0.5,
      cosine: 0.5,
    });
    const b = computeRetrievalScore({
      graphOverlap: 1,
      promptJaccard: 0.5,
      successRate: 0.5,
      cosine: 0.5,
    });
    expect(a).toBe(b);
  });

  it('zero tutto → 0', () => {
    expect(
      computeRetrievalScore({ graphOverlap: 0, promptJaccard: 0, successRate: 0, cosine: 0 }),
    ).toBe(0);
  });
});
