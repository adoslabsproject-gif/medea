/**
 * WorkflowBuilder — stato di costruzione INCREMENTALE di un workflow (#3).
 *
 * È la "lavagna" su cui l'agente (loop.ts) costruisce il workflow un pezzo alla
 * volta tramite i tool (tools.ts): aggiunge nodi, li collega, ne imposta la
 * config. Ogni operazione dà FEEDBACK IMMEDIATO (defId valido? config valida?)
 * così il modello si corregge sul posto — esattamente come farei io: non sparo
 * un JSON alla cieca, aggiungo un nodo, controllo, collego, ricontrollo.
 *
 * La validità è delegata alla FONTE UNICA del catalog (catalog-spec +
 * catalog-validator): impossibile che il builder e la grammatica/validatore
 * divergano.
 *
 * Stato per-richiesta, single-thread → muta in-place (niente concorrenza).
 *
 * @module services/workflow-agent/state
 */
import { buildCatalogSpec, type NodeConfigSpec } from '@/services/ai-scaffold/catalog-spec.js';
import {
  validateNodesAgainstCatalog,
  describeViolation,
  type CatalogViolation,
} from '@/services/ai-scaffold/catalog-validator.js';
import type { NodeCatalogEntry } from '@/services/ai-scaffold/node-catalog.js';

export interface BuildNode {
  id: string;
  defId: string;
  config: Record<string, unknown>;
}
export interface BuildEdge {
  from: string;
  to: string;
  fromPort?: string;
}
export interface WorkflowSnapshot {
  nodes: BuildNode[];
  edges: BuildEdge[];
}

export interface OpResult {
  ok: boolean;
  /** Messaggio leggibile (successo o errore) da ridare al modello. */
  message: string;
  /** Violazioni di catalog sul nodo toccato (warning: il nodo è comunque
   *  aggiunto, il modello può correggere con set_config). */
  warnings?: string[];
}

/** Genera un id univoco a partire dal defId (strip prefisso + slug + counter). */
function deriveId(defId: string, taken: Set<string>): string {
  const base = defId.replace(/^(action|trigger|logic|ai|agent|flow|db|community)_/u, '') || defId;
  let candidate = base;
  let i = 1;
  while (taken.has(candidate)) {
    i++;
    candidate = `${base}_${i.toString()}`;
  }
  return candidate;
}

export class WorkflowBuilder {
  private readonly spec: Map<string, NodeConfigSpec>;
  private readonly nodes = new Map<string, BuildNode>();
  private readonly edges: BuildEdge[] = [];
  /**
   * defId dei nodi CUSTOM PRE-ESISTENTI (creati nell'IDE, fuori catalog) trovati
   * al seed. Sono realtà legittima, NON errori: il catalog-validator li
   * segnalerebbe `unknown_def`, ma sarebbe un falso allarme su un nodo che
   * l'utente non ha chiesto di toccare. `validate()` li ESCLUDE da unknown_def.
   * NB: `addNode` resta strict (il modello non può inventarli ex-novo).
   */
  private readonly seededCustomDefIds = new Set<string>();

  constructor(catalog: NodeCatalogEntry[]) {
    this.spec = buildCatalogSpec(catalog);
  }

  /** Violazioni di catalog per UN nodo (config). */
  private nodeWarnings(node: BuildNode): string[] {
    return validateNodesAgainstCatalog([node], this.spec).map(describeViolation);
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }
  knownDefId(defId: string): boolean {
    return this.spec.has(defId);
  }

