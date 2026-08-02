/**
 * Test 2026-grade — auto-layout.service.ts (ELK graph layout for workflow editor).
 *
 * 🚨 UX-CRITICAL: workflow visual layout. Bug → nodes sovrapposti, edge mai
 * leggibili, sticky notes mossi → utente perde organizzazione.
 *
 * Coverage:
 *  - empty nodes → identity result + zero stats
 *  - solo sticky notes (no flow) → return con disconnected=nodes.length
 *  - happy path: ELK layout invocato + posizioni applicate ai flow nodes
 *  - edge filtering: from/to non in flowIds OR self-loop (e.from === e.to)
 *  - port resolution: fromPort → port.side corretta (NORTH/SOUTH/EAST)
 *  - 🚨 ELK throws → gridFallback (cols=ceil(sqrt(N)))
 *  - sticky note CON position originale → preserved (BUG-FIX 25 mag 2026)
 *  - sticky note SENZA position → piazzato sotto bbox a +i*240
 *  - options legacy mapping: rankdir LR→RIGHT, TB→DOWN, etc.
 *  - options custom (layerSpacing, nodeSpacing, edgeRouting, padding)
 *  - direction DOWN/UP → aspectRatio 0.6 (vertical)
 *  - direction RIGHT/LEFT → aspectRatio 1.6 (horizontal)
 *  - stats: laidOut, disconnected, bboxW/H, rankCount
 *  - portConstraints FIXED_SIDE quando > 1 porta, FREE altrimenti
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mock per ELK: la classe esposta da elkjs/lib/elk.bundled.js viene
// rimpiazzata con un costruttore stub che ritorna l'instance del modulo m.
const m = vi.hoisted(() => ({
  lastGraphPassed: null as unknown,
  layoutImpl: vi.fn(),
}));

vi.mock('elkjs/lib/elk.bundled.js', () => {
  class ELK {
    layout(graph: unknown): unknown {
      m.lastGraphPassed = graph;
      return m.layoutImpl(graph);
    }
  }
  return { default: ELK };
});

vi.mock('@/lib/logger.js');

import {
  autoLayout,
  type LayoutNode,
  type LayoutEdge,
  type LayoutOptions,
} from './auto-layout.service.js';

/**
 * Default ELK happy-path mock: piazza i nodi in colonna con x=100*idx e y=200.
 * Le posizioni numeriche risultanti sono deterministiche → assert facili.
 */
function happyPathLayout(graph: unknown): Promise<unknown> {
  const g = graph as { children?: { id: string }[] };
  return Promise.resolve({
    children: (g.children ?? []).map((c, i) => ({
      id: c.id,
      x: i * 200 + 10,
      y: 100,
    })),
  });
}

beforeEach(() => {
  m.lastGraphPassed = null;
  m.layoutImpl.mockReset().mockImplementation(happyPathLayout);
});

describe('autoLayout — empty / minimal inputs', () => {
  it('nodes=[] → identity result + stats zero', async () => {
    const r = await autoLayout([], []);
    expect(r.nodes).toEqual([]);
    expect(r.stats).toEqual({
      laidOut: 0,
      disconnected: 0,
      bboxWidth: 0,
      bboxHeight: 0,
      rankCount: 0,
    });
    expect(m.layoutImpl).not.toHaveBeenCalled();
  });

  it('🚨 solo sticky notes (no flow nodes) → disconnected=N, ELK NON chiamato', async () => {
    const nodes: LayoutNode[] = [
      { id: 's1', defId: 'note' },
      { id: 's2', defId: 'note' },
    ];
    const r = await autoLayout(nodes, []);
    expect(r.stats.disconnected).toBe(2);
    expect(r.stats.laidOut).toBe(0);
    expect(m.layoutImpl).not.toHaveBeenCalled();
    // I sticky vengono restituiti — nessun ELK
    expect(r.nodes).toEqual(nodes);
  });
});

