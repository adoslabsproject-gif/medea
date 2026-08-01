/**
 * Missing-Node Wizard Orchestrator — AI Scaffold Step 4 (Cappella Sistina).
 *
 * Quando Liara genera un workflow contenente defId che NON esistono nel
 * catalog (es. "action_amazon_search" mentre stdlib ha solo "action_http"),
 * il sistema attuale fa:
 *   1. autoFixInventedDefIds(): strip suffix e prova base catalog
 *      → SOLO se base catalog matchabile. Se nessuna base match, fallback NO.
 *   2. quality-gate: rigetta workflow.
 *
 * Questo orchestrator chiude il loop: per ogni defId residuo NON risolvibile,
 * genera UN nuovo custom-node tenant-private "appena in tempo":
 *
 *   1. detectMissingDefIds(workflow, knownDefIds, knownCustomDefIds)
 *      → MissingDefId[] (no side effect, pure).
 *
 *   2. planSynthesis(missing, contextNodes, userPrompt, opts)
 *      → SynthesisPlan: per ogni missing prepara un prompt LLM strutturato
 *        + slug candidato + custom defId target.
 *      Pure (no LLM call yet).
 *
 *   3. executeSynthesisPlan(plan, deps): Promise<SynthesisResult>
 *      → invoca le deps iniettate (generateNodeBlueprint LLM call +
 *        compileBlueprint + persistAndPublish). Ritorna mapping
 *        oldDefId → newDefId.
 *      Side-effectful, deps-injected per testability.
 *
 *   4. applyDefIdMapping(workflow, mapping)
 *      → riscrive defId nei nodi + invariato edges/config.
 *      Pure.
 *
 * Design:
 *   - 100% deps-injected. La logica pure è separata dalle chiamate LLM/DB/compile.
 *   - Idempotent: se uno slug è gia\` registrato, lo riusa (non duplica).
 *   - Cost-safe: NON auto-wired nel singleshot scaffold pipeline. Invocato
 *     esplicitamente dall'editor UI quando l'utente conferma "genera nodi
 *     mancanti" (1 click). Plan-gating delegato al service custom-nodes.
 *   - Fail-soft: se LLM/compile fallisce per UN missing, altri proseguono.
 */

import { findBaseDefId } from './auto-fix-defid.js';

export interface WorkflowNode {
  id: string;
  defId: string;
  config: Record<string, unknown>;
  [k: string]: unknown;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  [k: string]: unknown;
}

export interface Workflow {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  [k: string]: unknown;
}

export interface MissingDefId {
  defId: string;
  /** Quanti nodi del workflow usano questo defId (alta = priorità sintesi). */
  usageCount: number;
  /** I node id che usano questo defId (per context-aware prompting). */
  nodeIds: string[];
  /**
   * I config raccolti dai nodi che usano questo defId: utile a Liara per
   * inferire input/output schema (es. tutti hanno `query` + `apiKey` → input
   * { query: string, apiKey: string }).
   */
  observedConfigs: readonly Record<string, unknown>[];
}

export interface PlanItem {
  missing: MissingDefId;
  /** Slug kebab-case derivato dal defId (es. "action_amazon_search" → "amazon-search"). */
  proposedSlug: string;
  /** Nuovo defId target nel workflow (es. "custom_amazon-search"). */
  targetDefId: string;
  /** Display name umano (es. "Amazon Search"). */
  proposedDisplayName: string;
  /**
   * Prompt strutturato per LLM (Liara AI assist `generate`). Contiene la
   * signature di nodo, gli observed configs, hint del purpose.
   */
  llmPrompt: string;
}

export interface SynthesisPlan {
  items: PlanItem[];
  /**
   * defId che NON si possono sintetizzare automaticamente (es. trigger
   * specifici che richiedono setup esterno). Sono ritornati senza item.
   */
  skipped: { defId: string; reason: string }[];
}

