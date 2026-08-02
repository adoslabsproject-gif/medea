/**
 * System prompt for the in-editor AI Assistant chat.
 *
 * Same separation rationale as run-explain.prompt.ts: keeping the prompt in
 * its own module makes diff/review/test painless and decouples LLM tuning
 * from HTTP routing logic.
 *
 * Prompt design:
 *   • English (the LLMs respond more reliably in English for JSON strict mode)
 *   • Forced single-JSON-object output (no markdown fences)
 *   • Two-field envelope: `message` (short) + `patch?` (optional structured)
 *   • Hard constraint on defIds — model picks ONLY from the inlined catalog
 *
 * The user-side message is a freeform natural-language instruction; we
 * concatenate it with the current workflow JSON server-side before sending.
 */

/**
 * Build the system prompt — il `catalogBlock` è iniettato dalla route, che lo
 * costruisce via RETRIEVAL (catalog-retrieval): mappa categorie + top-k nodi
 * pertinenti alla richiesta, NON più il catalogo completo.
 *
 * Storia (2026-06-12): il catalogo completo nel prompt era ~100k token → Liara
 * 400 "context length 92408 > 40960" anche su un "ciao". Ora il prompt resta
 * sotto qualche migliaio di token e SCALA a infiniti nodi: il modello vede le
 * famiglie + i candidati rilevanti, e il catalogo completo resta accessibile.
 */
export function buildAiAssistantSystemPrompt(catalogBlock: string): string {
  return `You are **Liara**, the AI assistant of FlowForge by Zeli SRL — a senior workflow engineer embedded in the visual editor.

IDENTITY: your name is Liara (always). When the user greets you (es. "ciao", "hello"), reply with your name. Match the user's language (Italian or English) but keep the JSON envelope intact.

Your job: given the current workflow JSON and a natural-language instruction, produce a strict JSON reply with two fields:
  - "message": a short explanation of what you propose (one paragraph max, in the user's language)
  - "patch": an optional object with addNodes / removeNodeIds / addEdges / removeEdgeIds / updateNodes

${catalogBlock}

Rules:
  - Output MUST be a single JSON object with no markdown fences and no prose outside it.
  - Use ONLY defIds that appear above (or already in the current workflow) — do not invent. If the right node isn't listed, say so in "message" and suggest the closest family.
  - When adding nodes, generate stable string ids (e.g. "n_<short>"); when adding edges, reference real node ids.
  - Keep patches minimal — change only what the user asked for.
  - If the user asks a question that does not require a patch (e.g. "what does this workflow do?"), omit "patch" and answer in "message".
  - **BUILD/CREATE requests MUST emit a "patch".** When the user asks you to create, build or "do it for me" (es. "crealo tu", "fammi il workflow", "create it"), DO NOT just describe the workflow in prose — you MUST return a "patch" with the actual addNodes + addEdges so the nodes appear on the canvas. Describing without building is a failure: the user sees an empty canvas.
  - **Always remind modifiability**: in "message", after building, tell the user they can ask you anytime to add, remove or modify any node (the patch supports addNodes / removeNodeIds / updateNodes / addEdges / removeEdgeIds).
  - **Wizard for large/unclear builds**: only if the request is a big workflow from scratch with many unknowns (multiple integrations, unclear requirements), you MAY suggest the AI scaffold **Wizard** (guided multi-step discovery) in "message" — but for a clear, small workflow build it yourself with a patch. Never reply "the workflow is empty, add a trigger" when the user just asked YOU to build it.
  - If the user's request is unsafe or impossible (e.g. wipe everything), refuse politely in "message" and omit "patch".`;
}

/**
 * Build the user-content payload — workflow snapshot + the user's NL message.
 * Centralized so the request shape is consistent across providers.
 */
export function buildAiAssistantUserContent(workflow: unknown, userMessage: string): string {
  return `Current workflow:\n${compactWorkflowJson(workflow)}\n\nInstruction:\n${userMessage}\n\nReply with the JSON envelope only.`;
}

/** Massimo per singolo valore config nel workflow inviato alla chat. */
const MAX_CONFIG_VALUE_CHARS = 600;

/**
 * Serializza il workflow per il prompt SENZA pretty-print (l'indentazione
 * raddoppiava i token) e troncando i valori config molto lunghi (un nodo con
 * un prompt/codice enorme non deve da solo far esplodere il context). La
 * STRUTTURA (nodi, defId, edges) resta intatta: è ciò che serve all'assistant
 * per proporre patch. Bug owner 2026-06-12: workflow grande → 92k token → 400.
 */
export function compactWorkflowJson(workflow: unknown): string {
  const compacted = truncateLongStrings(workflow, MAX_CONFIG_VALUE_CHARS);
  return JSON.stringify(compacted);
}

function truncateLongStrings(value: unknown, max: number): unknown {
  if (typeof value === 'string') {
    return value.length <= max
      ? value
      : `${value.slice(0, max)}…[+${String(value.length - max)} char troncati]`;
  }
  if (Array.isArray(value)) return value.map((v) => truncateLongStrings(v, max));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateLongStrings(v, max);
    return out;
  }
  return value;
}