  /** Aggiunge un nodo. defId DEVE esistere nel catalog. id auto-generato se
   *  assente; collisione di id → errore (il modello scelga un altro id). */
  addNode(
    defId: string,
    requestedId: string | undefined,
    config: Record<string, unknown>,
  ): OpResult {
    if (!this.spec.has(defId)) {
      return {
        ok: false,
        message: `defId "${defId}" non esiste nel catalogo. Usa search_nodes per trovare il nodo giusto.`,
      };
    }
    let id = requestedId?.trim();
    if (id && this.nodes.has(id)) {
      return { ok: false, message: `Esiste già un nodo con id "${id}". Scegli un id diverso.` };
    }
    if (!id) id = deriveId(defId, new Set(this.nodes.keys()));
    const node: BuildNode = { id, defId, config };
    this.nodes.set(id, node);
    const warnings = this.nodeWarnings(node);
    return {
      ok: true,
      message: `Nodo "${id}" (${defId}) aggiunto.${warnings.length > 0 ? ' Attenzione: completa la config.' : ''}`,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /**
   * Seeda il builder col workflow ESISTENTE (read-before-edit per la modifica).
   * Inserisce i nodi/edge SENZA validazione di catalog: è la realtà già salvata,
   * non una proposta del modello — i nodi CUSTOM (defId fuori catalog, creati
   * nell'IDE) vanno preservati, non rifiutati. Le mutazioni successive del modello
   * (addNode/connect) restano invece strict. Idempotente per id (l'ultimo vince).
   */
  seed(snapshot: WorkflowSnapshot): void {
    for (const n of snapshot.nodes) {
      this.nodes.set(n.id, { id: n.id, defId: n.defId, config: { ...n.config } });
      if (!this.spec.has(n.defId)) this.seededCustomDefIds.add(n.defId);
    }
    for (const e of snapshot.edges) {
      if (this.edges.some((x) => x.from === e.from && x.to === e.to && x.fromPort === e.fromPort))
        continue;
      this.edges.push({ from: e.from, to: e.to, ...(e.fromPort ? { fromPort: e.fromPort } : {}) });
    }
  }

  /** Collega due nodi esistenti. */
  connect(from: string, to: string, fromPort?: string): OpResult {
    if (!this.nodes.has(from)) return { ok: false, message: `Nodo "from"="${from}" inesistente.` };
    if (!this.nodes.has(to)) return { ok: false, message: `Nodo "to"="${to}" inesistente.` };
    if (this.edges.some((e) => e.from === from && e.to === to && e.fromPort === fromPort)) {
      return { ok: false, message: `Collegamento ${from}→${to} già presente.` };
    }
    this.edges.push({ from, to, ...(fromPort ? { fromPort } : {}) });
    return { ok: true, message: `Collegato ${from} → ${to}.` };
  }

  /**
   * Rimuove un nodo esistente E gli edge che lo toccano (in entrata/uscita) —
   * niente edge orfani. Riporta quanti edge sono caduti così il modello lo sa.
   */
  deleteNode(id: string): OpResult {
    if (!this.nodes.has(id))
      return { ok: false, message: `Nodo "${id}" inesistente: niente da rimuovere.` };
    this.nodes.delete(id);
    const before = this.edges.length;
    for (let i = this.edges.length - 1; i >= 0; i--) {
      const e = this.edges[i]!;
      if (e.from === id || e.to === id) this.edges.splice(i, 1);
    }
    const dropped = before - this.edges.length;
    return {
      ok: true,
      message: `Nodo "${id}" rimosso${dropped > 0 ? ` (e ${dropped.toString()} collegamento/i)` : ''}.`,
    };
  }

  /** Rimuove un collegamento esistente (from → to, eventualmente su fromPort). */
  disconnect(from: string, to: string, fromPort?: string): OpResult {
    const idx = this.edges.findIndex(
      (e) => e.from === from && e.to === to && e.fromPort === fromPort,
    );
    if (idx < 0)
      return {
        ok: false,
        message: `Collegamento ${from}→${to} inesistente: niente da scollegare.`,
      };
    this.edges.splice(idx, 1);
    return { ok: true, message: `Scollegato ${from} → ${to}.` };
  }

  /** Imposta/fonde la config di un nodo esistente. */
  setConfig(nodeId: string, config: Record<string, unknown>, merge: boolean): OpResult {
    const node = this.nodes.get(nodeId);
    if (!node) return { ok: false, message: `Nodo "${nodeId}" inesistente.` };
    node.config = merge ? { ...node.config, ...config } : config;
    const warnings = this.nodeWarnings(node);
    return {
      ok: true,
      message: `Config di "${nodeId}" aggiornata.`,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /**
   * Tutte le violazioni di catalog. Esclude `unknown_def` sui nodi CUSTOM
   * PRE-ESISTENTI (seedati): sono legittimi (creati nell'IDE), non errori da
   * mostrare all'utente né da far "riparare" al modello. Tutte le altre
   * violazioni (anche su nodi nuovi) restano.
   */
  validate(): CatalogViolation[] {
    const all = validateNodesAgainstCatalog([...this.nodes.values()], this.spec);
    if (this.seededCustomDefIds.size === 0) return all;
    return all.filter((v) => !(v.kind === 'unknown_def' && this.seededCustomDefIds.has(v.defId)));
  }

  /** Edge che referenziano nodi inesistenti (controllo strutturale). */
  orphanEdges(): BuildEdge[] {
    return this.edges.filter((e) => !this.nodes.has(e.from) || !this.nodes.has(e.to));
  }

  snapshot(): WorkflowSnapshot {
    return {
      nodes: [...this.nodes.values()].map((n) => ({
        id: n.id,
        defId: n.defId,
        config: { ...n.config },
      })),
      edges: this.edges.map((e) => ({ ...e })),
    };
  }

  get nodeCount(): number {
    return this.nodes.size;
  }
}
