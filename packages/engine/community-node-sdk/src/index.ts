/**
 * @medea/engine-community-node-sdk
 *
 * Type-safe builder for FlowForge community-node packages (.ffnode).
 *
 * Pattern:
 *
 *   import { defineCommunityNode, action } from '@medea/engine-community-node-sdk';
 *
 *   export default defineCommunityNode({
 *     manifest: {
 *       id: 'my_node', vendor: 'my-co', version: '1.0.0',
 *       displayName: 'My Node', description: '...', license: 'MIT',
 *     },
 *     def: {
 *       type: 'action', icon: 'cube', color: '#3b82f6',
 *       configFields: [
 *         { key: 'apiKey', label: 'API Key', type: 'secret', required: true },
 *       ],
 *     },
 *     actions: [
 *       action({
 *         id: 'do_thing', label: 'Do Thing',
 *         configFields: [{ key: 'arg', label: 'Argument', type: 'text' }],
 *         async execute(config, input, context) {
 *           return { result: 'done' };
 *         },
 *       }),
 *     ],
 *   });
 *
 * The TypeScript types of `configFields` flow through to the `execute`
 * function so vendors catch typos at build time. The CLI (`ffnode-build`)
 * resolves the default export, generates manifest+nodedef+executor,
 * signs with Ed25519, and zips into a .ffnode.
 */

import { z } from 'zod';

// ───── Public types ─────

export type ConfigFieldType =
  | 'text' | 'textarea' | 'select' | 'number' | 'boolean'
  | 'secret' | 'json' | 'code' | 'expression';

export interface ConfigField {
  key: string;
  label: string;
  type?: ConfigFieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
  defaultValue?: string;
  options?: readonly string[];
  showIf?: {
    field: string;
    equals?: string | number | boolean;
    in?: readonly (string | number | boolean)[];
    truthy?: boolean;
  };
}

export interface ExecutionContext {
  tenantId: string;
  runId: string;
  workflowId: string;
  nodeId: string;
  action?: string;
}

export type ActionExecutor = (
  config: Record<string, unknown>,
  input: unknown,
  context: ExecutionContext,
) => Promise<unknown>;

export interface Action {
  id: string;
  label: string;
  description?: string;
  category?: string;
  aiAction?: boolean;
  configFields?: readonly ConfigField[];
  execute: ActionExecutor;
}

/** Contesto di un trigger custom + stato persistito tra le invocazioni. */
export interface TriggerContext {
  tenantId: string;
  workflowId: string;
  nodeId: string;
  /** Stato persistente tra i poll (es. { lastId }). Mutalo per ricordare. */
  state: Record<string, unknown>;
}

/** Chiamata dal trigger per AVVIARE un run del workflow con il payload dato. */
export type TriggerEmit = (payload: unknown) => void;

/**
 * TriggerSpec — API per i TRIGGER custom (gap: prima i community author potevano
 * fare solo Action).
 *
 * Supporto runtime: `mode='polling'` è eseguito end-to-end (poll nel sandbox);
 * `mode='stream'` è rifiutato da compile() (il sandbox non tiene connessioni
 * persistenti) → per lo streaming usa il built-in trigger_websocket.
 *
 * Due modalità di lifecycle:
 *   • mode='polling' → l'engine chiama `poll()` ogni `pollIntervalSec`; il trigger
 *     interroga la sorgente, confronta con `ctx.state` e chiama `emit()` per ogni
 *     nuovo evento (es. "nuovo ordine Shopify").
 *   • mode='stream'  → l'engine chiama `connect()` una volta; il trigger apre una
 *     connessione persistente (WebSocket, SSE) e chiama `emit()` su ogni messaggio;
 *     ritorna una funzione di teardown per chiudere pulito (reconnect lo gestisce
 *     l'engine).
 */
export interface TriggerSpec {
  id: string;
  label: string;
  description?: string;
  configFields?: readonly ConfigField[];
  mode: 'polling' | 'stream';
  /** Solo mode='polling': intervallo tra i poll (default 60s). */
  pollIntervalSec?: number;
  poll?: (config: Record<string, unknown>, ctx: TriggerContext, emit: TriggerEmit) => Promise<void>;
  connect?: (config: Record<string, unknown>, ctx: TriggerContext, emit: TriggerEmit) => Promise<() => void>;
}