export interface PlannerOptions {
  /**
   * Prompt utente originale (necessario al planner per contestualizzare il
   * "purpose" di ogni missing defId — un nodo "action_amazon_search" significa
   * cose diverse a seconda che il workflow sia per CRM o per dropshipping).
   */
  userPrompt: string;
  /** Workflow nodes per contesto (vicini, edge target/source). */
  contextNodes: readonly WorkflowNode[];
  /** Edges per inferenza upstream/downstream. */
  contextEdges: readonly WorkflowEdge[];
}

export interface SynthesizedBlueprint {
  /** Codice executor TypeScript. Verra\` compilato da esbuild. */
  sourceExecutor: string;
  /** JSON.stringify(NodeDef) — definition per UI. */
  sourceDefinition: string;
  /** JSON.stringify(InputSchema Zod-like JSON Schema). */
  sourceSchema: string;
}

export interface PersistAndPublishInput {
  workspaceId: string;
  ownerUserId: string;
  slug: string;
  displayName: string;
  description: string;
  blueprint: SynthesizedBlueprint;
}

export interface PersistAndPublishOutput {
  /** defId finale registrato (es. "custom_amazon-search"). */
  defId: string;
  /** ID custom_node row creato. */
  customNodeId: string;
  semver: string;
}

export interface OrchestratorDeps {
  /**
   * Genera un blueprint custom-node via LLM. Tipicamente wraps
   * `callAiAssist({ action: 'generate', ... })`.
   * Throw → trattato come fail-soft per QUESTO item, altri proseguono.
   */
  generateNodeBlueprint(item: PlanItem): Promise<SynthesizedBlueprint>;

  /**
   * Persiste e pubblica privatamente. Tipicamente wraps:
   *   - createCustomNode()
   *   - publishCustomNodePrivate()
   * Throw → fail-soft per QUESTO item.
   */
  persistAndPublish(input: PersistAndPublishInput): Promise<PersistAndPublishOutput>;

  /**
   * Verifica se uno slug e\` gia\` registrato per il tenant (idempotenza).
   * Se ritorna defId, l'orchestrator riusa il nodo esistente senza ricreare.
   */
  findExistingCustomDefId(workspaceId: string, slug: string): Promise<string | null>;
}

export interface SynthesisResult {
  /** Mapping oldDefId → newDefId per applyDefIdMapping. */
  mapping: ReadonlyMap<string, string>;
  /** Item che hanno avuto successo. */
  succeeded: {
    oldDefId: string;
    newDefId: string;
    customNodeId: string;
    reused: boolean;
  }[];
  /** Item falliti (LLM error, compile error, persist error). */
  failed: { oldDefId: string; reason: string }[];
}

/**
 * Detecta tutti i defId presenti nei nodes ma assenti dall'unione di:
 *   - knownDefIds (stdlib catalog)
 *   - knownCustomDefIds (custom_nodes del tenant)
 * Esclude defId community_* (vendor-owned), trigger_* (richiede setup esterno).
 */
export function detectMissingDefIds(
  workflow: Workflow,
  knownDefIds: ReadonlySet<string>,
  knownCustomDefIds: ReadonlySet<string>,
): MissingDefId[] {
  const counts = new Map<string, { nodeIds: string[]; configs: Record<string, unknown>[] }>();

  for (const node of workflow.nodes) {
    if (knownDefIds.has(node.defId)) continue;
    if (knownCustomDefIds.has(node.defId)) continue;
    // Skip community vendor — non il nostro lavoro sintetizzarlo.
    if (node.defId.startsWith('community_')) continue;
    // Skip trigger — richiede webhook/cron setup esterno, no sense in auto-gen.
    if (node.defId.startsWith('trigger_')) continue;
    // Skip if findBaseDefId riesce comunque (auto-fix-defid lo gestisce dopo).
    // Cast a Set: findBaseDefId fa solo lookup `.has()` — Readonly-safe.
    if (findBaseDefId(node.defId, knownDefIds as Set<string>) !== null) continue;

    const entry = counts.get(node.defId) ?? { nodeIds: [], configs: [] };
    entry.nodeIds.push(node.id);
    entry.configs.push({ ...node.config });
    counts.set(node.defId, entry);
  }

  const result: MissingDefId[] = [];
  for (const [defId, entry] of counts.entries()) {
    result.push({
      defId,
      usageCount: entry.nodeIds.length,
      nodeIds: entry.nodeIds,
      observedConfigs: entry.configs,
    });
  }
  // Sort desc per usageCount, asc per defId per stabilita\`.
  result.sort((a, b) => b.usageCount - a.usageCount || a.defId.localeCompare(b.defId));
  return result;
}

