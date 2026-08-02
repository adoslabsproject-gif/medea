import { z } from 'zod';
import { NodeDefSchema, type NodeDef } from '@medea/engine-core-schema';
import type { ILLMProvider, LLMCompletionRequest } from '@/ports/llm-provider.js';
import {
  validateExecutor,
  hasSecurityViolation,
  type ExecutorViolation,
} from '@/services/node-generator/executor-validator.js';
import {
  validateCoherence,
  type CoherenceViolation,
} from '@/services/node-generator/coherence-validator.js';
import { buildRepairPrompt } from '@/services/node-generator/repair-prompt.js';

export interface GenerateNodeInput {
  description: string;
  openApiUrl?: string;
  language?: 'it' | 'en';
}

export interface GeneratedNode {
  def: NodeDef;
  executorSource: string;
  rationale: string;
  warnings?: string[];
  raw?: string;
}

/** Numero massimo di tentativi di riparazione (oltre alla generazione iniziale). */
const MAX_REPAIR_ATTEMPTS = 2;

/**
 * Evento dello streaming di `generateStream`: un `delta` (token grezzo, per la
 * progressione live in UI/SSE) oppure il `done` finale col `GeneratedNode`
 * parsato e validato (sicurezza inclusa).
 */
export type NodeGenStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; node: GeneratedNode };

const GeneratedPayloadSchema = z.object({
  def: NodeDefSchema,
  executorSource: z.string().min(20),
  rationale: z.string(),
  warnings: z.array(z.string()).optional(),
});

const NODE_DEF_REFERENCE = `
NodeDef shape (Zod-validated):
{
  id:          "alphanumeric_lowercase_underscore_hyphen",
  type:        "trigger" | "action" | "ai" | "logic",
  label:       "Display name shown in palette",
  icon:        "lucide-icon-name",
  color:       "#RRGGBB",
  description: "Single-sentence description.",
  configFields: [
    { key, label, type: "text"|"textarea"|"select"|"number"|"boolean"|"secret"|"json",
      required, placeholder, help, options?: ["v1","v2"] }
  ],
  outputs:     [ "port_name", ... ] OR undefined,
  vendor:      "third-party",
  version:     "1.0.0"
}

The executor must be a self-contained async function string of shape:
  async function execute(config, input, context) {
    // your code
    return { output: ..., durationMs: Date.now() - startedAt };
  }

Inside the executor you have access to:
  - global fetch (Node 18+ built-in)
  - config.X for each configField key
  - input (output of the previous node)
  - context.tenantId / context.workflowId / context.runId / context.nodeId
  - context.secrets[name] for credentials referenced from configFields with type 'secret'

DO NOT use require(), import statements, eval, or globalThis. NO fs/process/child_process.
`.trim();

function buildSystemPrompt(language: 'it' | 'en'): string {
  const intro =
    language === 'it'
      ? 'Sei un esperto sviluppatore di nodi per FlowForge, una piattaforma di workflow automation. Genera definizioni di nodi pulite, sicure e tipizzate.'
      : 'You are an expert FlowForge node developer. Generate clean, secure, well-typed node definitions.';

  return `${intro}

${NODE_DEF_REFERENCE}

Your output MUST be a single JSON object inside a \`\`\`json fenced code block.
The JSON must conform to:
{
  "def": { ...NodeDef... },
  "executorSource": "async function execute(config, input, context) { ... }",
  "rationale": "Brief explanation of design choices.",
  "warnings": ["optional", "edge cases the user should know"]
}

No prose outside the JSON block.`;
}

function buildUserPrompt(input: GenerateNodeInput): string {
  const parts: string[] = [];
  parts.push(`Description: ${input.description}`);
  if (input.openApiUrl) {
    parts.push(`Reference OpenAPI/Swagger spec URL: ${input.openApiUrl}`);
    parts.push(
      '(Read the spec, identify the most relevant endpoint, and design a node that calls it.)',
    );
  }
  parts.push(
    '\nReturn ONLY the JSON object with def, executorSource, rationale, and warnings (if any).',
  );
  return parts.join('\n');
}

export class NodeGeneratorService {
  constructor(private readonly llm: ILLMProvider) {}

  /**
   * Costruisce la richiesta LLM (system+user prompt) condivisa da `generate`
   * (non-streaming) e `generateStream` (streaming) — UNA sola fonte di verità
   * per prompt, model vuoto (risolto a monte dall'adapter) e tuning.
   */
  private buildRequest(input: GenerateNodeInput): LLMCompletionRequest {
    if (!input.description || input.description.trim().length < 10) {
      throw new Error('Description must be at least 10 characters');
    }
    const language = input.language ?? 'en';
    // Model intentionally left empty — the underlying provider adapter
    // (ResolvedLLMProvider in routes/node-generator.ts) substitutes the
    // tenant-resolved default. Hardcoding a vendor model here would lock
    // the codepath to a single vendor.
    return {
      model: '',
      maxTokens: 4096,
      temperature: 0.2,
      messages: [
        { role: 'system', content: buildSystemPrompt(language) },
        { role: 'user', content: buildUserPrompt(input) },
      ],
    };
  }