export interface CommunityNodeDefinition {
  manifest: {
    id: string;
    vendor: string;
    version: string;
    displayName: string;
    description: string;
    license: string;
    category?: string;
    homepage?: string;
  };
  def: {
    type: 'trigger' | 'action' | 'ai' | 'logic';
    icon: string;
    color: string;
    /** Top-level fields shared across all actions (e.g. API key). */
    configFields?: readonly ConfigField[];
  };
  /**
   * Helper / utilità condivise, inlinate a livello di MODULO nell'executor
   * generato. È l'escape hatch ufficiale per il limite di serializzazione:
   * `execute.toString()` perde il lexical environment, quindi una execute() NON
   * può chiudere su import o const dichiarate a livello di modulo. Ciò che serve
   * a più action (costanti, funzioni pure, piccoli client) va messo QUI come
   * stringa di codice. Una closure persa NON fallisce in silenzio: l'executor
   * la auto-diagnostica a runtime con un errore che nomina l'identificatore
   * mancante e rimanda a questo campo (AUDIT FIX SDK-3).
   */
  helpers?: string;
  actions: readonly Action[];
  /**
   * Trigger custom. I `mode='polling'` sono SUPPORTATI end-to-end: `compile()`
   * serializza il poll(), il runtime lo esegue nel sandbox ogni `pollIntervalSec`
   * e avvia un run per ogni `emit()`. I `mode='stream'` sono RIFIUTATI da
   * compile() (il sandbox non può tenere connessioni persistenti) → usa il
   * trigger built-in `trigger_websocket` per lo streaming.
   */
  triggers?: readonly TriggerSpec[];
}

// ───── Schemas (runtime validation for the CLI) ─────

const ConfigFieldSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9_]+$/u),
  label: z.string().min(1),
  type: z.string().optional(),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  help: z.string().optional(),
  defaultValue: z.string().optional(),
  options: z.array(z.string()).optional(),
  showIf: z.object({
    field: z.string(),
    equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
    in: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    truthy: z.boolean().optional(),
  }).optional(),
}).passthrough();

const ActionSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/iu),
  label: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  aiAction: z.boolean().optional(),
  configFields: z.array(ConfigFieldSchema).optional(),
  execute: z.function(),
}).passthrough();

const CommunityNodeDefinitionSchema = z.object({
  manifest: z.object({
    id: z.string().regex(/^[a-z0-9_-]+$/iu),
    vendor: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/u),
    displayName: z.string().min(1),
    description: z.string().min(1),
    license: z.string().min(1),
    category: z.string().optional(),
    homepage: z.string().url().optional(),
  }),
  def: z.object({
    type: z.enum(['trigger', 'action', 'ai', 'logic']),
    icon: z.string(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/u),
    configFields: z.array(ConfigFieldSchema).optional(),
  }),
  helpers: z.string().optional(),
  actions: z.array(ActionSchema).min(1),
});

// ───── Public API ─────

/**
 * Identity helper for action definitions. Lets TypeScript infer the
 * config shape and gives the vendor compile-time autocomplete in the
 * execute body.
 */
export function action<T extends Action>(spec: T): T {
  return spec;
}

/** Identity helper per i trigger custom (inferenza tipi + autocomplete). */
export function trigger<T extends TriggerSpec>(spec: T): T {
  return spec;
}

/**
 * Valida un TriggerSpec: id ben formato + coerenza mode↔lifecycle (polling
 * richiede poll(), stream richiede connect()). Throw con messaggio preciso.
 */
export function validateTriggerSpec(t: TriggerSpec): void {
  if (!/^[a-z0-9_-]+$/iu.test(t.id)) throw new Error(`Trigger id "${t.id}" non valido (solo alfanumerici, - e _)`);
  if (typeof t.label !== 'string' || t.label.length === 0) throw new Error(`Trigger "${t.id}": label obbligatoria`);
  if (t.mode === 'polling' && typeof t.poll !== 'function') throw new Error(`Trigger "${t.id}": mode='polling' richiede una funzione poll()`);
  if (t.mode === 'stream' && typeof t.connect !== 'function') throw new Error(`Trigger "${t.id}": mode='stream' richiede una funzione connect()`);
}

/**
 * Identity wrapper that runtime-validates the definition. Throws if the
 * shape is wrong — the CLI catches the throw and reports a precise
 * error pointing at the offending field.
 */
export function defineCommunityNode(spec: CommunityNodeDefinition): CommunityNodeDefinition {
  CommunityNodeDefinitionSchema.parse(spec);
  for (const t of spec.triggers ?? []) validateTriggerSpec(t);
  return spec;
}

