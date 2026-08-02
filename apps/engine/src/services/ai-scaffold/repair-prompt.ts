/**
 * repair-prompt — costruisce la richiesta di RIPARAZIONE mirata (#8 strato B).
 *
 * Dato l'insieme delle violazioni del catalog-validator, produce:
 *   - un system+user prompt che descrive ESATTAMENTE cosa è rotto (messaggi del
 *     validatore) e chiede di correggere SOLO i nodi interessati;
 *   - lo schema JSON della risposta (array di {id, config}) per guided_json.
 *
 * Puro (nessun I/O) → testabile. La riparazione vera (chiamata LLM) la fa
 * make-llm-repair.ts usando questo prompt + schema.
 *
 * @module services/ai-scaffold/repair-prompt
 */
import {
  describeViolation,
  type CatalogViolation,
} from '@/services/ai-scaffold/catalog-validator.js';
import type { AutoConfigNode } from '@/services/ai-scaffold/semantic-autoconfig.js';

export interface RepairPromptInput {
  nodes: AutoConfigNode[];
  violations: CatalogViolation[];
  /** Goal originale del workflow — contesto per inferire i valori mancanti. */
  goal?: string;
}

export interface RepairPrompt {
  system: string;
  user: string;
  /** Schema guided_json della risposta di riparazione. */
  schema: object;
}

/** Schema della risposta: SOLO {fixes:[{id, config}]}. */
export const REPAIR_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    fixes: {
      type: 'array',
      maxItems: 30,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          config: { type: 'object' },
        },
        required: ['id', 'config'],
        additionalProperties: false,
      },
    },
  },
  required: ['fixes'],
  additionalProperties: false,
} as const;

const SYSTEM = [
  'Sei un riparatore di configurazioni di nodi FlowForge. Ti vengono dati alcuni',
  'nodi con errori di configurazione e la lista PRECISA degli errori. Correggi',
  'SOLO i nodi indicati restituendo la loro config completa e valida.',
  '',
  'Regole:',
  '- Riempi i campi obbligatori mancanti con valori REALISTICI dedotti dal goal',
  '  (es. un URL plausibile, un nome tabella sensato). Niente placeholder finti.',
  '- Per gli enum usa ESATTAMENTE uno dei valori ammessi indicati.',
  '- Rimuovi le chiavi non valide segnalate.',
  '- NON inventare chiavi nuove. NON toccare nodi non elencati.',
  '- I segreti (API key, password) lasciali a `{{secrets.NOME}}`.',
  'Rispondi SOLO con il JSON { "fixes": [ { "id", "config" } ] }.',
].join('\n');

/** Raggruppa le violazioni per nodeId. */
function groupByNode(violations: CatalogViolation[]): Map<string, CatalogViolation[]> {
  const out = new Map<string, CatalogViolation[]>();
  for (const v of violations) {
    const list = out.get(v.nodeId) ?? [];
    list.push(v);
    out.set(v.nodeId, list);
  }
  return out;
}

/** Costruisce il prompt di riparazione. Include solo i nodi con violazioni. */
export function buildRepairPrompt(input: RepairPromptInput): RepairPrompt {
  const byNode = groupByNode(input.violations);
  const nodeById = new Map(input.nodes.map((n) => [n.id, n]));

  const blocks: string[] = [];
  for (const [nodeId, viols] of byNode) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    blocks.push(
      [
        `Nodo "${nodeId}" (defId: ${node.defId})`,
        `Config attuale: ${JSON.stringify(node.config ?? {})}`,
        'Errori da correggere:',
        ...viols.map((v) => `  - ${describeViolation(v)}`),
      ].join('\n'),
    );
  }

  const user = [
    input.goal ? `Goal del workflow: ${input.goal}` : null,
    '',
    'Nodi da riparare:',
    '',
    blocks.join('\n\n'),
  ]
    .filter((l) => l !== null)
    .join('\n');

  return { system: SYSTEM, user, schema: REPAIR_RESPONSE_SCHEMA };
}
