/**
 * semantic-repair — loop VALIDATORE → RIPARAZIONE (#8 strato B).
 *
 * Orchestrazione (deterministico-first, LLM-last):
 *   1. auto-config deterministica (default + enum-case) — il codice prima di tutto.
 *   2. valida contro il catalog (catalog-validator).
 *   3. se restano violazioni RIPARABILI e c'è una RepairFn → chiamata LLM MIRATA
 *      che corregge SOLO i nodi rotti (con i messaggi precisi del validatore),
 *      poi ri-applica il deterministico e ri-valida. Bounded (maxRounds).
 *
 * La RepairFn è INIETTATA → l'orchestrazione è testabile in-process senza un
 * modello reale (niente greensmoke): si stubba la riparazione e si verifica
 * che il loop converga / si fermi / non muti l'input.
 *
 * @module services/ai-scaffold/semantic-repair
 */
import { buildCatalogSpec, type NodeConfigSpec } from '@/services/ai-scaffold/catalog-spec.js';
import {
  applyDeterministicAutoConfig, type AutoConfigFix, type AutoConfigNode,
} from '@/services/ai-scaffold/semantic-autoconfig.js';
import {
  validateNodesAgainstCatalog, type CatalogViolation,
} from '@/services/ai-scaffold/catalog-validator.js';
import type { NodeCatalogEntry } from '@/services/ai-scaffold/node-catalog.js';

/** Config corretta proposta dalla riparazione per un nodo (per id). */
export interface RepairedNode { id: string; config: Record<string, unknown> }

/** Funzione di riparazione iniettata. In prod = chiamata LLM mirata (vedi
 *  make-llm-repair.ts). Riceve i nodi correnti + le violazioni, ritorna le
 *  config corrette per (alcuni) nodi. Non deve lanciare per fallimenti soft:
 *  ritorni [] e il loop si ferma con le violazioni residue. */
export type RepairFn = (input: {
  nodes: AutoConfigNode[];
  violations: CatalogViolation[];
}) => Promise<RepairedNode[]>;

export interface SemanticRepairOptions {
  catalog: NodeCatalogEntry[];
  /** Assente → solo deterministico (nessuna chiamata LLM). */
  repair?: RepairFn;
  /** Round massimi di riparazione LLM. Default 1. */
  maxRounds?: number;
}

export interface SemanticRepairResult<N extends AutoConfigNode> {
  nodes: N[];
  /** Fix deterministiche applicate (tutti i round). */
  applied: AutoConfigFix[];
  /** Violazioni ancora irrisolte dopo il loop (vuoto = tutto valido). */
  remaining: CatalogViolation[];
  /** Round di riparazione LLM effettivamente usati. */
  rounds: number;
}

/** Violazioni che ha senso passare all'LLM (config di contenuto). Le strutturali
 *  "unknown_def" sono gestite a monte (autoFixInventedDefIds) e raramente
 *  riparabili a colpo sicuro → non innescano da sole un round LLM. */
function isRepairable(v: CatalogViolation): boolean {
  return v.kind === 'missing_required' || v.kind === 'invalid_enum'
    || v.kind === 'unknown_config_key' || v.kind === 'invalid_action';
}

/** Applica le config riparate ai nodi (per id), clonando (no mutazione input). */
function mergeRepaired<N extends AutoConfigNode>(nodes: N[], repaired: RepairedNode[]): N[] {
  if (repaired.length === 0) return nodes;
  const byId = new Map(repaired.map((r) => [r.id, r.config]));
  return nodes.map((n) => {
    const cfg = byId.get(n.id);
    return cfg ? { ...n, config: { ...(n.config ?? {}), ...cfg } } : n;
  });
}

/**
 * Esegue il loop deterministico→repair. Pure rispetto all'input (ritorna nuovi
 * nodi). L'unico effetto esterno è la RepairFn iniettata.
 */
export async function runSemanticRepair<N extends AutoConfigNode>(
  inputNodes: N[],
  opts: SemanticRepairOptions,
): Promise<SemanticRepairResult<N>> {
  const spec: Map<string, NodeConfigSpec> = buildCatalogSpec(opts.catalog);
  const maxRounds = opts.maxRounds ?? 1;
  const applied: AutoConfigFix[] = [];

  // Round 0: deterministico + validazione.
  let det = applyDeterministicAutoConfig(inputNodes, spec);
  let nodes = det.nodes;
  applied.push(...det.applied);
  let remaining = validateNodesAgainstCatalog(nodes, spec);
  let rounds = 0;

  while (
    remaining.length > 0 && opts.repair && rounds < maxRounds &&
    remaining.some(isRepairable)
  ) {
    const repaired = await opts.repair({ nodes, violations: remaining });
    rounds++;
    if (repaired.length === 0) break; // riparazione a vuoto → stop
    nodes = mergeRepaired(nodes, repaired);
    // Ri-applica il deterministico (un repair può lasciare enum mal-cased o
    // lasciare scoperti default) e ri-valida.
    det = applyDeterministicAutoConfig(nodes, spec);
    nodes = det.nodes;
    applied.push(...det.applied);
    remaining = validateNodesAgainstCatalog(nodes, spec);
  }

  return { nodes, applied, remaining, rounds };
}