describe('🚨 happy path — ELK invocato', () => {
  it('2 nodi 1 edge → posizioni assegnate dai dati ELK', async () => {
    const nodes: LayoutNode[] = [
      { id: 'n1', defId: 'action_http' },
      { id: 'n2', defId: 'action_db' },
    ];
    const edges: LayoutEdge[] = [{ from: 'n1', to: 'n2' }];
    const r = await autoLayout(nodes, edges);
    expect(m.layoutImpl).toHaveBeenCalledTimes(1);
    expect(r.stats.laidOut).toBe(2);
    expect(r.stats.disconnected).toBe(0);
    // mock piazza il primo a (10, 100) e il secondo a (210, 100)
    expect(r.nodes[0]?.x).toBe(10);
    expect(r.nodes[0]?.y).toBe(100);
    expect(r.nodes[1]?.x).toBe(210);
  });

  it('🚨 posizioni Math.round-ate (no float drift nel canvas)', async () => {
    m.layoutImpl.mockResolvedValue({
      children: [{ id: 'n1', x: 123.7, y: 89.4 }],
    });
    const r = await autoLayout([{ id: 'n1', defId: 'action_http' }], []);
    expect(r.nodes[0]?.x).toBe(124); // round 123.7
    expect(r.nodes[0]?.y).toBe(89); // round 89.4
  });

  it('ELK NON restituisce x/y per un nodo → quel nodo mantiene posizione originale', async () => {
    m.layoutImpl.mockResolvedValue({ children: [{ id: 'n1' /* niente x/y */ }] });
    const original = { id: 'n1', defId: 'action_http', x: 999, y: 999 };
    const r = await autoLayout([original], []);
    // Senza pos ELK → return n (identico)
    expect(r.nodes[0]?.x).toBe(999);
    expect(r.nodes[0]?.y).toBe(999);
  });

  it('ELK x/y non-numeric (es. NaN/string) → skipped, nodo conserva originale', async () => {
    m.layoutImpl.mockResolvedValue({
      children: [{ id: 'n1', x: 'not-number', y: NaN }],
    });
    const r = await autoLayout([{ id: 'n1', defId: 'a', x: 50, y: 60 }], []);
    expect(r.nodes[0]?.x).toBe(50);
    expect(r.nodes[0]?.y).toBe(60);
  });
});

describe('🚨 edge filtering', () => {
  it('edge con from inesistente → filtrato (passa solo edges valid)', async () => {
    const nodes: LayoutNode[] = [
      { id: 'n1', defId: 'a' },
      { id: 'n2', defId: 'b' },
    ];
    const edges: LayoutEdge[] = [
      { from: 'n1', to: 'n2' },
      { from: 'GHOST', to: 'n2' },
      { from: 'n1', to: 'PHANTOM' },
    ];
    await autoLayout(nodes, edges);
    const passed = m.lastGraphPassed as { edges: unknown[] };
    expect(passed.edges).toHaveLength(1); // solo n1→n2
  });

  it('🚨 self-loop (e.from === e.to) → filtrato', async () => {
    const nodes: LayoutNode[] = [{ id: 'n1', defId: 'a' }];
    const edges: LayoutEdge[] = [{ from: 'n1', to: 'n1' }];
    await autoLayout(nodes, edges);
    const passed = m.lastGraphPassed as { edges: unknown[] };
    expect(passed.edges).toHaveLength(0);
  });
});