// ───── Compiled artifact types (consumed by the CLI) ─────

export interface CompiledManifest {
  id: string;
  vendor: string;
  version: string;
  displayName: string;
  description: string;
  license: string;
  category?: string;
  homepage?: string;
  signature?: string;
  publicKeyPem?: string;
  publishedAt?: string;
}

export interface CompiledNodeDef {
  id: string;
  type: 'trigger' | 'action' | 'ai' | 'logic';
  label: string;
  icon: string;
  color: string;
  description: string;
  vendor: string;
  version: string;
  configFields?: readonly ConfigField[];
  actions: readonly {
    id: string;
    label: string;
    description?: string;
    category?: string;
    aiAction?: boolean;
    configFields?: readonly ConfigField[];
  }[];
  /**
   * Trigger POLLING compilati (FEAT community-trigger runtime). Solo polling:
   * gli stream sono rifiutati da compile(). Consumato dal runtime
   * trigger-watchers per schedulare il poll nel sandbox.
   */
  triggers?: readonly {
    id: string;
    label: string;
    description?: string;
    mode: 'polling';
    pollIntervalSec?: number;
    configFields?: readonly ConfigField[];
  }[];
}

/**
 * Lower a CommunityNodeDefinition to the (manifest, nodedef, executorSource)
 * triple expected by the FlowForge community-nodes runtime. The CLI passes
 * the result to its zip + sign pipeline.
 */
export function compile(spec: CommunityNodeDefinition): {
  manifest: CompiledManifest;
  nodedef: CompiledNodeDef;
  executorSource: string;
} {
  // FEAT community-trigger runtime (2026-06-09): i trigger POLLING sono ora
  // compilati ed eseguiti dal runtime (il poll() del vendor gira nel sandbox
  // isolated-vm ogni `pollIntervalSec`, ogni evento `emit()` avvia un run —
  // vedi generateExecutorSource + community-trigger-runner + trigger-watchers).
  //
  // I trigger `mode='stream'` restano rifiutati ESPLICITAMENTE (eredita la
  // filosofia SDK-2 "boundary onesto, no silent drop"): il sandbox espone solo
  // `fetch` e NON può mantenere connessioni persistenti (WebSocket/SSE), quindi
  // un lifecycle stream non è eseguibile in modo sicuro/isolato. Per lo
  // streaming reale si usa il trigger built-in `trigger_websocket`.
  const streamTriggers = (spec.triggers ?? []).filter((t) => t.mode === 'stream');
  if (streamTriggers.length > 0) {
    throw new Error(
      'compile(): i trigger `mode="stream"` non sono supportati dal runtime ' +
      'community — il sandbox isolated-vm espone solo `fetch` e non può tenere ' +
      'connessioni persistenti. Trigger interessati: ' + streamTriggers.map((t) => t.id).join(', ') + '. ' +
      'Usa `mode="polling"` (il poll viene eseguito nel sandbox ogni pollIntervalSec) ' +
      'oppure il trigger built-in `trigger_websocket` per lo streaming. ' +
      'La Action API e i trigger polling sono pienamente supportati.',
    );
  }
  const pollingTriggers = (spec.triggers ?? []).filter((t) => t.mode === 'polling');

  const manifest: CompiledManifest = {
    id: spec.manifest.id,
    vendor: spec.manifest.vendor,
    version: spec.manifest.version,
    displayName: spec.manifest.displayName,
    description: spec.manifest.description,
    license: spec.manifest.license,
  };
  if (spec.manifest.category) manifest.category = spec.manifest.category;
  if (spec.manifest.homepage) manifest.homepage = spec.manifest.homepage;

  const nodedef: CompiledNodeDef = {
    id: spec.manifest.id,
    type: spec.def.type,
    label: spec.manifest.displayName,
    icon: spec.def.icon,
    color: spec.def.color,
    description: spec.manifest.description,
    vendor: spec.manifest.vendor,
    version: spec.manifest.version,
    actions: spec.actions.map((a) => {
      const out: CompiledNodeDef['actions'][number] = {
        id: a.id,
        label: a.label,
      };
      if (a.description) out.description = a.description;
      if (a.category) out.category = a.category;
      if (a.aiAction !== undefined) out.aiAction = a.aiAction;
      if (a.configFields) out.configFields = a.configFields;
      return out;
    }),
  };
  if (spec.def.configFields) nodedef.configFields = spec.def.configFields;
  if (pollingTriggers.length > 0) {
    nodedef.triggers = pollingTriggers.map((t) => {
      const out: NonNullable<CompiledNodeDef['triggers']>[number] = {
        id: t.id, label: t.label, mode: 'polling',
      };
      if (t.description) out.description = t.description;
      if (t.pollIntervalSec) out.pollIntervalSec = t.pollIntervalSec;
      if (t.configFields) out.configFields = t.configFields;
      return out;
    });
  }

  const executorSource = generateExecutorSource(spec, pollingTriggers);
  return { manifest, nodedef, executorSource };
}

