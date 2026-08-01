/**
 * Draft mutation tools — edit chirurgico sul draft in-memory.
 *
 * Ogni op è O(n) su array small (workflow rare superano 50 nodi).
 *
 * - addNodeHandler:         add_node con validazione per-field (enum/regex/required)
 * - connectNodesHandler:    connect_nodes con orphan-edge guard
 * - finalizeWorkflowHandler: finalize_workflow con orphan-edge double-check
 * - abortHandler:           agent ha rinunciato (terminates loop)
 * - updateNodeHandler:      patch config con re-validation per-field
 * - deleteNodeHandler:      remove node + cascade edges
 * - disconnectNodesHandler: remove edge specifico (from, to, fromPort?)
 *
 * Estratto da ai-scaffold.service.ts (refactor 2026-05-28).
 */

import { coerceString } from '@/lib/coerce.js';
import type { ScaffoldSession } from '@/services/ai-scaffold.service.js';
import type { ToolResult, DraftNode, DraftEdge } from '@/services/ai-scaffold/types.js';
import { buildNodeCatalog } from '@/services/ai-scaffold/node-catalog.js';
import { shouldRejectFinalize } from '@/services/ai-scaffold/tools/complexity-gate.js';
import { evaluateAbort } from '@/services/ai-scaffold/tools/abort-gate.js';
import { requirePlan } from '@/services/ai-scaffold/tools/plan-handler.js';