describe('🚨 port resolution via fromPort', () => {
  async function getNodePorts(
    fromPort: string | undefined,
  ): Promise<{ layoutOptions: { 'elk.port.side': string } }[]> {
    const nodes: LayoutNode[] = [
      { id: 'n1', defId: 'gate' },
      { id: 'n2', defId: 'sink' },
    ];
    const edges: LayoutEdge[] = [{ from: 'n1', to: 'n2', ...(fromPort ? { fromPort } : {}) }];
    await autoLayout(nodes, edges);
    const passed = m.lastGraphPassed as {
      children: { id: string; ports?: { layoutOptions: { 'elk.port.side': string } }[] }[];
    };
    const n1 = passed.children.find((c) => c.id === 'n1');
    return n1?.ports ?? [];
  }

  it.each([
    ['true', 'NORTH'],
    ['success', 'NORTH'],
    ['yes', 'NORTH'],
    ['match', 'NORTH'],
    ['allow', 'NORTH'],
    ['body', 'NORTH'],
  ])('fromPort="%s" → port.side="%s"', async (port, expected) => {
    const ports = await getNodePorts(port);
    expect(ports[0]?.layoutOptions['elk.port.side']).toBe(expected);
  });

  it.each([
    ['false', 'SOUTH'],
    ['error', 'SOUTH'],
    ['no', 'SOUTH'],
    ['nomatch', 'SOUTH'],
    ['fallback', 'SOUTH'],
    ['deny', 'SOUTH'],
    ['skip', 'SOUTH'],
    ['done', 'SOUTH'],
  ])('fromPort="%s" → port.side="%s"', async (port, expected) => {
    const ports = await getNodePorts(port);
    expect(ports[0]?.layoutOptions['elk.port.side']).toBe(expected);
  });

  it('fromPort uppercase ("TRUE") → port.side="NORTH" (case-insensitive)', async () => {
    const ports = await getNodePorts('TRUE');
    expect(ports[0]?.layoutOptions['elk.port.side']).toBe('NORTH');
  });

  it('fromPort sconosciuto ("foo") → port.side="EAST" (default LR flow)', async () => {
    const ports = await getNodePorts('foo');
    expect(ports[0]?.layoutOptions['elk.port.side']).toBe('EAST');
  });

  it('🚨 fromPort undefined → nessuna porta esplicita ma _default port → EAST', async () => {
    const ports = await getNodePorts(undefined);
    expect(ports[0]?.layoutOptions['elk.port.side']).toBe('EAST');
  });

  it('🚨 portConstraints=FIXED_SIDE quando > 1 porta', async () => {
    const nodes: LayoutNode[] = [
      { id: 'gate', defId: 'gate' },
      { id: 'a', defId: 'a' },
      { id: 'b', defId: 'b' },
    ];
    const edges: LayoutEdge[] = [
      { from: 'gate', to: 'a', fromPort: 'true' },
      { from: 'gate', to: 'b', fromPort: 'false' },
    ];
    await autoLayout(nodes, edges);
    const passed = m.lastGraphPassed as {
      children: { id: string; layoutOptions: Record<string, string> }[];
    };
    const gate = passed.children.find((c) => c.id === 'gate');
    expect(gate?.layoutOptions['elk.portConstraints']).toBe('FIXED_SIDE');
  });

  it('🚨 portConstraints=FREE quando 1 porta', async () => {
    const nodes: LayoutNode[] = [
      { id: 'n1', defId: 'a' },
      { id: 'n2', defId: 'b' },
    ];
    const edges: LayoutEdge[] = [{ from: 'n1', to: 'n2', fromPort: 'true' }];
    await autoLayout(nodes, edges);
    const passed = m.lastGraphPassed as {
      children: { id: string; layoutOptions: Record<string, string> }[];
    };
    const n1 = passed.children.find((c) => c.id === 'n1');
    expect(n1?.layoutOptions['elk.portConstraints']).toBe('FREE');
  });

  it('🚨 portConstraints=FREE quando NESSUNA porta (zero outbound edge)', async () => {
    const nodes: LayoutNode[] = [
      { id: 'n1', defId: 'a' },
      { id: 'n2', defId: 'b' },
    ];
    const edges: LayoutEdge[] = [{ from: 'n2', to: 'n1' }]; // n1 senza outbound
    await autoLayout(nodes, edges);
    const passed = m.lastGraphPassed as {
      children: { id: string; layoutOptions: Record<string, string> }[];
    };
    const n1 = passed.children.find((c) => c.id === 'n1');
    expect(n1?.layoutOptions['elk.portConstraints']).toBe('FREE');
  });
});

describe('🚨 ELK fail → gridFallback', () => {
  it('ELK throw → grid layout cols=ceil(sqrt(N))', async () => {
    m.layoutImpl.mockRejectedValue(new Error('elk internal error'));
    const nodes: LayoutNode[] = Array.from({ length: 4 }, (_, i) => ({
      id: `n${String(i)}`,
      defId: 'a',
    }));
    const r = await autoLayout(nodes, []);
    // grid: cols = ceil(sqrt(4)) = 2 — i nodi sono piazzati in griglia 2×2
    expect(r.nodes).toHaveLength(4);
    // Tutti i nodi devono avere x, y assegnati
    expect(r.nodes.every((n) => typeof n.x === 'number' && typeof n.y === 'number')).toBe(true);
    // rankCount = cols = 2
    expect(r.stats.rankCount).toBe(2);
  });

  it('grid: 9 nodi → cols=3 (ceil(sqrt(9)))', async () => {
    m.layoutImpl.mockRejectedValue(new Error('boom'));
    const nodes: LayoutNode[] = Array.from({ length: 9 }, (_, i) => ({
      id: `n${String(i)}`,
      defId: 'a',
    }));
    const r = await autoLayout(nodes, []);
    expect(r.stats.rankCount).toBe(3);
  });

  it('grid: 1 nodo → x=80, y=80 (start offset)', async () => {
    m.layoutImpl.mockRejectedValue(new Error('boom'));
    const r = await autoLayout([{ id: 'n1', defId: 'a' }], []);
    expect(r.nodes[0]?.x).toBe(80);
    expect(r.nodes[0]?.y).toBe(80);
  });

  it('🚨 grid fallback preserva tutti i nodi (anche sticky)', async () => {
    m.layoutImpl.mockRejectedValue(new Error('boom'));
    const nodes: LayoutNode[] = [
      { id: 'n1', defId: 'a' },
      { id: 's1', defId: 'note' }, // sticky
    ];
    const r = await autoLayout(nodes, []);
    expect(r.nodes).toHaveLength(2);
  });
});