  /**
   * Genera un nodo e ne GARANTISCE la qualità con un loop di riparazione bounded
   * (come un agente: genera → valida → se rotto, ricorregge mirato → rivalida).
   *
   * Stadi: parse+Zod+SICUREZZA (parseLLMResponse, throw "forbidden" non
   * riparabile-soft) → validazione QUALITÀ (sintassi/firma/return) + COERENZA
   * (config key/secret) → se ci sono problemi BLOCCANTI e restano tentativi,
   * chiede al modello di correggere SOLO quelli. Esauriti i tentativi: l'ultimo
   * parse propaga la sicurezza ("forbidden"→422) o lancia "validation"→422; i
   * problemi non-bloccanti (warning) finiscono nei `warnings` del nodo.
   */
  async generate(input: GenerateNodeInput): Promise<GeneratedNode> {
    const baseReq = this.buildRequest(input); // valida anche la lunghezza della description
    const language = input.language ?? 'en';
    let raw = (await this.llm.complete(baseReq)).text;
    let lastIssues: string[] = [];

    for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
      let node: GeneratedNode | null = null;
      try {
        node = this.parseLLMResponse(raw); // throw: JSON/Zod/sicurezza
        const quality = this.validateQuality(node);
        const blocking = [
          ...quality.executor.filter((v) => v.severity === 'error'),
          ...quality.coherence.filter((v) => v.severity === 'error'),
        ].map((v) => v.message);
        if (blocking.length === 0) {
          const warns = [
            ...(node.warnings ?? []),
            ...quality.coherence.filter((v) => v.severity === 'warning').map((v) => v.message),
          ];
          if (warns.length > 0) node.warnings = warns;
          return node;
        }
        lastIssues = blocking;
      } catch (err) {
        // Sicurezza/JSON/Zod: riparabili via prompt finché restano tentativi.
        lastIssues = [err instanceof Error ? err.message : String(err)];
      }
      if (attempt === MAX_REPAIR_ATTEMPTS) break;
      const repairPrompt = buildRepairPrompt({
        description: input.description,
        previousRaw: raw,
        issues: lastIssues,
        language,
      });
      raw = (
        await this.llm.complete({
          ...baseReq,
          messages: [baseReq.messages[0]!, { role: 'user', content: repairPrompt }],
        })
      ).text;
    }

    // Tentativi esauriti. Il parse finale RIPROPAGA la sicurezza ("forbidden"
    // →422) o lo schema se ancora rotti; se invece il parse passa, resta solo
    // un problema di qualità non risolto → "validation" (→422). In entrambi i
    // casi la funzione termina lanciando: non emettiamo MAI un nodo non valido.
    this.parseLLMResponse(raw);
    throw new Error(`Generated node failed validation after repair: ${lastIssues.join('; ')}`);
  }

  /**
   * Validazione di QUALITÀ (non-sicurezza) del nodo: executor (sintassi/firma/
   * return) + coerenza def↔executor (config key/secret/select). La sicurezza è
   * già gestita da parseLLMResponse (hard-fail). Pura rispetto all'istanza.
   */
  validateQuality(node: GeneratedNode): {
    executor: ExecutorViolation[];
    coherence: CoherenceViolation[];
  } {
    return {
      executor: validateExecutor(node.executorSource).filter((v) => v.severity !== 'security'),
      coherence: validateCoherence(node.def, node.executorSource),
    };
  }

  /**
   * Variante STREAMING di `generate`: emette i `delta` token-by-token mentre il
   * modello genera (progressione live), poi un `done` col `GeneratedNode`
   * parsato dall'accumulato. Il parse/validazione (incluso il safety gate sui
   * token vietati) avviene SOLO alla fine sul testo completo — un JSON parziale
   * non è utilizzabile, ma i delta danno feedback di avanzamento all'utente.
   *
   * Errori di parse/validazione si propagano (il caller li mappa a un evento
   * SSE `error`), esattamente come in `generate`.
   */
  async *generateStream(input: GenerateNodeInput): AsyncGenerator<NodeGenStreamEvent> {
    const req = this.buildRequest(input);
    let accumulated = '';
    for await (const chunk of this.llm.stream(req)) {
      if (chunk.delta.length > 0) {
        accumulated += chunk.delta;
        yield { type: 'delta', text: chunk.delta };
      }
      if (chunk.done) break;
    }
    const node = this.parseLLMResponse(accumulated);
    yield { type: 'done', node };
  }

  parseLLMResponse(raw: string): GeneratedNode {
    const fence = /```json\s*([\s\S]*?)\s*```/.exec(raw);
    const jsonText = fence?.[1]?.trim() ?? raw.trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      throw new Error(
        `LLM response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const result = GeneratedPayloadSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`Generated node failed validation: ${issues}`);
    }

    // SICUREZZA via AST (non regex): cattura anche i bypass (bracket-access,
    // spazi, import dinamico) che una blacklist testuale non vede. Hard-fail.
    const security = validateExecutor(result.data.executorSource).filter(
      (v) => v.severity === 'security',
    );
    if (hasSecurityViolation(security)) {
      throw new Error(
        `Generated executor contains forbidden tokens: ${security.map((v) => v.message).join(' ')}`,
      );
    }

    const out: GeneratedNode = {
      def: result.data.def,
      executorSource: result.data.executorSource,
      rationale: result.data.rationale,
      raw,
    };
    if (result.data.warnings) out.warnings = result.data.warnings;
    return out;
  }
}
