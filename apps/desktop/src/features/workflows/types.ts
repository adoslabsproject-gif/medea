/**
 * Schema del workflow — port di `packages/flowforge/core/schema` di FlowForge.
 *
 * Vincolo: un workflow generato qui deve poter essere importato sul server e
 * viceversa. Ogni deviazione da questa forma rompe la compatibilità.
 */

import type { ShowIfRule } from './fields/show-if';

/** Nodo sul canvas. I valori di config sono normalizzati a stringa: è il
 *  motore a farne il parse a runtime (stessa scelta del server). */
export interface CanvasNode {
  id: string;
  defId: string;
  x: number;
  y: number;
  config: Record<string, unknown>;
  name?: string;
  label?: string;
  continueOnFail?: boolean;
  defVersion?: string;
}

/** Collegamento fra due nodi.
 *  `fromPort` conta per i nodi che ramificano (`logic_if` → `true`/`false`).
 *  `sourceHandle`/`targetHandle` sono solo UI: il motore li ignora.
 *  `mapMode` è il fan-out per elemento senza loop esplicito. */
export interface WorkflowEdge {
  from: string;
  to: string;
  fromPort?: string;
  label?: string;
  sourceHandle?: string;
  targetHandle?: string;
  mapMode?: 'off' | 'auto' | 'each';
}

/** Colonna di una tabella che il workflow chiede di creare. */
export interface TableColumn {
  name: string;
  type: string;
  nullable?: boolean;
}

export interface TableToCreate {
  name: string;
  columns: TableColumn[];
}

/** Il workflow incorpora le definizioni dei nodi che usa: un JSON esportato
 *  è autodescrittivo e si apre anche dove quei nodi non sono installati. */
export interface Workflow {
  id?: string;
  name: string;
  description?: string;
  nodes: CanvasNode[];
  edges: WorkflowEdge[];
  nodeDefs?: NodeDef[];
  runVerbosity?: 'silent' | 'summary' | 'full';
  /** Dove viene eseguito: sul PC o sul server sempre acceso. */
  executionTarget?: 'local' | 'server';
}

/** Un campo di configurazione di un nodo, con i vincoli che il modello deve
 *  rispettare. È la fonte da cui nascono sia il prompt sia la validazione. */
export interface NodeConfigField {
  key: string;
  label?: string;
  type: string;
  required?: boolean;
  options?: string[];
  pattern?: string;
  defaultValue?: string;
  description?: string;
  /** Mostra il campo solo quando un altro campo ha un certo valore. */
  showIf?: ShowIfRule;
  /** Il campo di cui questo elenco dipende (es. la tabella dipende dal database). */
  dependsOn?: string;
}

export interface NodeAction {
  id: string;
  label?: string;
}

/** Definizione di un nodo del catalogo. */
export interface NodeDef {
  defId: string;
  type: 'trigger' | 'action' | 'ai' | 'logic';
  label: string;
  description?: string;
  /** Nome simbolico dell'icona dichiarato dal nodo (es. `clock`, `mail`). */
  icon?: string;
  /** Colore identificativo del nodo, come lo definisce il suo pacchetto. */
  color?: string;
  configFields?: NodeConfigField[];
  actions?: NodeAction[];
  /** Porte in uscita dichiarate (es. `true`/`false` per logic_if). */
  outputPorts?: string[];
  searchAliases?: string[];
}
