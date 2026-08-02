/**
 * Singleshot stream parser — test 2026-grade su REAL output shape.
 *
 * Coverage:
 *  - emit onNodeAdded per ogni nodo completato man mano che il chunk arriva
 *  - chunk arbitrari (anche dividendo a meta\` di un nodo o stringa)
 *  - escape `\"` dentro stringhe
 *  - emit onEdgeAdded dopo nodes[] chiuso
 *  - emit onMeta con name/description appena disponibili
 *  - getAccumulated ritorna buffer intero (per Zod parse finale)
 */
import { describe, it, expect, vi } from 'vitest';
import { SingleshotStreamParser } from './singleshot-stream-parser.js';

const SAMPLE_OUTPUT = `{
  "name": "Daily Report",
  "description": "Invia report email ogni giorno",
  "reasoning": "Cron trigger + db query + send email",
  "nodes": [
    { "id": "n1", "defId": "trigger_cron", "config": { "cronExpression": "0 9 * * *" } },
    { "id": "n2", "defId": "db_query", "config": { "table": "logs" } },
    { "id": "n3", "defId": "action_send_email", "config": { "to": "x@y.io", "subject": "Report \\"daily\\"" } }
  ],
  "edges": [
    { "from": "n1", "to": "n2" },
    { "from": "n2", "to": "n3" }
  ]
}`;

describe('SingleshotStreamParser — full buffer', () => {
  it('emette 3 nodi + 2 edge in ordine', () => {
    const nodes: unknown[] = [];
    const edges: unknown[] = [];
    const p = new SingleshotStreamParser({
      onNodeAdded: (n) => {
        nodes.push(n);
      },
      onEdgeAdded: (e) => {
        edges.push(e);
      },
    });
    p.feed(SAMPLE_OUTPUT);
    expect(nodes.length).toBe(3);
    expect(edges.length).toBe(2);
    expect((nodes[0] as { id: string }).id).toBe('n1');
    expect((nodes[2] as { id: string }).id).toBe('n3');
    expect((edges[0] as { from: string }).from).toBe('n1');
  });

  it('callback onMeta con name + description', () => {
    const onMeta = vi.fn();
    const p = new SingleshotStreamParser({ onMeta });
    p.feed(SAMPLE_OUTPUT);
    expect(onMeta).toHaveBeenCalled();
    const meta = onMeta.mock.calls[0]![0] as { name: string; description: string };
    expect(meta.name).toBe('Daily Report');
    expect(meta.description).toBe('Invia report email ogni giorno');
  });

  it('gestisce escape `\\"` dentro stringa', () => {
    const nodes: unknown[] = [];
    const p = new SingleshotStreamParser({
      onNodeAdded: (n) => {
        nodes.push(n);
      },
    });
    p.feed(SAMPLE_OUTPUT);
    const lastNode = nodes[2] as { config: { subject: string } };
    expect(lastNode.config.subject).toBe('Report "daily"');
  });
});

describe('SingleshotStreamParser — chunked streaming', () => {
  it('feed character-by-character → stessi 3 nodi emessi', () => {
    const nodes: unknown[] = [];
    const p = new SingleshotStreamParser({
      onNodeAdded: (n) => {
        nodes.push(n);
      },
    });
    for (const ch of SAMPLE_OUTPUT) p.feed(ch);
    expect(nodes.length).toBe(3);
  });

  it('feed random chunks (10-50 char) → 3 nodi + 2 edge', () => {
    const nodes: unknown[] = [];
    const edges: unknown[] = [];
    const p = new SingleshotStreamParser({
      onNodeAdded: (n) => {
        nodes.push(n);
      },
      onEdgeAdded: (e) => {
        edges.push(e);
      },
    });
    let i = 0;
    while (i < SAMPLE_OUTPUT.length) {
      const len = Math.floor(Math.random() * 40) + 10;
      p.feed(SAMPLE_OUTPUT.slice(i, i + len));
      i += len;
    }
    expect(nodes.length).toBe(3);
    expect(edges.length).toBe(2);
  });

  it('chunk che divide a meta\\` di un nodo', () => {
    const nodes: unknown[] = [];
    const p = new SingleshotStreamParser({
      onNodeAdded: (n) => {
        nodes.push(n);
      },
    });
    const midpoint = SAMPLE_OUTPUT.indexOf('"defId": "db_query"');
    p.feed(SAMPLE_OUTPUT.slice(0, midpoint + 5));
    expect(nodes.length).toBe(1); // solo n1 completo
    p.feed(SAMPLE_OUTPUT.slice(midpoint + 5));
    expect(nodes.length).toBe(3); // tutti
  });
});

describe('SingleshotStreamParser — stats + reset', () => {
  it('stats riflette stato', () => {
    const p = new SingleshotStreamParser();
    p.feed(SAMPLE_OUTPUT);
    const s = p.getStats();
    expect(s.nodesEmitted).toBe(3);
    expect(s.edgesEmitted).toBe(2);
    expect(s.phase).toBe('done');
  });

  it('reset → riusabile', () => {
    const nodes: unknown[] = [];
    const p = new SingleshotStreamParser({
      onNodeAdded: (n) => {
        nodes.push(n);
      },
    });
    p.feed(SAMPLE_OUTPUT);
    expect(nodes.length).toBe(3);
    p.reset();
    nodes.length = 0;
    p.feed(SAMPLE_OUTPUT);
    expect(nodes.length).toBe(3);
  });

  it('getAccumulated ritorna buffer intero', () => {
    const p = new SingleshotStreamParser();
    p.feed(SAMPLE_OUTPUT);
    expect(p.getAccumulated()).toBe(SAMPLE_OUTPUT);
  });
});

describe('SingleshotStreamParser — edge cases', () => {
  it('output vuoto → niente emit', () => {
    const onNodeAdded = vi.fn();
    const p = new SingleshotStreamParser({ onNodeAdded });
    p.feed('');
    expect(onNodeAdded).not.toHaveBeenCalled();
  });

  it('output incompleto (chiuso a meta\\` di un nodo) → emette solo i completi', () => {
    const truncated = SAMPLE_OUTPUT.indexOf('{ "from": "n1"');
    const partial = SAMPLE_OUTPUT.slice(0, truncated + 12); // metà di edges
    const nodes: unknown[] = [];
    const edges: unknown[] = [];
    const p = new SingleshotStreamParser({
      onNodeAdded: (n) => {
        nodes.push(n);
      },
      onEdgeAdded: (e) => {
        edges.push(e);
      },
    });
    p.feed(partial);
    expect(nodes.length).toBe(3);
    expect(edges.length).toBe(0); // edge non chiuso
  });
});