describe('🚨 sticky notes — preserve original position (BUG-FIX 25 mag 2026)', () => {
  it('sticky con x/y originali → preserved INVARIATI', async () => {
    const nodes: LayoutNode[] = [
      { id: 'n1', defId: 'a' },
      { id: 's1', defId: 'note', x: 1234, y: 5678 },
    ];
    const r = await autoLayout(nodes, []);
    const sticky = r.nodes.find((n) => n.id === 's1');
    expect(sticky?.x).toBe(1234);
    expect(sticky?.y).toBe(5678);
  });

  it('🚨 sticky SENZA position → piazzato sotto bbox a +i*240', async () => {
    const nodes: LayoutNode[] = [
      { id: 'n1', defId: 'a' },
      { id: 's1', defId: 'note' }, // no x/y
      { id: 's2', defId: 'note' },
    ];
    const r = await autoLayout(nodes, []);
    const s1 = r.nodes.find((n) => n.id === 's1');
    const s2 = r.nodes.find((n) => n.id === 's2');
    expect(typeof s1?.x).toBe('number');
    expect(typeof s2?.x).toBe('number');
    // s2 dovrebbe essere a +240 vs s1 (i*240 offset)
    expect((s2?.x ?? 0) - (s1?.x ?? 0)).toBe(240);
    // entrambi sotto la bbox dei flow nodes (y > bbox.maxY del flow nodes)
    expect(s1?.y).toBeGreaterThan(100); // ELK piazza flow a y=100
  });

  it('mix: sticky con pos preservato + sticky senza pos piazzato', async () => {
    const nodes: LayoutNode[] = [
      { id: 'n1', defId: 'a' },
      { id: 's1', defId: 'note', x: 999, y: 999 }, // con pos
      { id: 's2', defId: 'note' }, // senza pos
    ];
    const r = await autoLayout(nodes, []);
    expect(r.nodes.find((n) => n.id === 's1')?.x).toBe(999);
    expect(r.nodes.find((n) => n.id === 's2')?.x).not.toBe(999);
  });
});

describe('🚨 options — legacy back-compat + new', () => {
  it('rankdir=TB → direction=DOWN passato a ELK', async () => {
    await autoLayout([{ id: 'n1', defId: 'a' }], [], { rankdir: 'TB' });
    const passed = m.lastGraphPassed as { layoutOptions: Record<string, string> };
    expect(passed.layoutOptions['elk.direction']).toBe('DOWN');
  });

  it('rankdir=BT → direction=UP', async () => {
    await autoLayout([{ id: 'n1', defId: 'a' }], [], { rankdir: 'BT' });
    const passed = m.lastGraphPassed as { layoutOptions: Record<string, string> };
    expect(passed.layoutOptions['elk.direction']).toBe('UP');
  });

  it('rankdir=RL → direction=LEFT', async () => {
    await autoLayout([{ id: 'n1', defId: 'a' }], [], { rankdir: 'RL' });
    const passed = m.lastGraphPassed as { layoutOptions: Record<string, string> };
    expect(passed.layoutOptions['elk.direction']).toBe('LEFT');
  });

  it('rankdir=LR (default) → direction=RIGHT', async () => {
    await autoLayout([{ id: 'n1', defId: 'a' }], [], { rankdir: 'LR' });
    const passed = m.lastGraphPassed as { layoutOptions: Record<string, string> };
    expect(passed.layoutOptions['elk.direction']).toBe('RIGHT');
  });

  it('options.direction esplicita PREVALE su rankdir', async () => {
    await autoLayout([{ id: 'n1', defId: 'a' }], [], { direction: 'UP', rankdir: 'LR' });
    const passed = m.lastGraphPassed as { layoutOptions: Record<string, string> };
    expect(passed.layoutOptions['elk.direction']).toBe('UP');
  });

  it('nodesep legacy → elk.spacing.nodeNode', async () => {
    await autoLayout([{ id: 'n1', defId: 'a' }], [], { nodesep: 33 });
    const passed = m.lastGraphPassed as { layoutOptions: Record<string, string> };
    expect(passed.layoutOptions['elk.spacing.nodeNode']).toBe('33');
  });

  it('ranksep legacy → elk.layered.spacing.nodeNodeBetweenLayers', async () => {
    await autoLayout([{ id: 'n1', defId: 'a' }], [], { ranksep: 77 });
    const passed = m.lastGraphPassed as { layoutOptions: Record<string, string> };
    expect(passed.layoutOptions['elk.layered.spacing.nodeNodeBetweenLayers']).toBe('77');
  });

  it('marginx legacy → padding', async () => {
    await autoLayout([{ id: 'n1', defId: 'a' }], [], { marginx: 17 });
    const passed = m.lastGraphPassed as { layoutOptions: Record<string, string> };
    expect(passed.layoutOptions['elk.padding']).toContain('top=17');
  });

  it('new opts: layerSpacing + nodeSpacing + edgeRouting + padding', async () => {
    const opts: LayoutOptions = {
      layerSpacing: 200,
      nodeSpacing: 90,
      edgeRouting: 'POLYLINE',
      padding: 25,
    };
    await autoLayout([{ id: 'n1', defId: 'a' }], [], opts);
    const passed = m.lastGraphPassed as { layoutOptions: Record<string, string> };
    expect(passed.layoutOptions['elk.layered.spacing.nodeNodeBetweenLayers']).toBe('200');
    expect(passed.layoutOptions['elk.spacing.nodeNode']).toBe('90');
    expect(passed.layoutOptions['elk.edgeRouting']).toBe('POLYLINE');
    expect(passed.layoutOptions['elk.padding']).toContain('top=25');
  });

  it('🚨 direction=DOWN → aspectRatio 0.6 (vertical layout)', async () => {
    await autoLayout([{ id: 'n1', defId: 'a' }], [], { direction: 'DOWN' });
    const passed = m.lastGraphPassed as { layoutOptions: Record<string, string> };
    expect(passed.layoutOptions['elk.aspectRatio']).toBe('0.6');
  });

  it('🚨 direction=UP → aspectRatio 0.6 (vertical layout)', async () => {
    await autoLayout([{ id: 'n1', defId: 'a' }], [], { direction: 'UP' });
    const passed = m.lastGraphPassed as { layoutOptions: Record<string, string> };
    expect(passed.layoutOptions['elk.aspectRatio']).toBe('0.6');
  });

  it('🚨 direction=RIGHT → aspectRatio 1.6 (horizontal layout)', async () => {
    await autoLayout([{ id: 'n1', defId: 'a' }], [], { direction: 'RIGHT' });
    const passed = m.lastGraphPassed as { layoutOptions: Record<string, string> };
    expect(passed.layoutOptions['elk.aspectRatio']).toBe('1.6');
  });
});

