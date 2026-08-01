/**
 * tools — gli strumenti dell'agente costruttore/modificatore di workflow (#3).
 *
 * Il modello opera sul workflow INCREMENTALMENTE: cerca il nodo giusto
 * (search_nodes), ne legge lo schema (get_node_schema), lo aggiunge (add_node),
 * collega (connect), configura (set_config), e — in MODIFICA di un workflow
 * esistente — rimuove nodi (delete_node) e collegamenti (disconnect); poi verifica
 * (validate_workflow) e chiude (finish). Risolve insieme l'hallucination (i tool
 * validano contro il catalog) e la scelta-nodo (search invece di indovinare tra ~200).
 *
 * Ogni tool: `schema` Zod (autorità runtime) + `parameters` JSON-Schema (esposto
 * all'LLM, scritto a mano per determinismo). Mirror dell'architettura db-agent.
 *
 * @module services/workflow-agent/tools
 */
import { z, type ZodType } from 'zod';
import type { NodeCatalogEntry } from '@/services/ai-scaffold/node-catalog.js';
import { describeViolation } from '@/services/ai-scaffold/catalog-validator.js';
import type { WorkflowBuilder, WorkflowSnapshot } from '@/services/workflow-agent/state.js';
import { searchNodes } from '@/services/workflow-agent/node-search.js';

export interface WorkflowAgentContext {
  builder: WorkflowBuilder;
  catalog: NodeCatalogEntry[];
}

export interface WorkflowToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  schema: ZodType<unknown>;
  handler: (ctx: WorkflowAgentContext, args: unknown) => unknown;
}

export type WorkflowToolResult = { ok: true; data: unknown } | { ok: false; error: string };

const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> =>
  ({ type: 'object', properties, required, additionalProperties: false });

