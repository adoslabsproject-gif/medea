/**
 * La modifica proposta, mostrata prima di applicarla.
 *
 * Un riquadro «ho aggiunto 2 nodi» non basta a decidere: quello che serve
 * sapere è QUALI nodi e QUALI campi cambiano, e per i campi già compilati
 * cosa c'era prima. È l'unico modo per accettare una modifica senza doverla
 * poi ricontrollare tutta sul canvas.
 */

import { useState } from 'react';

import type { CanvasNode, WorkflowEdge } from '../types';

import { summarizePatch } from './diff';
import styles from './PatchDiff.module.css';
import type { NodeUpdate, PatchOps } from './types';

/** Oltre questa soglia si mostra un riassunto con «mostra tutti». */
const PREVIEW = 3;

interface Props {
  patch: PatchOps;
  applied?: boolean;
  onApply: () => void;
  onDismiss: () => void;
}

export function PatchDiff({ patch, applied, onApply, onDismiss }: Props) {
  return (
    <div className={styles.root}>
      <header className={styles.head}>
        <span className={styles.title}>{applied ? 'Modifica applicata' : 'Modifica proposta'}</span>
        <span className={styles.summary}>{summarizePatch(patch)}</span>
      </header>

      <div className={styles.body}>
        <Group title="Nodi aggiunti" tone="add" items={patch.addNodes} render={renderNode} />
        <Group title="Nodi rimossi" tone="remove" items={patch.removeNodes} render={renderNode} />
        <Group
          title="Nodi modificati"
          tone="change"
          items={patch.updateNodes}
          render={renderUpdate}
        />
        <Group
          title="Collegamenti aggiunti"
          tone="add"
          items={patch.addEdges}
          render={renderEdge}
        />
        <Group
          title="Collegamenti rimossi"
          tone="remove"
          items={patch.removeEdges}
          render={renderEdge}
        />
      </div>

      {!applied && (
        <footer className={styles.foot}>
          <button type="button" className={styles.dismiss} onClick={onDismiss}>
            Scarta
          </button>
          <button type="button" className={styles.apply} onClick={onApply}>
            Applica al canvas
          </button>
        </footer>
      )}
    </div>
  );
}

function Group<T>({
  title,
  tone,
  items,
  render,
}: {
  title: string;
  tone: 'add' | 'remove' | 'change';
  items: T[];
  render: (item: T, index: number) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const shown = expanded ? items : items.slice(0, PREVIEW);

  return (
    <section className={styles.group} data-tone={tone}>
      <h4 className={styles.groupTitle}>
        {title} <span className={styles.count}>{items.length}</span>
      </h4>
      <ul className={styles.items}>{shown.map((item, i) => render(item, i))}</ul>
      {items.length > PREVIEW && (
        <button
          type="button"
          className={styles.more}
          onClick={() => {
            setExpanded((v) => !v);
          }}
        >
          {expanded ? 'Mostra meno' : `Mostra altri ${String(items.length - PREVIEW)}`}
        </button>
      )}
    </section>
  );
}

function renderNode(node: CanvasNode) {
  const configured = Object.entries(node.config).filter(([, v]) => v !== undefined && v !== '');
  return (
    <li key={node.id} className={styles.item}>
      <span className={styles.itemName}>{node.label ?? node.id}</span>
      <code className={styles.itemId}>{node.defId}</code>
      {configured.length > 0 && (
        <span className={styles.itemMeta}>
          {configured
            .slice(0, 3)
            .map(([k]) => k)
            .join(', ')}
          {configured.length > 3 ? ` +${String(configured.length - 3)}` : ''}
        </span>
      )}
    </li>
  );
}

function renderUpdate(update: NodeUpdate) {
  return (
    <li key={update.id} className={styles.item}>
      <span className={styles.itemName}>{update.label}</span>
      <ul className={styles.changes}>
        {update.changes.map((c) => (
          <li key={c.key} className={styles.change}>
            <code className={styles.changeKey}>{c.key}</code>
            <span className={styles.before}>{c.before}</span>
            <span aria-hidden="true">→</span>
            <span className={styles.after}>{c.after}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}

function renderEdge(edge: WorkflowEdge, index: number) {
  return (
    <li key={`${edge.from}-${edge.to}-${String(index)}`} className={styles.item}>
      <span className={styles.itemName}>
        {edge.from} → {edge.to}
      </span>
      {edge.fromPort && <span className={styles.itemMeta}>ramo «{edge.fromPort}»</span>}
    </li>
  );
}
