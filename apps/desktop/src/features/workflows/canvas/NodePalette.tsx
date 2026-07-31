/**
 * La palette dei nodi disponibili.
 *
 * La ricerca è la stessa che usa l'agente (`catalog.searchNodes`): scrivendo
 * «invia email» l'utente trova quello che troverebbe il modello. Sono 145
 * nodi — senza una ricerca decente sarebbero inutilizzabili, e senza la
 * stessa ricerca sarebbero due prodotti diversi.
 */

import { useMemo, useState } from 'react';

import { NODE_GROUPS, nodesByGroup, searchNodes } from '../catalog';
import type { NodeDef } from '../types';

import styles from './NodePalette.module.css';

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

  const results = useMemo(() => (trimmed ? searchNodes(trimmed) : null), [trimmed]);
  const groups = useMemo(
    () =>
      NODE_GROUPS.map((g) => ({ ...g, nodes: nodesByGroup(g.id) })).filter(
        (g) => g.nodes.length > 0,
      ),
    [],
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
        <span className={styles.itemLabel}>{def.label}</span>
        <span className={styles.itemId}>{def.defId}</span>
      </button>
    </li>
  );
}
