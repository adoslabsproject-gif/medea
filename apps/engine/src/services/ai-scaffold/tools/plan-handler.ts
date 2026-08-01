/**
 * propose_plan — Phase 0 obbligatoria del wizard 2-phase (2026-05-31).
 *
 * Workflow Plan-then-Execute:
 *   1. Liara legge il goal + catalog.
 *   2. PRIMA di add_node/connect_nodes/finalize_workflow → DEVE chiamare
 *      propose_plan({nodes:[{id,defId,purpose}...], edges:[...], reasoning})
 *   3. Server valida:
 *      - Reasoning >= 60 caratteri (forza il modello a pensare)
 *      - Nodi >= minNodes (complexity gate)
 *      - Ogni defId esiste nel catalogo
 *      - Ogni edge.from/to riferisce un node.id del plan
 *   4. Se valida → session.plan accepted. Liara può ora eseguire.
 *   5. Se invalida → reject con messaggio prescrittivo (il modello rilegge e
 *      ripropone — meglio sprecare 1 iter qui che 15 dopo a inseguire bug).
 *
 * Vantaggi vs free-form tool calling:
 *   - Forza il modello a DECOMPORRE il goal prima di iniziare a costruire
 *   - L'utente vede il plan e capisce cosa Liara intende fare ANCORA prima
 *     che inizi a generare nodi (UI checklist con ✓ / ⌛ per planned node)
 *   - Server può validare add_node vs plan (deviation tracking)
 *   - finalize_workflow check: tutti i planned nodes presenti?
 */

import { coerceString } from '@/lib/coerce.js';
import type { ScaffoldSession } from '@/services/ai-scaffold.service.js';
import type { ToolResult } from '@/services/ai-scaffold/types.js';
import { buildNodeCatalog } from '@/services/ai-scaffold/node-catalog.js';
import { estimateComplexity } from '@/services/ai-scaffold/tools/complexity-gate.js';

interface PlannedNode { id: string; defId: string; purpose: string }
interface PlannedEdge { from: string; to: string; fromPort?: string }

const MIN_REASONING_CHARS = 60;
const MIN_PURPOSE_CHARS = 10;