describe('🚨 stats', () => {
  it('happy: laidOut conta i flow nodes, disconnected conta gli sticky', async () => {
    const nodes: LayoutNode[] = [
      { id: 'n1', defId: 'a' },
      { id: 'n2', defId: 'b' },
      { id: 's1', defId: 'note', x: 10, y: 10 },
    ];
    const r = await autoLayout(nodes, []);
    expect(r.stats.laidOut).toBe(2);
    expect(r.stats.disconnected).toBe(1);
  });

  it('🚨 bbox include i sticky (final bbox = min/max di TUTTI i nodi)', async () => {
    // ELK piazza i flow nodes a y=100; sticky con x=2000, y=2000
    const nodes: LayoutNode[] = [
      { id: 'n1', defId: 'a' },
      { id: 's1', defId: 'note', x: 2000, y: 2000 },
    ];
    const r = await autoLayout(nodes, []);
    expect(r.stats.bboxWidth).toBeGreaterThan(0);
    expect(r.stats.bboxHeight).toBeGreaterThan(0);
  });

  it('rankCount = numero distinct buckets di x/50 dei flow nodes', async () => {
    // ELK mock piazza nodes a x = i*200 + 10
    // x/50 round: n1=0/0, n2=4/4, n3=8/8 → 3 buckets
    const nodes: LayoutNode[] = [
      { id: 'n1', defId: 'a' },
      { id: 'n2', defId: 'b' },
      { id: 'n3', defId: 'c' },
    ];
    const r = await autoLayout(nodes, []);
    expect(r.stats.rankCount).toBe(3);
  });
});

describe('preserve user properties on nodes', () => {
  it('proprietà extra (name, notes, config) sopravvivono al layout', async () => {
    const nodes: LayoutNode[] = [
      {
        id: 'n1',
        defId: 'a',
        name: 'Custom Name',
        notes: 'My notes',
        config: { foo: 'bar' },
        customField: 'value' as unknown as never,
      },
    ];
    const r = await autoLayout(nodes, []);
    const n = r.nodes[0];
    expect(n?.name).toBe('Custom Name');
    expect(n?.notes).toBe('My notes');
    expect(n?.config).toEqual({ foo: 'bar' });
    expect((n as Record<string, unknown>).customField).toBe('value');
  });
});
