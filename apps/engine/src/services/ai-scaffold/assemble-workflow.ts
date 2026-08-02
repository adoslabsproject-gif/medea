/**
 * Assemblaggio del Workflow canonico dal parsed LLM — estratto da singleshot
 * (split NO-MONOLITI 2026-06-11). Firma STRETTA (solo parsed) → estrazione pulita,
 * non un blocco accoppiato. Trasforma parsed → Workflow validato:
 *  - posizionamento default (x=idx*220, y=200) se la LLM non lo dà
 *  - serializzazione config (valori non-string → JSON.stringify)
 *  - label → name
 *  - WorkflowSchema.parse (throw 502 se non conforme)
 *
 * Il resto del result (trace/note/timing) resta nell'orchestratore: è result-assembly
 * con input larghi (usage/timing), inerente al flow.
 */
import { WorkflowSchema, type Workflow } from '@medea/engine-core-schema';
import { AiScaffoldError } from '@/services/ai-scaffold/types.js';

export interface ParsedForAssembly {
  name: string;
  description?: string | undefined;
  nodes: {
    id: string;
    defId: string;
    label?: string | undefined;
    x?: number | undefined;
    y?: number | undefined;
    config: Record<string, unknown>;
  }[];
  edges: { from: string; to: string; fromPort?: string | undefined }[];
}

export function assembleWorkflow(parsed: ParsedForAssembly): Workflow {
  const nowIso = new Date().toISOString();
  const id = 'wf_' + Date.now().toString(36);
  const wfPlain = {
    schemaVersion: '1.0.0' as const,
    id,
    name: parsed.name,
    description: parsed.description || undefined,
    enabled: false,
    nodes: parsed.nodes.map((n, idx) => {
      const out: Record<string, unknown> = {
        id: n.id,
        defId: n.defId,
        x: n.x ?? idx * 220,
        y: n.y ?? 200,
        config: Object.fromEntries(
          Object.entries(n.config).map(([k, v]) => [
            k,
            typeof v === 'string' ? v : JSON.stringify(v),
          ]),
        ),
      };
      if (n.label) out.name = n.label;
      return out;
    }),
    edges: parsed.edges,
    nodeDefs: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  try {
    return WorkflowSchema.parse(wfPlain);
  } catch (e) {
    throw new AiScaffoldError(
      `Workflow assemblato non conforme a WorkflowSchema: ${e instanceof Error ? e.message : String(e)}`,
      502,
    );
  }
}
