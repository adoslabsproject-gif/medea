/**
 * Il workflow in costruzione: lo stato che i 9 tool dell'agente manipolano.
 *
 * Ogni operazione risponde con l'esito e con ciò che manca ancora, invece di
 * limitarsi a un "ok": è così che il modello capisce da solo quale sia la
 * mossa successiva, senza doverglielo dire nel prompt.
 */

import { gateWorkflow, type QualityDatabase, type QualityGateResult } from '../quality';
import type { CanvasNode, NodeDef, WorkflowEdge } from '../types';

import { indexByDefId } from './catalog';
import { isPickerField, validateScaffold, type Violation } from './validate';

export interface AddNodeResult {
  ok: boolean;
  id?: string;
  error?: string;
  /** Campi obbligatori non ancora valorizzati: la lista di cose da fare. */
  missingRequired?: string[];
}

export interface OpResult {
  ok: boolean;
  error?: string;
}

export interface WorkflowSnapshot {
  name: string;
  description?: string;
  nodes: CanvasNode[];
  edges: WorkflowEdge[];
}

export class WorkflowBuilder {
  private readonly catalog: Map<string, NodeDef>;
  private nodes: CanvasNode[] = [];
  private edges: WorkflowEdge[] = [];
  private counter = 0;

  constructor(
    catalog: NodeDef[],
    public name = 'Nuovo workflow',
    public description?: string,
    seed?: { nodes: CanvasNode[]; edges: WorkflowEdge[] },
  ) {
    this.catalog = indexByDefId(catalog);
    if (seed) {
      // Modifica di un workflow esistente: si parte dal suo stato, così
      // l'agente lo legge prima di cambiarlo.
      this.nodes = seed.nodes.map((n) => ({ ...n, config: { ...n.config } }));
      this.edges = seed.edges.map((e) => ({ ...e }));
    }
  }

  addNode(defId: string, id?: string, config: Record<string, unknown> = {}): AddNodeResult {
    const def = this.catalog.get(defId);
    if (!def) {
      return { ok: false, error: `defId "${defId}" non esiste nel catalogo. Usa search_nodes.` };
    }
    const nodeId = this.uniqueId(id ?? defId);
    this.nodes.push({
      id: nodeId,
      defId,
      x: this.nodes.length * 220,
      y: 200,
      config: { ...config },
    });
    return { ok: true, id: nodeId, missingRequired: this.missingRequired(nodeId) };
  }

  connect(from: string, to: string, fromPort?: string): OpResult {
    if (!this.hasNode(from)) return { ok: false, error: `Il nodo "${from}" non esiste.` };
    if (!this.hasNode(to)) return { ok: false, error: `Il nodo "${to}" non esiste.` };
    if (from === to) return { ok: false, error: 'Un nodo non può essere collegato a sé stesso.' };

    const source = this.nodes.find((n) => n.id === from);
    const ports = source ? (this.catalog.get(source.defId)?.outputPorts ?? []) : [];
    if (fromPort && ports.length > 0 && !ports.includes(fromPort)) {
      return {
        ok: false,
        error: `La porta "${fromPort}" non esiste su "${from}". Valide: ${ports.join(' | ')}.`,
      };
    }
    const exists = this.edges.some(
      (e) => e.from === from && e.to === to && (e.fromPort ?? '') === (fromPort ?? ''),
    );
    if (exists) return { ok: false, error: 'Questo collegamento esiste già.' };

    this.edges.push({ from, to, ...(fromPort ? { fromPort } : {}) });
    return { ok: true };
  }

  setConfig(nodeId: string, config: Record<string, unknown>, merge = true): AddNodeResult {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) return { ok: false, error: `Il nodo "${nodeId}" non esiste.` };
    node.config = merge ? { ...node.config, ...config } : { ...config };
    return { ok: true, id: nodeId, missingRequired: this.missingRequired(nodeId) };
  }

  deleteNode(nodeId: string): OpResult {
    if (!this.hasNode(nodeId)) return { ok: false, error: `Il nodo "${nodeId}" non esiste.` };
    this.nodes = this.nodes.filter((n) => n.id !== nodeId);
    this.edges = this.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
    return { ok: true };
  }

  disconnect(from: string, to: string, fromPort?: string): OpResult {
    const before = this.edges.length;
    this.edges = this.edges.filter(
      (e) =>
        !(e.from === from && e.to === to && (fromPort === undefined || e.fromPort === fromPort)),
    );
    if (this.edges.length === before) {
      return { ok: false, error: `Nessun collegamento da "${from}" a "${to}".` };
    }
    return { ok: true };
  }

  /** Le stesse violazioni della generazione in un colpo: una sola autorità. */
  validate(): Violation[] {
    return validateScaffold(
      {
        name: this.name,
        reasoning: 'x'.repeat(60),
        nodes: this.nodes.map((n) => ({ id: n.id, defId: n.defId, config: n.config })),
        edges: this.edges.map((e) => ({
          from: e.from,
          to: e.to,
          ...(e.fromPort ? { fromPort: e.fromPort } : {}),
        })),
      },
      this.catalog,
    );
  }

  /**
   * Il giudizio sulla qualità, oltre alla correttezza formale.
   *
   * `validate()` dice se il workflow è ben formato; questo dice se
   * funzionerà. Sono due domande diverse e servono entrambe: un workflow può
   * avere ogni campo al posto giusto e contenere `smtp.example.com`.
   */
  quality(databases?: readonly QualityDatabase[]): QualityGateResult {
    return gateWorkflow({ nodes: this.nodes, edges: this.edges }, databases);
  }

  /** Nodi che non ricevono né emettono nulla: di solito è un pezzo dimenticato. */
  orphanNodes(): string[] {
    if (this.nodes.length <= 1) return [];
    const connected = new Set<string>();
    for (const e of this.edges) {
      connected.add(e.from);
      connected.add(e.to);
    }
    return this.nodes.filter((n) => !connected.has(n.id)).map((n) => n.id);
  }

  snapshot(): WorkflowSnapshot {
    return {
      name: this.name,
      ...(this.description ? { description: this.description } : {}),
      nodes: this.nodes.map((n) => ({ ...n, config: { ...n.config } })),
      edges: this.edges.map((e) => ({ ...e })),
    };
  }

  private hasNode(id: string): boolean {
    return this.nodes.some((n) => n.id === id);
  }

  private uniqueId(base: string): string {
    const clean =
      base
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/^[^a-z]+/, '') || 'node';
    if (!this.hasNode(clean)) return clean;
    this.counter++;
    let candidate = `${clean}_${this.counter}`;
    while (this.hasNode(candidate)) {
      this.counter++;
      candidate = `${clean}_${this.counter}`;
    }
    return candidate;
  }

  /** Obbligatori mancanti, esclusi quelli che l'utente sceglie da un menu. */
  private missingRequired(nodeId: string): string[] {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) return [];
    const def = this.catalog.get(node.defId);
    return (def?.configFields ?? [])
      .filter((f) => f.required && !isPickerField(f.type))
      .filter((f) => node.config[f.key] === undefined || node.config[f.key] === '')
      .map((f) => f.key);
  }
}