export function proposePlanHandler(session: ScaffoldSession, args: Record<string, unknown>): ToolResult {
  // ── 1. Validate basic shape ─────────────────────────────────────────
  const nodesRaw = args.nodes;
  const edgesRaw = args.edges;
  const reasoning = coerceString(args.reasoning ?? '').trim();

  if (!Array.isArray(nodesRaw) || nodesRaw.length === 0) {
    return { ok: false, error: 'propose_plan: campo "nodes" deve essere array non vuoto di {id,defId,purpose}.' };
  }
  if (!Array.isArray(edgesRaw)) {
    return { ok: false, error: 'propose_plan: campo "edges" deve essere array (anche vuoto) di {from,to,fromPort?}.' };
  }
  if (reasoning.length < MIN_REASONING_CHARS) {
    return {
      ok: false,
      error: `propose_plan: campo "reasoning" troppo corto (${reasoning.length.toString()} < ${MIN_REASONING_CHARS.toString()} chars). Spiega in italiano semplice come hai decomposto il goal, quali pattern di workflow stai applicando, e perché ogni nodo serve. Esempio: "Goal richiede ingest PDF + classificazione + branch per tipo + 3 destinazioni differenti. Uso trigger_imap per ingest, agent_classifier per il tipo, logic_switch per il branch, poi 3 rami con community_<vendor> per ogni destinazione."`,
    };
  }

  // ── 2. Validate each node ───────────────────────────────────────────
  const catalog = buildNodeCatalog();
  const catalogIds = new Set(catalog.map((c) => c.defId));
  const nodes: PlannedNode[] = [];
  const seenIds = new Set<string>();

  for (const [idx, n] of nodesRaw.entries()) {
    if (!n || typeof n !== 'object') {
      return { ok: false, error: `propose_plan: nodes[${idx.toString()}] non è un oggetto.` };
    }
    const obj = n as Record<string, unknown>;
    const id = coerceString(obj.id ?? '').trim();
    const defId = coerceString(obj.defId ?? '').trim();
    const purpose = coerceString(obj.purpose ?? '').trim();

    if (!id || !/^[a-z][a-z0-9_]*$/i.test(id)) {
      return { ok: false, error: `propose_plan: nodes[${idx.toString()}].id "${id}" non valido (richiesto snake_case alfanumerico, inizio con lettera).` };
    }
    if (seenIds.has(id)) {
      return { ok: false, error: `propose_plan: nodes[${idx.toString()}].id "${id}" duplicato. Ogni id deve essere univoco nel plan.` };
    }
    seenIds.add(id);
    if (!defId) {
      return { ok: false, error: `propose_plan: nodes[${idx.toString()}].defId mancante per id="${id}".` };
    }
    if (!catalogIds.has(defId)) {
      return { ok: false, error: `propose_plan: nodes[${idx.toString()}].defId "${defId}" non nel catalogo runtime. Chiama list_node_catalog() per vedere ${catalog.length.toString()} defId reali.` };
    }
    if (purpose.length < MIN_PURPOSE_CHARS) {
      return { ok: false, error: `propose_plan: nodes[${idx.toString()}].purpose troppo corto per id="${id}" (richiesto >= ${MIN_PURPOSE_CHARS.toString()} chars). Spiega COSA fa questo nodo dentro al flow, non solo ripetere il defId.` };
    }
    nodes.push({ id, defId, purpose });
  }

  // ── 3. Validate edges ───────────────────────────────────────────────
  const edges: PlannedEdge[] = [];
  for (const [idx, e] of edgesRaw.entries()) {
    if (!e || typeof e !== 'object') {
      return { ok: false, error: `propose_plan: edges[${idx.toString()}] non è un oggetto.` };
    }
    const obj = e as Record<string, unknown>;
    const from = coerceString(obj.from ?? '').trim();
    const to = coerceString(obj.to ?? '').trim();
    if (!seenIds.has(from)) {
      return { ok: false, error: `propose_plan: edges[${idx.toString()}].from="${from}" non riferisce un node.id del plan. Aggiungi prima il nodo "${from}" alla lista nodes.` };
    }
    if (!seenIds.has(to)) {
      return { ok: false, error: `propose_plan: edges[${idx.toString()}].to="${to}" non riferisce un node.id del plan.` };
    }
    const edge: PlannedEdge = { from, to };
    if (typeof obj.fromPort === 'string' && obj.fromPort.length > 0) {
      edge.fromPort = obj.fromPort;
    }
    edges.push(edge);
  }

  // ── 4. Complexity gate sul plan stesso ──────────────────────────────
  // Riusiamo lo stesso estimator del finalize gate. Plan deve coprire
  // almeno minNodes (altrimenti l'agente sta tentando di "vendere" un
  // plan corto sapendo che il finalize gate lo bloccherebbe comunque).
  const estimate = estimateComplexity(session.goal);
  if (nodes.length < estimate.minNodes) {
    // Enumera i token specifici matchati per dare a Liara una mappa esplicita
    // di cosa il goal contiene → cosa il plan deve coprire.
    const lines: string[] = [
      `propose_plan: plan troppo corto (${nodes.length.toString()} nodi proposti, minimo ${estimate.minNodes.toString()} per goal tier "${estimate.tier}").`,
      '',
      'ENTITÀ RILEVATE NEL TUO GOAL (devi rappresentarle TUTTE nel plan):',
    ];
    if (estimate.matched.actionVerbs.length > 0) {
      lines.push(`  - Verbi/azioni (${estimate.matched.actionVerbs.length.toString()}): ${estimate.matched.actionVerbs.join(', ')}`);
      lines.push(`    → 1 nodo per ognuno (agent_*/action_*/db_*/logic_*)`);
    }
    if (estimate.matched.integrations.length > 0) {
      lines.push(`  - Integrazioni esterne (${estimate.matched.integrations.length.toString()}): ${estimate.matched.integrations.join(', ')}`);
      lines.push(`    → 1 nodo community_<vendor> o action_http per ognuna`);
    }
    if (estimate.matched.branches.length > 0) {
      lines.push(`  - Segnali di branching (${estimate.matched.branches.length.toString()}): ${estimate.matched.branches.join(', ')}`);
      lines.push(`    → 1 logic_if o logic_switch per ogni decisione + 1 nodo per ogni ramo`);
    }
    if (estimate.matched.documentTypes.length > 0) {
      lines.push(`  - Tipi documento elencati (${estimate.matched.documentTypes.length.toString()}): ${estimate.matched.documentTypes.join(', ')}`);
      lines.push(`    → ognuno tipicamente diventa un ramo dello switch (1 nodo + relativi action)`);
    }
    lines.push('');
    lines.push(`AZIONE: ricomponi il plan partendo dalla lista sopra. NON tagliare entità per stare sotto i limiti — il workflow incompleto NON soddisfa il goal utente. Esempio: se il goal dice "branching per tipo: contratto → X, fattura → Y, preventivo → Z", servono ALMENO logic_switch + 3 rami + 3 action di destinazione = 7+ nodi solo per quella sezione.`);
    lines.push(`Ricomponi e richiama propose_plan con almeno ${estimate.minNodes.toString()} nodi.`);
    return { ok: false, error: lines.join('\n') };
  }

  // ── 5. Validate: at least 1 root (no incoming edge) — typically the trigger ──
  const hasIncoming = new Set(edges.map((e) => e.to));
  const roots = nodes.filter((n) => !hasIncoming.has(n.id));
  if (roots.length === 0) {
    return {
      ok: false,
      error: 'propose_plan: nessun nodo "root" (senza edge entrante). Tipicamente il primo nodo è un trigger (trigger_imap, trigger_webhook, trigger_cron, ecc.) che non ha input. Almeno UN nodo del plan deve essere root.',
    };
  }

  // ── 6. Accept the plan ──────────────────────────────────────────────
  session.plan = {
    accepted: true,
    proposedAt: Date.now(),
    reasoning,
    nodes,
    edges,
  };

  // ── 7. Compact schema dump per OGNI defId nel plan ───────────────────
  // FIX 2026-05-31 user-segnalato (workflow incomplete): pre-fix Liara
  // doveva fare add_node → fail REQUIRED missing → list_node_catalog(defId)
  // → retry add_node. 3 iter per nodo × 23 nodi = 69 iter solo per
  // schema discovery. Soluzione enterprise: il server gli dà lo schema
  // di TUTTI i defId del plan in un colpo solo, embedded nel tool_result
  // accepted. Liara fa add_node corretto al PRIMO tentativo → 1 iter/nodo.
  const distinctDefIds = [...new Set(nodes.map((n) => n.defId))];
  const fieldsByDefId: Record<string, { required: string[]; allFields: { key: string; type: string; required: boolean; options?: string[]; defaultValue?: string }[] }> = {};
  for (const defId of distinctDefIds) {
    const entry = catalog.find((c) => c.defId === defId);
    if (!entry) continue;
    fieldsByDefId[defId] = {
      required: entry.fields.filter((f) => f.required).map((f) => f.key),
      allFields: entry.fields.map((f) => {
        const out: { key: string; type: string; required: boolean; options?: string[]; defaultValue?: string } = {
          key: f.key,
          type: f.type,
          required: !!f.required,
        };
        if (f.options && f.options.length > 0) out.options = f.options;
        if (f.defaultValue) out.defaultValue = f.defaultValue;
        return out;
      }),
    };
  }

  return {
    ok: true,
    data: {
      accepted: true,
      nodes: nodes.length,
      edges: edges.length,
      roots: roots.length,
      tier: estimate.tier,
      message:
        `Plan accettato. Procedi FASE 1: add_node per ognuno dei ${nodes.length.toString()} nodi nell'ordine root→foglie, POI connect_nodes per i ${edges.length.toString()} edges, POI finalize_workflow.\n\n` +
        `IMPORTANTE: lo schema completo dei ${distinctDefIds.length.toString()} defId del plan è in "schemas" sotto. Usalo direttamente per costruire i config — NON serve chiamare list_node_catalog. Includi SEMPRE tutti i field "required:true".`,
      schemas: fieldsByDefId,
    },
  };
}

/** Helper riusato dai mutation handlers: respinge azioni se il plan non è accettato. */
export function requirePlan(session: ScaffoldSession, toolName: string): ToolResult | null {
  if (session.plan?.accepted) return null;
  return {
    ok: false,
    error: `${toolName}: PHASE 0 obbligatoria — chiama PRIMA propose_plan({nodes:[{id,defId,purpose}...], edges:[...], reasoning:"..."}) per dichiarare la struttura del workflow. Il server validerà il plan vs il goal, e solo dopo potrai eseguire ${toolName}. Vedi REGOLA 0 nel SYSTEM_PROMPT.`,
  };
}
