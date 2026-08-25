/**
 * Tradurre fra il motore e il disegno: provider, workflow, tabelle.
 *
 * Le due parti si somigliano molto — il motore è lo stesso di FlowForge e il
 * disegno ne è il cliente — ma «molto» non è «abbastanza»: i nomi dei provider
 * coincidono solo in parte, e ciò che arriva dal filo è dato altrui finché
 * qualcuno non lo guarda. Qui lo si guarda.
 *
 * @module features/workflows/scaffold/motore-mappa
 */

import type { ProviderId } from '../../ai/types';
import type { CanvasNode, Workflow, WorkflowEdge } from '../types';

import type { ScaffoldOutput } from './schema';

/**
 * Come il motore chiama il provider che il desktop chiama così — o `null` se
 * non sa chiamarlo affatto.
 *
 * Due non sono esprimibili, e la ragione è concreta in entrambi i casi:
 *
 *  - `custom` è un endpoint OpenAI-compatibile scelto dall'utente, e vive nel
 *    suo indirizzo. La richiesta al motore porta provider e chiave, non un
 *    indirizzo: non c'è dove metterlo.
 *  - `claude-cli` è l'abbonamento, e non ha una chiave da passare a nessuno:
 *    la CLI esegue il proprio ciclo per conto suo.
 *
 * Per questi due non è un errore: è la strada locale, che resta.
 */
export function providerPerMotore(provider: ProviderId): string | null {
  switch (provider) {
    case 'liara':
    case 'anthropic':
    case 'openai':
    case 'gemini':
    case 'deepseek':
    case 'grok':
    case 'openrouter':
      return provider;
    case 'custom':
    case 'claude-cli':
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function testo(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function numero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Un nodo come lo manda il motore, se ha la forma di un nodo.
 *
 * `id` e `defId` sono l'osso: senza, il nodo non è collegabile né disegnabile e
 * tenerlo vorrebbe dire portarsi dietro un buco fino al canvas. La `config`
 * arriva coi valori già ridotti a stringa dal motore — è il suo contratto
 * storico — e qui resta com'è: chi la legge sa leggerla.
 */
function nodoDalMotore(value: unknown): CanvasNode | null {
  if (!isRecord(value)) return null;
  const id = testo(value.id);
  const defId = testo(value.defId);
  if (!id || !defId) return null;
  const config = isRecord(value.config) ? value.config : {};
  const label = testo(value.label);
  const name = testo(value.name);
  return {
    id,
    defId,
    x: numero(value.x),
    y: numero(value.y),
    config,
    ...(label ? { label } : {}),
    ...(name ? { name } : {}),
  };
}

function collegamentoDalMotore(value: unknown): WorkflowEdge | null {
  if (!isRecord(value)) return null;
  const from = testo(value.from);
  const to = testo(value.to);
  if (!from || !to) return null;
  const fromPort = testo(value.fromPort);
  return { from, to, ...(fromPort ? { fromPort } : {}) };
}

/**
 * Il workflow del motore nel formato del disegno, oppure `null` se quello che
 * è arrivato non è un workflow.
 *
 * Un nodo malformato fa cadere tutto invece di essere saltato: un workflow a
 * cui manca un pezzo si apre lo stesso e sembra completo, e chi lo guarda non
 * ha modo di sapere che gliene è stato tolto uno. Meglio un fallimento
 * dichiarato che una consegna silenziosamente incompleta.
 */
export function workflowDalMotore(value: unknown): Workflow | null {
  if (!isRecord(value)) return null;
  const name = testo(value.name);
  if (!name) return null;
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) return null;

  const nodes: CanvasNode[] = [];
  for (const grezzo of value.nodes) {
    const nodo = nodoDalMotore(grezzo);
    if (!nodo) return null;
    nodes.push(nodo);
  }

  const edges: WorkflowEdge[] = [];
  for (const grezzo of value.edges) {
    const collegamento = collegamentoDalMotore(grezzo);
    if (!collegamento) return null;
    edges.push(collegamento);
  }

  const description = testo(value.description);
  return {
    name,
    ...(description ? { description } : {}),
    nodes,
    edges,
    executionTarget: 'local',
  };
}

/**
 * Le tabelle che il motore dichiara di voler creare, tenendo solo quelle
 * complete: una tabella senza colonne non si crea, e mostrarla prometterebbe
 * qualcosa che non succederà.
 */
export function tabelleDalMotore(value: unknown): ScaffoldOutput['tablesToCreate'] {
  if (!Array.isArray(value)) return undefined;
  const out: NonNullable<ScaffoldOutput['tablesToCreate']> = [];
  for (const grezza of value) {
    if (!isRecord(grezza)) continue;
    const name = testo(grezza.name);
    if (!name || !Array.isArray(grezza.columns)) continue;
    const columns: { name: string; type: string; nullable?: boolean }[] = [];
    for (const colonna of grezza.columns) {
      if (!isRecord(colonna)) continue;
      const nomeColonna = testo(colonna.name);
      const tipo = testo(colonna.type);
      if (!nomeColonna || !tipo) continue;
      columns.push({
        name: nomeColonna,
        type: tipo,
        ...(typeof colonna.nullable === 'boolean' ? { nullable: colonna.nullable } : {}),
      });
    }
    if (columns.length > 0) out.push({ name, columns });
  }
  return out.length > 0 ? out : undefined;
}