/**
 * Bundle the action.execute functions + helpers into a single CJS
 * executor.js file that FlowForge's runtime sandbox can run.
 *
 * Strategy: stringify each action.execute, build a switch on `__action`
 * (matching FlowForge's runtime dispatch convention), inline helpers.
 *
 * LIMITE NOTO + MITIGAZIONE (SDK-3): `.toString()` perde il lexical environment.
 * Una execute() che referenzia un import/const di modulo NON è catturata. Per
 * non trasformarlo in un footgun silenzioso, il dispatch generato `await`-a ogni
 * action e racchiude la chiamata in un try/catch che converte un ReferenceError
 * opaco in un errore attribuito + azionabile (nome identificatore + rimando al
 * campo `helpers`). I valori condivisi vanno dichiarati in `helpers`.
 */
/**
 * Vendor functions may be written as:
 *   • function expression: `async function (cfg, inp, ctx) { ... }`
 *   • arrow function:      `async (cfg, inp, ctx) => { ... }`
 *   • method shorthand:    `async execute(cfg, inp, ctx) { ... }`
 *     (most common because action({ async execute(...) { ... } }))
 *
 * Method shorthand toString output is NOT a valid expression on its own
 * (`async execute(cfg) { ... }` can't be assigned to a const). We
 * rewrite it to a function expression: `async function (cfg) { ... }`.
 *
 * Other shapes pass through unchanged.
 */
