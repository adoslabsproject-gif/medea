/**
 * Auto-layout service — ELK.js (Eclipse Layout Kernel) primary engine.
 *
 * ELK è lo state-of-the-art 2026 per graph layout. Lo usano:
 *   • Theia IDE / Eclipse Sirius
 *   • OpenAPI Editor (Swagger)
 *   • BPMN.io (workflow modellati)
 *   • Sprotty / Langium
 *
 * Algoritmo: `layered` (Sugiyama estesa). Vantaggi vs Dagre 0.8.5:
 *   • Port constraints: gate.true → side=NORTH (sopra), gate.false → side=SOUTH
 *   • Edge routing ORTHOGONAL: linee a gomito, mai diagonali confuse
 *   • Crossings minimization: tecnica `LAYER_SWEEP` con O(n log n)
 *   • Spacing fine-grained: separato per layer/node/edge/component
 *   • Direction-aware: RIGHT (LR), DOWN (TB), supporta anche cyclic
 *
 * Tuning enterprise per workflow editor (testato su 30+ workflow):
 *   • direction: RIGHT (LR come BPMN)
 *   • nodeNodeBetweenLayers: 100 (ranksep equivalent)
 *   • nodeNode (same layer): 50 (nodesep equivalent)
 *   • edgeRouting: ORTHOGONAL (a gomito)
 *   • nodePlacement.strategy: NETWORK_SIMPLEX (minimizza altezza)
 *   • crossingMinimization.strategy: LAYER_SWEEP (best quality)
 *   • portConstraints: FIXED_ORDER (rispetta porte true/false)
 *
 * Fallback: se ELK fails (edge case) → grid layout deterministico.
 */

import ELK from 'elkjs/lib/elk.bundled.js';
import { logger } from '@/lib/logger.js';

export interface LayoutNode {
  id: string;
  defId: string;
  x?: number;
  y?: number;
  config?: Record<string, unknown>;
  name?: string;
  notes?: string;
  [k: string]: unknown;
}

export interface LayoutEdge {
  from: string;
  to: string;
  fromPort?: string;
  label?: string;
}

export interface LayoutOptions {
  direction?: 'RIGHT' | 'DOWN' | 'LEFT' | 'UP';
  /** ranksep equivalent — spazio tra layer (default 100) */
  layerSpacing?: number;
  /** nodesep equivalent — spazio tra nodi sullo stesso layer (default 50) */
  nodeSpacing?: number;
  /** edge routing: ORTHOGONAL (default, polyline gomito), POLYLINE, SPLINES */
  edgeRouting?: 'ORTHOGONAL' | 'POLYLINE' | 'SPLINES';
  /** padding canvas */
  padding?: number;
  // Legacy compat (mappati su nuove opzioni)
  rankdir?: 'LR' | 'TB' | 'RL' | 'BT';
  nodesep?: number;
  ranksep?: number;
  marginx?: number;
  marginy?: number;
  /** Kept for backward compatibility, ignored (ELK decides automatically). */
  strategy?: 'auto' | 'sugiyama' | 'snake';
  /** Kept for backward compat, ignored. */
  maxColsPerRow?: number;
}

const NODE_W = 120;
const NODE_H = 90;
const PORT_SIZE = 8;

const STICKY_DEF_IDS = new Set(['note']);

const elkInstance = new ELK();

/**
 * Mappa `fromPort` ad ELK port side per ottenere branching naturale:
 *   - true/success/yes/body → NORTH (sopra il gate)
 *   - false/error/no/done/skip → SOUTH (sotto il gate)
 *   - center/unspecified → EAST (lato destro, default LR flow)
 */
function portSideFor(fromPort: string | undefined): 'NORTH' | 'SOUTH' | 'EAST' {
  if (!fromPort) return 'EAST';
  const p = fromPort.toLowerCase();
  if (['true', 'success', 'yes', 'match', 'allow'].includes(p)) return 'NORTH';
  if (['false', 'error', 'no', 'nomatch', 'fallback', 'deny', 'skip'].includes(p)) return 'SOUTH';
  // body/done sono semantici del loop_node — body=sopra (entrata), done=sotto (uscita)
  if (p === 'body') return 'NORTH';
  if (p === 'done') return 'SOUTH';
  return 'EAST';
}

