/**
 * Cosa è stato costruito, in ordine di esecuzione.
 *
 * La schermata del verdetto diceva «3 nodi · 2 collegamenti» e nient'altro: un
 * numero, il nome, gli eventuali problemi. Dei nodi non se ne vedeva nemmeno
 * uno. Il 2026-08-04 un workflow generato correttamente — verdetto «si può
 * attivare così com'è» — è stato letto come «non ha creato nulla», ed era una
 * lettura giusta: di creato non si vedeva niente.
 *
 * Contare le cose non è mostrarle. Qui si legge la catena come la si
 * racconterebbe a voce: cosa la fa partire, cosa succede dopo, dove finisce.
 *
 * @module features/workflows/wizard/AnteprimaFlusso
 */

import type { CanvasNode, WorkflowEdge } from '../types';

import styles from './AnteprimaFlusso.module.css';

interface Props {
  nodes: readonly CanvasNode[];
  edges: readonly WorkflowEdge[];
}

/** Il simbolo che dice a colpo d'occhio che genere di passo è. */
function simbolo(defId: string): string {
  if (defId.startsWith('trigger_')) return '▶';
  if (defId.startsWith('logic_')) return '◆';
  if (defId.startsWith('db_')) return '▤';
  if (defId.startsWith('agent_')) return '✦';
  return '●';
}

/**
 * I nodi nell'ordine in cui verranno eseguiti.
 *
 * Si parte da chi non ha nessuno che lo precede — il trigger — e si segue la
 * catena. Quelli irraggiungibili si mettono in fondo invece di sparire: un
 * nodo scollegato è proprio la cosa che vale la pena vedere.
 */
function inOrdineDiEsecuzione(
  nodes: readonly CanvasNode[],
  edges: readonly WorkflowEdge[],
): CanvasNode[] {
  const perId = new Map(nodes.map((n) => [n.id, n]));
  const haPredecessore = new Set(edges.map((e) => e.to));
  const ordinati: CanvasNode[] = [];
  const visti = new Set<string>();

  const cammina = (id: string) => {
    if (visti.has(id)) return;
    const nodo = perId.get(id);
    if (!nodo) return;
    visti.add(id);
    ordinati.push(nodo);
    for (const e of edges.filter((x) => x.from === id)) cammina(e.to);
  };

  for (const n of nodes) if (!haPredecessore.has(n.id)) cammina(n.id);
  for (const n of nodes) if (!visti.has(n.id)) ordinati.push(n);
  return ordinati;
}

export function AnteprimaFlusso({ nodes, edges }: Props) {
  if (nodes.length === 0) return null;
  const ordinati = inOrdineDiEsecuzione(nodes, edges);
  const collegati = new Set([...edges.map((e) => e.from), ...edges.map((e) => e.to)]);

  return (
    <ol className={styles.lista}>
      {ordinati.map((nodo, i) => (
        <li key={nodo.id} className={styles.passo}>
          <span className={styles.simbolo} aria-hidden="true">
            {simbolo(nodo.defId)}
          </span>
          <span className={styles.testo}>
            <span className={styles.titolo}>{nodo.label ?? nodo.name ?? nodo.id}</span>
            <code className={styles.tipo}>{nodo.defId}</code>
          </span>
          {/* Un nodo che non è appeso a niente non verrà mai eseguito: dirlo
              qui evita di scoprirlo dopo averlo attivato. */}
          {!collegati.has(nodo.id) && nodes.length > 1 && (
            <span className={styles.scollegato}>non collegato</span>
          )}
          {i < ordinati.length - 1 && (
            <span className={styles.freccia} aria-hidden="true">
              ↓
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