function normalizeFnSource(src: string): string {
  const trimmed = src.trimStart();
  // Forme GIÀ valide come espressione → invariate. L'ordine è critico: vanno
  // riconosciute PRIMA dello shorthand, altrimenti il regex shorthand
  // backtracka e tratta `async` come nome di metodo (BUG: `async (x) => …`
  // diventava `function (x) => …`, sintatticamente invalido — latente finché
  // l'executor non veniva eseguito).
  //   • function expression:        `function (…){…}` / `async function (…){…}`
  //   • arrow con param list:        `(…) => …`        / `async (…) => …`
  //   • arrow single-param no-paren: `x => …`          / `async x => …`
  if (/^(async\s+)?function\b/u.test(trimmed)) return trimmed;
  if (/^(async\s+)?\(/u.test(trimmed)) return trimmed;
  if (/^(async\s+)?[a-zA-Z_$][\w$]*\s*=>/u.test(trimmed)) return trimmed;
  // Altrimenti method shorthand: `name(…){…}` o `async name(…){…}` → riscrivi
  // a function expression assegnabile a una const.
  const shorthandMatch = /^(async\s+)?([a-zA-Z_$][\w$]*)\s*\(/u.exec(trimmed);
  if (shorthandMatch) {
    const asyncPrefix = shorthandMatch[1] ?? '';
    const restStart = shorthandMatch[0].length - 1; // keep the `(`
    return asyncPrefix + 'function ' + trimmed.slice(restStart);
  }
  return trimmed;
}

function generateExecutorSource(
  spec: CommunityNodeDefinition,
  pollingTriggers: readonly TriggerSpec[] = [],
): string {
  const lines: string[] = [];
  lines.push('// Generated by @medea/engine-community-node-sdk — do not edit by hand.');
  lines.push('// Vendor: ' + spec.manifest.vendor + ' · Package: ' + spec.manifest.id + ' v' + spec.manifest.version);
  lines.push('');
  if (spec.helpers) {
    lines.push('// ───── Helpers ─────');
    lines.push(spec.helpers);
    lines.push('');
  }
  lines.push('// ───── Actions ─────');
  for (const a of spec.actions) {
    const fnSource = normalizeFnSource(a.execute.toString());
    lines.push('const __action_' + a.id + ' = ' + fnSource + ';');
    lines.push('');
  }
  if (pollingTriggers.length > 0) {
    // FEAT community-trigger runtime: serializza il poll() di ogni trigger
    // polling. Verrà invocato dal bridge __ff_trigger_poll dentro module.exports.
    lines.push('// ───── Triggers (polling) ─────');
    for (const t of pollingTriggers) {
      const fnSource = normalizeFnSource(t.poll!.toString());
      lines.push('const __ff_trigger_' + t.id + ' = ' + fnSource + ';');
      lines.push('');
    }
  }
  const dn = JSON.stringify(spec.manifest.displayName);
  lines.push('module.exports = async function execute(config, input, context) {');
  lines.push('  var __action = config.__action || context.action || ' + JSON.stringify(spec.actions[0]!.id) + ';');
  lines.push('  try {');
  if (pollingTriggers.length > 0) {
    // FEAT community-trigger runtime: poll bridge. Il runtime trigger-watchers
    // invoca l'executor con config.__ff_trigger_poll=<triggerId> e input.state
    // = lo stato persistito tra i poll. emit() accumula gli eventi; ritorniamo
    // { events, state } — l'host avvia un run per ogni evento e ripersiste lo
    // state. Dentro il try → coperto dall'auto-diagnosi SDK-3 (closure-loss).
    lines.push('    if (config && config.__ff_trigger_poll) {');
    lines.push('      var __tid = String(config.__ff_trigger_poll);');
    lines.push('      var __events = [];');
    lines.push('      var __tstate = (input && input.state && typeof input.state === "object" && input.state !== null) ? input.state : {};');
    lines.push('      var __tctx = { tenantId: context.tenantId, workflowId: context.workflowId, nodeId: context.nodeId, state: __tstate };');
    lines.push('      var __emit = function (payload) { __events.push(payload); };');
    lines.push('      switch (__tid) {');
    for (const t of pollingTriggers) {
      lines.push('        case ' + JSON.stringify(t.id) + ': await __ff_trigger_' + t.id + '(config, __tctx, __emit); break;');
    }
    lines.push('        default: throw new Error(' + dn + ' + ": trigger sconosciuto \\"" + __tid + "\\"");');
    lines.push('      }');
    lines.push('      return { events: __events, state: __tctx.state };');
    lines.push('    }');
  }
  lines.push('    switch (__action) {');
  for (const a of spec.actions) {
    // `await`: necessario perché un ReferenceError che scatta DENTRO una
    // execute() async rigetta la promise — senza await il catch sottostante
    // non lo intercetterebbe (AUDIT FIX SDK-3).
    lines.push('      case ' + JSON.stringify(a.id) + ': return await __action_' + a.id + '(config, input, context);');
  }
  lines.push('      default: throw new Error(' + dn + ' + ": action sconosciuta \\"" + __action + "\\"");');
  lines.push('    }');
  lines.push('  } catch (__err) {');
  // AUDIT FIX SDK-3 (2026-06-09): self-diagnosi della perdita di closure.
  // `execute.toString()` perde il lexical environment: una execute() che
  // referenzia un import o una const di MODULO produce un ReferenceError
  // opaco a runtime ("X is not defined"). Qui lo trasformiamo in un errore
  // ATTRIBUITO + AZIONABILE che nomina l'identificatore e indica la soluzione
  // (`helpers`). Gli altri errori passano invariati.
  lines.push('    if (__err instanceof ReferenceError) {');
  lines.push('      var __miss = String((__err && __err.message) || "").replace(/ is not defined[\\s\\S]*$/, "");');
  lines.push('      throw new Error(');
  lines.push('        ' + dn + ' + " [" + __action + "]: l\'identificatore \'" + __miss + "\' non e\' disponibile nel sandbox. " +');
  lines.push('        "Causa tipica: la tua execute() referenzia un import o una const dichiarata a livello di MODULO, " +');
  lines.push('        "che viene persa quando la funzione e\' serializzata (.toString()). Soluzione: sposta quel valore o " +');
  lines.push('        "helper nel campo \\"helpers\\" del nodo (viene inlinato a livello modulo), oppure inlinea il valore " +');
  lines.push('        "direttamente dentro execute(). [@medea/engine-community-node-sdk SDK-3]"');
  lines.push('      );');
  lines.push('    }');
  lines.push('    throw __err;');
  lines.push('  }');
  lines.push('};');
  return lines.join('\n');
}

// Test-as-data: fixture runner per i custom node author (vedi bin/ffnode-test).
export * from './fixtures.js';