const SLUG_INVALID_RE = /[^a-z0-9_-]+/gu;

/**
 * Deriva slug kebab-case dal defId. Idempotente.
 * Es. "action_amazon_search" → "amazon-search"
 *     "agent_email_triage_legal" → "email-triage-legal"
 *     "db_custom_query" → "db-custom-query"
 */
export function deriveSlugFromDefId(defId: string): string {
  const lower = defId.toLowerCase();
  // Strip prefisso categoria nota se presente.
  const STRIPPABLE = ['action_', 'agent_', 'db_', 'flow_', 'logic_', 'integration_', 'integrations_'];
  let core = lower;
  for (const prefix of STRIPPABLE) {
    if (core.startsWith(prefix)) {
      core = core.slice(prefix.length);
      break;
    }
  }
  return core.replace(/_/gu, '-').replace(SLUG_INVALID_RE, '').replace(/-+/gu, '-').replace(/^-|-$/gu, '');
}

/**
 * Deriva display name umano dal defId.
 * Es. "action_amazon_search" → "Amazon Search"
 */
export function deriveDisplayName(defId: string): string {
  const slug = deriveSlugFromDefId(defId);
  return slug
    .split('-')
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

/**
 * Costruisce un planning di sintesi per ciascun missing defId.
 * Pure — no LLM call, no DB call. Output deterministico per (input, opts).
 */
export function planSynthesis(missing: readonly MissingDefId[], opts: PlannerOptions): SynthesisPlan {
  const items: PlanItem[] = [];
  const skipped: SynthesisPlan['skipped'] = [];

  for (const m of missing) {
    const slug = deriveSlugFromDefId(m.defId);
    if (slug.length < 2) {
      skipped.push({
        defId: m.defId,
        reason: `slug derivato "${slug}" troppo corto (defId ambiguo, richiede intervento umano)`,
      });
      continue;
    }

    const displayName = deriveDisplayName(m.defId);
    const targetDefId = `custom_${slug}`;

    // Inferenza schema-hint dai observed configs.
    const allKeys = new Set<string>();
    for (const cfg of m.observedConfigs) {
      for (const k of Object.keys(cfg)) allKeys.add(k);
    }
    const fields = [...allKeys].sort();

    // Context upstream/downstream per ogni nodeId.
    const contextChips: string[] = [];
    for (const nodeId of m.nodeIds) {
      const upstream = opts.contextEdges
        .filter((e) => e.to === nodeId)
        .map((e) => opts.contextNodes.find((n) => n.id === e.from)?.defId)
        .filter((s): s is string => !!s);
      const downstream = opts.contextEdges
        .filter((e) => e.from === nodeId)
        .map((e) => opts.contextNodes.find((n) => n.id === e.to)?.defId)
        .filter((s): s is string => !!s);
      if (upstream.length > 0 || downstream.length > 0) {
        contextChips.push(
          `Nodo "${nodeId}": upstream=[${upstream.join(', ')}] downstream=[${downstream.join(', ')}]`,
        );
      }
    }

    const llmPrompt = [
      `Genera un custom node FlowForge per il defId "${m.defId}".`,
      ``,
      `## Contesto utente`,
      `Il workflow originale e\` stato scaffoldato dal prompt:`,
      `"${opts.userPrompt}"`,
      ``,
      `## Schema observed (${m.usageCount.toString()} occorrenze nel workflow)`,
      `Campi presenti nei config: ${fields.length > 0 ? fields.join(', ') : '(nessuno)'}`,
      `Esempio config: ${JSON.stringify(m.observedConfigs[0] ?? {}, null, 2)}`,
      ``,
      `## Contesto grafo`,
      contextChips.length > 0 ? contextChips.join('\n') : '(nessun edge contestuale)',
      ``,
      `## Output richiesto`,
      `1) sourceExecutor: codice TypeScript ESM con export const executor = async (config, input, context) => ({ output, durationMs }).`,
      `2) sourceDefinition: JSON.stringify(NodeDef) con id="${targetDefId}", label="${displayName}", category appropriato.`,
      `3) sourceSchema: JSON Schema dei campi config inferiti.`,
      ``,
      `Vincoli:`,
      `- NO eval/new Function/process/child_process/fs.`,
      `- Sandbox-safe: usa fetch host-bridge per HTTP.`,
      `- Idempotency-Key support se la action e\` write-side (POST/PUT).`,
      `- timeoutMs default 30000 se HTTP.`,
      `- Errori: throw NodeError sottoclasse (ValidationError/HttpError/AuthError/TimeoutError) appropriato.`,
    ].join('\n');

    items.push({
      missing: m,
      proposedSlug: slug,
      targetDefId,
      proposedDisplayName: displayName,
      llmPrompt,
    });
  }

  return { items, skipped };
}

/**
 * Esegue il plan invocando le deps iniettate. Fail-soft per item: un fail
 * su 1 missing NON ferma gli altri.
 */
export async function executeSynthesisPlan(
  plan: SynthesisPlan,
  deps: OrchestratorDeps,
  ctx: { workspaceId: string; ownerUserId: string },
): Promise<SynthesisResult> {
  const mapping = new Map<string, string>();
  const succeeded: SynthesisResult['succeeded'] = [];
  const failed: SynthesisResult['failed'] = [];

  for (const item of plan.items) {
    try {
      // Idempotenza: se lo slug e\` gia\` registrato, riusa.
      const existing = await deps.findExistingCustomDefId(ctx.workspaceId, item.proposedSlug);
      if (existing) {
        mapping.set(item.missing.defId, existing);
        succeeded.push({
          oldDefId: item.missing.defId,
          newDefId: existing,
          customNodeId: '',
          reused: true,
        });
        continue;
      }

      const blueprint = await deps.generateNodeBlueprint(item);
      const persisted = await deps.persistAndPublish({
        workspaceId: ctx.workspaceId,
        ownerUserId: ctx.ownerUserId,
        slug: item.proposedSlug,
        displayName: item.proposedDisplayName,
        description: `Nodo sintetizzato dall'AI scaffold per "${item.missing.defId}" — ${item.missing.usageCount.toString()} occorrenze nel workflow di origine.`,
        blueprint,
      });
      mapping.set(item.missing.defId, persisted.defId);
      succeeded.push({
        oldDefId: item.missing.defId,
        newDefId: persisted.defId,
        customNodeId: persisted.customNodeId,
        reused: false,
      });
    } catch (err) {
      failed.push({
        oldDefId: item.missing.defId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { mapping, succeeded, failed };
}

/**
 * Applica un mapping defId-old → defId-new ai nodi del workflow. Edges
 * invariati (referenziano node.id, non defId). Config invariati.
 * Pure, idempotent. Defensive copy del workflow.
 */
export function applyDefIdMapping(workflow: Workflow, mapping: ReadonlyMap<string, string>): Workflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((n) => {
      const next = mapping.get(n.defId);
      if (!next) return { ...n, config: { ...n.config } };
      return { ...n, defId: next, config: { ...n.config } };
    }),
    edges: workflow.edges.map((e) => ({ ...e })),
  };
}