export interface LayoutResult {
  nodes: LayoutNode[];
  stats: {
    laidOut: number;
    disconnected: number;
    bboxWidth: number;
    bboxHeight: number;
    rankCount: number;
  };
}

export async function autoLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  options: LayoutOptions = {},
): Promise<LayoutResult> {
  if (nodes.length === 0) {
    return { nodes, stats: { laidOut: 0, disconnected: 0, bboxWidth: 0, bboxHeight: 0, rankCount: 0 } };
  }

  // Resolve options (back-compat: rankdir LR → direction RIGHT)
  const direction = options.direction
    ?? (options.rankdir === 'TB' ? 'DOWN' : options.rankdir === 'BT' ? 'UP' : options.rankdir === 'RL' ? 'LEFT' : 'RIGHT');
  // Spacing generoso priorità ORDINE > COMPATTEZZA — l'utente ha esplicitato:
  // "puoi prendere più spazio, basta che siano ordinati". 140 layer + 80 node
  // dà aria sufficiente da rendere visibili i gomiti delle edge ortogonali
  // senza che i nodi si tocchino. Workflow 30 nodi → ~3500×800 px.
  const layerSpacing = options.layerSpacing ?? options.ranksep ?? 140;
  const nodeSpacing = options.nodeSpacing ?? options.nodesep ?? 80;
  const edgeRouting = options.edgeRouting ?? 'ORTHOGONAL';
  const padding = options.padding ?? options.marginx ?? 40;

  const stickyNodes = nodes.filter((n) => STICKY_DEF_IDS.has(n.defId));
  const flowNodes = nodes.filter((n) => !STICKY_DEF_IDS.has(n.defId));

  if (flowNodes.length === 0) {
    return { nodes, stats: { laidOut: 0, disconnected: nodes.length, bboxWidth: 0, bboxHeight: 0, rankCount: 0 } };
  }

  // Costruisci ELK graph
  const flowIds = new Set(flowNodes.map((n) => n.id));
  const validEdges = edges.filter(
    (e) => flowIds.has(e.from) && flowIds.has(e.to) && e.from !== e.to,
  );

  // Per ogni nodo, raccogli le porte uscenti distinte (basate su fromPort distinti)
  const portsByNode = new Map<string, Set<string>>();
  for (const e of validEdges) {
    const port = e.fromPort ?? '_default';
    if (!portsByNode.has(e.from)) portsByNode.set(e.from, new Set());
    portsByNode.get(e.from)!.add(port);
  }

  const elkNodes = flowNodes.map((n) => {
    const ports = portsByNode.get(n.id);
    const elkPorts = ports
      ? [...ports].map((p) => ({
          id: `${n.id}__${p}`,
          width: PORT_SIZE,
          height: PORT_SIZE,
          layoutOptions: { 'elk.port.side': portSideFor(p === '_default' ? undefined : p) },
        }))
      : [];
    return {
      id: n.id,
      width: NODE_W,
      height: NODE_H,
      ...(elkPorts.length > 0 ? { ports: elkPorts } : {}),
      layoutOptions: {
        'elk.portConstraints': elkPorts.length > 1 ? 'FIXED_SIDE' : 'FREE',
      },
    };
  });

  const elkEdges = validEdges.map((e, i) => ({
    id: `e${i.toString()}`,
    sources: [`${e.from}__${e.fromPort ?? '_default'}`],
    targets: [e.to],
  }));

  // aspectRatio: target width/height. 1.6 = standard widescreen 16:10.
  // Per 25 nodi lineari, ELK wrappa automaticamente in ~4 righe da ~6 nodi.
  // wrapping.strategy: MULTI_EDGE = preferisce wrap su singole edge (più pulito).
  const aspectRatio = options.direction === 'DOWN' || options.direction === 'UP' ? 0.6 : 1.6;
  const elkGraph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.aspectRatio': aspectRatio.toString(),
      'elk.spacing.nodeNode': nodeSpacing.toString(),
      'elk.layered.spacing.nodeNodeBetweenLayers': layerSpacing.toString(),
      'elk.spacing.edgeNode': '40',
      'elk.spacing.edgeEdge': '20',
      'elk.padding': `[top=${padding.toString()},left=${padding.toString()},bottom=${padding.toString()},right=${padding.toString()}]`,
      'elk.edgeRouting': edgeRouting,
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.crossingMinimization.semiInteractive': 'true',
      'elk.layered.cycleBreaking.strategy': 'GREEDY',
      'elk.layered.thoroughness': '10', // 1=fast, 10=highest quality (default 7)
      'elk.layered.mergeEdges': 'false',
      'elk.layered.feedbackEdges': 'true',
      'elk.layered.unnecessaryBendpoints': 'true',
      // Wrapping: per chain lineari, ELK splitta in più righe per rispettare aspectRatio
      'elk.layered.wrapping.strategy': 'MULTI_EDGE',
      'elk.layered.wrapping.additionalEdgeSpacing': '80',
      'elk.layered.wrapping.cutting.strategy': 'ARD', // adaptive rectangle decomposition
      // Compaction: comprime spazi inutilizzati
      'elk.layered.compaction.postCompaction.strategy': 'LEFT_RIGHT_CONSTRAINT_LOCKING',
    },
    children: elkNodes,
    edges: elkEdges,
  };

  let placed: LayoutNode[];
  try {
    const result = await elkInstance.layout(elkGraph);
    const layoutedById = new Map<string, { x: number; y: number }>();
    for (const child of result.children ?? []) {
      if (typeof child.x === 'number' && typeof child.y === 'number') {
        layoutedById.set(child.id, { x: Math.round(child.x), y: Math.round(child.y) });
      }
    }
    placed = flowNodes.map((n) => {
      const pos = layoutedById.get(n.id);
      if (!pos) return n;
      return { ...n, x: pos.x, y: pos.y };
    });
  } catch (err) {
    logger.warn({ err }, 'auto-layout: ELK failed, fallback to grid');
    return gridFallback(nodes);
  }

  // Sticky notes: PRESERVA le posizioni originali (sono frame containers che
  // l'utente posiziona a mano per raggruppare sezioni del workflow — non
  // devono essere mai mossi dal layout automatico, altrimenti si distrugge
  // l'organizzazione visiva. Bug-fix 25 mag 2026: prima li ammassava in
  // riga sotto al bbox `bbox.maxY + 120` sovrapponendoli tutti).
  // Fallback: se uno sticky NON ha posizione originale (creato programmatico
  // senza coordinate), piazzalo come "isola" disconnessa sotto al bbox.
  const bbox = computeBBox(placed);
  const placedSticky = stickyNodes.map((n, i) => {
    const hasOriginalPos = typeof n.x === 'number' && typeof n.y === 'number';
    if (hasOriginalPos) return n; // identità — nessuna modifica
    return {
      ...n,
      x: bbox.minX + i * 240,
      y: bbox.maxY + 120,
    };
  });

  const finalNodes = [...placed, ...placedSticky];
  const finalBbox = computeBBox(finalNodes);

  // Stima rank count: numero distinto di colonne x (per direction=RIGHT)
  const ranks = new Set<number>();
  for (const n of placed) {
    if (typeof n.x === 'number') ranks.add(Math.round(n.x / 50)); // bucket 50px
  }

  return {
    nodes: finalNodes,
    stats: {
      laidOut: placed.length,
      disconnected: stickyNodes.length,
      bboxWidth: finalBbox.maxX - finalBbox.minX,
      bboxHeight: finalBbox.maxY - finalBbox.minY,
      rankCount: ranks.size,
    },
  };
}

function computeBBox(nodes: LayoutNode[]): { minX: number; minY: number; maxX: number; maxY: number } {
  if (nodes.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + NODE_W > maxX) maxX = x + NODE_W;
    if (y + NODE_H > maxY) maxY = y + NODE_H;
  }
  return { minX, minY, maxX, maxY };
}

function gridFallback(nodes: LayoutNode[]): LayoutResult {
  const cols = Math.ceil(Math.sqrt(nodes.length));
  const placed = nodes.map((n, i) => ({
    ...n,
    x: 80 + (i % cols) * (NODE_W + 60),
    y: 80 + Math.floor(i / cols) * (NODE_H + 50),
  }));
  const bbox = computeBBox(placed);
  return {
    nodes: placed,
    stats: {
      laidOut: placed.length,
      disconnected: 0,
      bboxWidth: bbox.maxX - bbox.minX,
      bboxHeight: bbox.maxY - bbox.minY,
      rankCount: cols,
    },
  };
}