export function addNodeHandler(session: ScaffoldSession, args: Record<string, unknown>): ToolResult {
  const planReject = requirePlan(session, 'add_node');
  if (planReject) return planReject;
  const id = coerceString(args.id ?? '');
  const defId = coerceString(args.defId ?? '');
  if (!id) return { ok: false, error: 'add_node richiede "id"' };
  if (!defId) return { ok: false, error: 'add_node richiede "defId"' };
  const catalog = buildNodeCatalog();
  const entry = catalog.find((c) => c.defId === defId);
  if (!entry) {
    return { ok: false, error: `defId "${defId}" non nel catalogo runtime. ${catalog.length.toString()} nodi disponibili. Usa list_node_catalog per la lista completa.` };
  }
  // Validate config values against field schema (enum / pattern).
  const config = (args.config as Record<string, unknown>) ?? {};
  // FIX 2026-05-31: enumera TUTTI i required mancanti in un solo error (Liara
  // ne poteva indovinare uno e ri-fallire sul prossimo). Cosi\` un solo retry.
  const missingRequired = entry.fields
    .filter((f) => f.required && (config[f.key] === undefined || config[f.key] === ''))
    .map((f) => `"${f.key}" (${f.type}${f.options ? ` enum[${f.options.join('|')}]` : ''})`);
  if (missingRequired.length > 0) {
    return {
      ok: false,
      error: `Nodo ${defId}: campi REQUIRED mancanti: ${missingRequired.join(', ')}. Rifai add_node con TUTTI questi nel config. Vedi list_node_catalog(defId:"${defId}") per le descrizioni complete.`,
    };
  }
  for (const field of entry.fields) {
    const value = config[field.key];
    if (value === undefined || value === '') continue;
    const strVal = typeof value === 'string' ? value : JSON.stringify(value);
    if (field.options && field.options.length > 0 && !field.options.includes(strVal)) {
      return { ok: false, error: `Nodo ${defId}: campo "${field.key}" = "${strVal}" non è in [${field.options.join('|')}]` };
    }
    if (field.pattern) {
      try {
        if (!new RegExp(field.pattern).test(strVal)) {
          return { ok: false, error: `Nodo ${defId}: campo "${field.key}" non rispetta il formato richiesto (regex: ${field.pattern})` };
        }
      } catch { /* invalid regex from registry — skip */ }
    }
  }
  if (session.draft.nodes.some((n) => n.id === id)) return { ok: false, error: `Nodo "${id}" già aggiunto. Usa un id diverso.` };
  const cfgNorm: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    cfgNorm[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  const node: DraftNode = {
    id,
    defId,
    position: {
      x: typeof args.x === 'number' ? (args.x) : session.draft.nodes.length * 220 + 100,
      y: typeof args.y === 'number' ? (args.y) : 200,
    },
    config: cfgNorm,
  };
  if (typeof args.label === 'string' && args.label) node.name = args.label;
  session.draft.nodes.push(node);
  return { ok: true, data: { added: id } };
}

export function connectNodesHandler(session: ScaffoldSession, args: Record<string, unknown>): ToolResult {
  const planReject = requirePlan(session, 'connect_nodes');
  if (planReject) return planReject;
  const from = coerceString(args.from ?? '');
  const to = coerceString(args.to ?? '');
  if (!from || !to) return { ok: false, error: 'connect_nodes richiede "from" e "to"' };
  if (!session.draft.nodes.some((n) => n.id === from)) return { ok: false, error: `from="${from}" non è un nodo aggiunto. Aggiungilo PRIMA con add_node.` };
  if (!session.draft.nodes.some((n) => n.id === to)) return { ok: false, error: `to="${to}" non è un nodo aggiunto. Aggiungilo PRIMA con add_node.` };
  const edge: DraftEdge = { from, to };
  if (typeof args.fromPort === 'string') edge.fromPort = args.fromPort;
  session.draft.edges.push(edge);
  return { ok: true, data: { connected: `${from} → ${to}${edge.fromPort ? ` [${edge.fromPort}]` : ''}` } };
}

export function finalizeWorkflowHandler(session: ScaffoldSession, args: Record<string, unknown>): ToolResult {
  const planReject = requirePlan(session, 'finalize_workflow');
  if (planReject) return planReject;
  const id = coerceString(args.id ?? '');
  const name = coerceString(args.name ?? '');
  if (!id || !name) return { ok: false, error: 'finalize_workflow richiede "id" + "name"' };
  if (session.draft.nodes.length === 0) return { ok: false, error: 'Nessun nodo nel draft. Aggiungi nodi prima di finalizzare.' };

  // Plan-vs-actual completeness check: tutti i planned nodes devono essere stati aggiunti.
  if (session.plan?.accepted) {
    const draftIds = new Set(session.draft.nodes.map((n) => n.id));
    const missing = session.plan.nodes.filter((p) => !draftIds.has(p.id));
    if (missing.length > 0) {
      return {
        ok: false,
        error: `finalize_workflow: ${missing.length.toString()} nodi del plan NON sono stati aggiunti al draft: ${missing.map((m) => `"${m.id}" (${m.defId})`).join(', ')}. Fai add_node per ognuno di questi PRIMA di finalize_workflow.`,
      };
    }
  }

  // Complexity gate: blocca finalize prematuri quando il numero di nodi e\`
  // sotto la stima minima per il goal. Bug fix 2026-05-30: agente finalizzava
  // 2 nodi per goal Enterprise da 14+ nodi. Vedi complexity-gate.ts.
  const gate = shouldRejectFinalize(session.goal, session.draft.nodes.length);
  if (gate.reject) return { ok: false, error: gate.reason };

  // Orphan edge double-check.
  const nodeIds = new Set(session.draft.nodes.map((n) => n.id));
  for (const e of session.draft.edges) {
    if (!nodeIds.has(e.from)) return { ok: false, error: `Edge orfano: from="${e.from}" non esiste` };
    if (!nodeIds.has(e.to)) return { ok: false, error: `Edge orfano: to="${e.to}" non esiste` };
  }
  session.draft.id = id;
  session.draft.name = name;
  if (typeof args.description === 'string') session.draft.description = args.description;
  session.finalized = true;
  return { ok: true, data: { finalized: true, nodes: session.draft.nodes.length, edges: session.draft.edges.length } };
}

export function abortHandler(session: ScaffoldSession, args: Record<string, unknown>): ToolResult {
  const reason = coerceString(args.reason ?? 'unspecified');

  // Abort gate: rifiuta abort hallucinati o per "nodo non installato"
  // (REGOLA 12 del prompt). Vedi abort-gate.ts.
  const installedDefIds = buildNodeCatalog().map((c) => c.defId);
  const decision = evaluateAbort({ reason, installedDefIds });
  if (decision.reject) {
    // Non settiamo aborted=true: forziamo l'agente a continuare. Ritorniamo
    // ok:false con il messaggio prescrittivo che l'agente deve leggere.
    return { ok: false, error: decision.replyToAgent };
  }

  session.aborted = true;
  session.abortReason = reason;
  return { ok: true, data: { aborted: true, reason: session.abortReason } };
}

export function updateNodeHandler(session: ScaffoldSession, args: Record<string, unknown>): ToolResult {
  const id = coerceString(args.id ?? '');
  if (!id) return { ok: false, error: 'update_node richiede id.' };
  const node = session.draft.nodes.find((n) => n.id === id);
  if (!node) {
    // FIX 2026-05-31: Liara confondeva update_node con add_node. Hint esplicito.
    const existing = session.draft.nodes.map((n) => n.id).slice(0, 10).join(', ') || '(draft vuoto)';
    return {
      ok: false,
      error: `Nodo "${id}" non esiste nel draft. Hai forse dimenticato di add_node? Sequenza corretta: PRIMA add_node({id:"${id}",defId:"...",config:{...}}) POI eventualmente update_node per patch. Nodi attuali nel draft: ${existing}.`,
    };
  }
  const patch = (args.config as Record<string, unknown>) ?? {};
  const merged: Record<string, string> = { ...node.config };
  for (const [k, v] of Object.entries(patch)) {
    merged[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  // Re-validate against the node schema.
  const entry = buildNodeCatalog().find((c) => c.defId === node.defId);
  if (entry) {
    for (const field of entry.fields) {
      const value = merged[field.key];
      if (value === undefined || value === '') continue;
      if (field.options && !field.options.includes(value)) {
        return { ok: false, error: `update_node ${id}: ${field.key}="${value}" non in [${field.options.join('|')}]` };
      }
      if (field.pattern) {
        try { if (!new RegExp(field.pattern).test(value)) return { ok: false, error: `update_node ${id}: ${field.key} viola regex ${field.pattern}` }; } catch { /* ignore invalid regex */ }
      }
    }
  }
  node.config = merged;
  if (typeof args.x === 'number') node.position.x = args.x;
  if (typeof args.y === 'number') node.position.y = args.y;
  if (typeof args.label === 'string') node.name = args.label;
  return { ok: true, data: { updated: id, fieldsPatched: Object.keys(patch) } };
}

export function deleteNodeHandler(session: ScaffoldSession, args: Record<string, unknown>): ToolResult {
  const id = coerceString(args.id ?? '');
  if (!id) return { ok: false, error: 'delete_node richiede id.' };
  const before = session.draft.nodes.length;
  session.draft.nodes = session.draft.nodes.filter((n) => n.id !== id);
  if (session.draft.nodes.length === before) return { ok: false, error: `Nodo "${id}" non esisteva.` };
  const beforeEdges = session.draft.edges.length;
  session.draft.edges = session.draft.edges.filter((e) => e.from !== id && e.to !== id);
  return { ok: true, data: { deleted: id, edgesAlsoRemoved: beforeEdges - session.draft.edges.length } };
}

export function disconnectNodesHandler(session: ScaffoldSession, args: Record<string, unknown>): ToolResult {
  const from = coerceString(args.from ?? '');
  const to = coerceString(args.to ?? '');
  const fromPort = typeof args.fromPort === 'string' ? (args.fromPort) : undefined;
  if (!from || !to) return { ok: false, error: 'disconnect_nodes richiede from e to.' };
  const before = session.draft.edges.length;
  session.draft.edges = session.draft.edges.filter((e) => !(e.from === from && e.to === to && e.fromPort === fromPort));
  return { ok: true, data: { removed: before - session.draft.edges.length, from, to } };
}