const TOOLS: WorkflowToolDef[] = [
  {
    name: 'search_nodes',
    description: 'Cerca nel catalogo i nodi pertinenti a una descrizione (es. "invia email", "http get", "salva in database"). Usalo PRIMA di add_node per scegliere il defId giusto.',
    parameters: obj({ query: { type: 'string', description: 'Cosa deve fare il nodo' } }, ['query']),
    schema: z.object({ query: z.string().min(1) }),
    handler: (ctx, args) => {
      const { query } = args as { query: string };
      return { hits: searchNodes(ctx.catalog, query) };
    },
  },
  {
    name: 'get_node_schema',
    description: 'Restituisce i campi di configurazione di un nodo (chiavi, tipo, obbligatorietà, valori enum) e le sue azioni. Usalo prima di configurare un nodo.',
    parameters: obj({ defId: { type: 'string' } }, ['defId']),
    schema: z.object({ defId: z.string().min(1) }),
    handler: (ctx, args) => {
      const { defId } = args as { defId: string };
      const entry = ctx.catalog.find((c) => c.defId === defId);
      if (!entry) return { error: `defId "${defId}" non trovato. Usa search_nodes.` };
      return {
        defId: entry.defId,
        label: entry.label,
        fields: entry.fields.map((f) => ({ key: f.key, type: f.type, required: f.required, ...(f.options ? { options: f.options } : {}) })),
        ...(entry.actions ? { actions: entry.actions.map((a) => ({ id: a.id, label: a.label })) } : {}),
      };
    },
  },
  {
    name: 'add_node',
    description: 'Aggiunge un nodo al workflow. Il defId DEVE esistere nel catalogo (usa search_nodes). Ritorna l\'id assegnato e gli eventuali campi obbligatori ancora da configurare.',
    parameters: obj({
      defId: { type: 'string' },
      id: { type: 'string', description: 'Opzionale: id leggibile. Se omesso è auto-generato.' },
      config: { type: 'object', description: 'Config iniziale (opzionale).' },
    }, ['defId']),
    schema: z.object({ defId: z.string().min(1), id: z.string().optional(), config: z.record(z.string(), z.unknown()).optional() }),
    handler: (ctx, args) => {
      const a = args as { defId: string; id?: string; config?: Record<string, unknown> };
      return ctx.builder.addNode(a.defId, a.id, a.config ?? {});
    },
  },
  {
    name: 'connect',
    description: 'Collega due nodi già aggiunti (from → to). Per i nodi a rami (if/switch) specifica fromPort.',
    parameters: obj({ from: { type: 'string' }, to: { type: 'string' }, fromPort: { type: 'string' } }, ['from', 'to']),
    schema: z.object({ from: z.string().min(1), to: z.string().min(1), fromPort: z.string().optional() }),
    handler: (ctx, args) => {
      const a = args as { from: string; to: string; fromPort?: string };
      return ctx.builder.connect(a.from, a.to, a.fromPort);
    },
  },
  {
    name: 'set_config',
    description: 'Imposta o aggiorna la config di un nodo esistente. merge:true fonde coi valori esistenti, merge:false rimpiazza.',
    parameters: obj({ nodeId: { type: 'string' }, config: { type: 'object' }, merge: { type: 'boolean' } }, ['nodeId', 'config']),
    schema: z.object({ nodeId: z.string().min(1), config: z.record(z.string(), z.unknown()), merge: z.boolean().optional() }),
    handler: (ctx, args) => {
      const a = args as { nodeId: string; config: Record<string, unknown>; merge?: boolean };
      return ctx.builder.setConfig(a.nodeId, a.config, a.merge ?? true);
    },
  },
  {
    name: 'delete_node',
    description: 'Rimuove un nodo dal workflow E tutti i suoi collegamenti (in entrata e uscita). Usalo per MODIFICARE un workflow esistente quando un nodo non serve più.',
    parameters: obj({ nodeId: { type: 'string' } }, ['nodeId']),
    schema: z.object({ nodeId: z.string().min(1) }),
    handler: (ctx, args) => {
      const { nodeId } = args as { nodeId: string };
      return ctx.builder.deleteNode(nodeId);
    },
  },
  {
    name: 'disconnect',
    description: 'Rimuove un collegamento esistente tra due nodi (from → to), lasciando i nodi al loro posto. Per i rami (if/switch) specifica fromPort.',
    parameters: obj({ from: { type: 'string' }, to: { type: 'string' }, fromPort: { type: 'string' } }, ['from', 'to']),
    schema: z.object({ from: z.string().min(1), to: z.string().min(1), fromPort: z.string().optional() }),
    handler: (ctx, args) => {
      const a = args as { from: string; to: string; fromPort?: string };
      return ctx.builder.disconnect(a.from, a.to, a.fromPort);
    },
  },
  {
    name: 'validate_workflow',
    description: 'Verifica il workflow corrente: campi obbligatori mancanti, enum invalidi, edge orfani. Usalo prima di finish.',
    parameters: obj({}),
    schema: z.object({}),
    handler: (ctx) => {
      const violations = ctx.builder.validate().map(describeViolation);
      const orphans = ctx.builder.orphanEdges();
      return {
        valid: violations.length === 0 && orphans.length === 0,
        issues: violations,
        ...(orphans.length > 0 ? { orphanEdges: orphans } : {}),
      };
    },
  },
  {
    name: 'finish',
    description: 'Termina la costruzione e restituisce il workflow finale. Chiamalo quando il workflow è completo e validato.',
    parameters: obj({}),
    schema: z.object({}),
    handler: (ctx): { snapshot: WorkflowSnapshot; remainingIssues: string[] } => ({
      snapshot: ctx.builder.snapshot(),
      remainingIssues: ctx.builder.validate().map(describeViolation),
    }),
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Definizioni esposte all'LLM (name/description/parameters). */
export function listWorkflowTools(): { name: string; description: string; parameters: Record<string, unknown> }[] {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

export function isFinishTool(name: string): boolean { return name === 'finish'; }

/** Esegue un tool: valida gli args (Zod), invoca l'handler, mai lancia. */
export function executeWorkflowTool(ctx: WorkflowAgentContext, name: string, args: unknown): WorkflowToolResult {
  const tool = BY_NAME.get(name);
  if (!tool) return { ok: false, error: `Tool sconosciuto: "${name}". Disponibili: ${[...BY_NAME.keys()].join(', ')}.` };
  const parsed = tool.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, error: `Argomenti non validi per ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
  }
  try {
    return { ok: true, data: tool.handler(ctx, parsed.data) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
