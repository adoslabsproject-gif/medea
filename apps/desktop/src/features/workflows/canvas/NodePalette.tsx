/**
 * La palette dei nodi disponibili.
 *
 * La ricerca è la stessa che usa l'agente (`catalog.searchNodes`): scrivendo
 * «invia email» l'utente trova quello che troverebbe il modello. Sono 145
 * nodi — senza una ricerca decente sarebbero inutilizzabili, e senza la
 * stessa ricerca sarebbero due prodotti diversi.
 */

import { useMemo, useState } from 'react';

import { NODE_GROUPS, nodesByGroup, searchNodes, useCommunityNodes } from '../catalog';
import type { NodeDef } from '../types';

import { brandIconFor } from './brand-icons';
import { iconNameFor, resolveLucideIcon } from './icon-registry';
import styles from './NodePalette.module.css';

/** L'icona che vale per tutta una categoria, quando il nodo non ne ha una sua. */
const CATEGORY_ICON: Record<string, string> = {
  trigger: 'Zap',
  action: 'MousePointerClick',
  logic: 'GitBranchPlus',
  ai: 'Sparkles',
};

export interface InsertMode {
  /** Cosa sta per succedere, detto per esteso. */
  label: string;
  onCancel: () => void;
}

interface Props {
  onAdd: (def: NodeDef) => void;
  /** Quando c'è, il nodo scelto viene inserito su un collegamento invece
   *  che appoggiato accanto agli altri. */
  insertMode?: InsertMode;
}

export function NodePalette({ onAdd, insertMode }: Props) {
  const [query, setQuery] = useState('');
  const trimmed = query.trim();

  // I nodi aggiuntivi arrivano quando il motore risponde, non al primo
  // disegno: la palette deve accorgersene.
  const extra = useCommunityNodes();
  const results = useMemo(() => (trimmed ? searchNodes(trimmed) : null), [trimmed, extra]);
  const groups = useMemo(
    () =>
      NODE_GROUPS.map((g) => ({ ...g, nodes: nodesByGroup(g.id) })).filter(
        (g) => g.nodes.length > 0,
      ),
    [extra],
  );

  return (
    <aside className={styles.root} aria-label="Nodi disponibili">
      {insertMode && (
        <div className={styles.insertBanner} role="status">
          <span>{insertMode.label}</span>
          <button type="button" className={styles.insertCancel} onClick={insertMode.onCancel}>
            Annulla
          </button>
        </div>
      )}

      <div className={styles.searchRow}>
        <input
          type="search"
          className={styles.search}
          placeholder="Cerca un nodo…"
          aria-label="Cerca fra i nodi disponibili"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
      </div>

      <div className={styles.list}>
        {results ? (
          results.length > 0 ? (
            <ul className={styles.items}>
              {results.map((def) => (
                <NodeItem key={def.defId} def={def} onAdd={onAdd} />
              ))}
            </ul>
          ) : (
            <p className={styles.empty}>Nessun nodo per «{trimmed}».</p>
          )
        ) : (
          groups.map((g) => (
            <section key={g.id} className={styles.group}>
              <h3 className={styles.groupTitle}>
                {g.label} <span className={styles.count}>{g.nodes.length}</span>
              </h3>
              <ul className={styles.items}>
                {g.nodes.map((def) => (
                  <NodeItem key={def.defId} def={def} onAdd={onAdd} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </aside>
  );
}

function NodeItem({ def, onAdd }: { def: NodeDef; onAdd: (d: NodeDef) => void }) {
  // Le stesse icone del canvas: un nodo si riconosce nella palette e si
  // ritrova uguale una volta messo giù.
  // Se il nodo non dichiara un'icona e non ce n'è una per il suo defId, si
  // ripiega su quella della categoria: un puntino non dice niente.
  const Icon =
    resolveLucideIcon(iconNameFor(def.defId, def.icon)) ??
    resolveLucideIcon(CATEGORY_ICON[def.type] ?? 'Hash');
  const brand = brandIconFor(def.defId);

  return (
    <li>
      <button
        type="button"
        className={styles.item}
        data-type={def.type}
        title={def.description ?? def.defId}
        onClick={() => {
          onAdd(def);
        }}
      >
        <span className={styles.itemIcon} aria-hidden="true">
          {brand ? (
            <svg viewBox="0 0 24 24" width={14} height={14} fill={brand.bg}>
              <path d={brand.svg} />
            </svg>
          ) : Icon ? (
            <Icon size={14} strokeWidth={2} />
          ) : null}
        </span>
        <span className={styles.itemBody}>
          <span className={styles.itemLabel}>{def.label}</span>
          <span className={styles.itemId}>{def.defId}</span>
        </span>
      </button>
    </li>
  );
}
