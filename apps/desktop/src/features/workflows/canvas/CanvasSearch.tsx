/**
 * Trovare un nodo su un canvas grande.
 *
 * Con quindici nodi si guarda; con quaranta si cerca. Cmd+F apre la casella,
 * si scrive un pezzo del nome e la vista si sposta sul nodo: le frecce
 * passano da un risultato all'altro, Invio lo seleziona e apre il pannello.
 *
 * Cerca per nome e per tipo di nodo, perché a volte si ricorda l'uno e a
 * volte l'altro: «riepilogo» e «send_email» devono trovare la stessa cosa.
 */

import { useReactFlow } from '@xyflow/react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { CanvasNode, NodeDef } from '../types';

import styles from './CanvasSearch.module.css';

interface Props {
  nodes: readonly CanvasNode[];
  defsById: ReadonlyMap<string, NodeDef>;
  onClose: () => void;
  onSelect: (nodeId: string) => void;
}

export function CanvasSearch({ nodes, defsById, onClose, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const { setCenter } = useReactFlow();
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return nodes.filter((n) => {
      const def = defsById.get(n.defId);
      const hay = [n.id, n.label ?? '', def?.label ?? '', n.defId].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [query, nodes, defsById]);

  const current = matches[Math.min(index, matches.length - 1)];

  // Muoversi fra i risultati sposta la vista: cercare senza vedere dove si
  // finisce non serve a niente.
  useEffect(() => {
    if (!current) return;
    // `setCenter` restituisce una promessa che si risolve a fine
    // animazione: qui non serve aspettarla.
    void setCenter(current.x + 70, current.y + 60, { zoom: 1, duration: 300 });
  }, [current, setCenter]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const step = (delta: number) => {
    if (matches.length === 0) return;
    setIndex((i) => (i + delta + matches.length) % matches.length);
  };

  return (
    <div className={styles.root} role="search">
      <input
        ref={inputRef}
        type="search"
        className={styles.input}
        placeholder="Trova un nodo…"
        aria-label="Trova un nodo sul canvas"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (current) onSelect(current.id);
            // Maiusc+Invio va al precedente: la convenzione di ogni ricerca.
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            step(1);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            step(-1);
          }
        }}
      />

      <span className={styles.count}>
        {query.trim() === ''
          ? `${String(nodes.length)} nodi`
          : matches.length === 0
            ? 'nessuno'
            : `${String(Math.min(index, matches.length - 1) + 1)} di ${String(matches.length)}`}
      </span>

      <button
        type="button"
        className={styles.nav}
        aria-label="Risultato precedente"
        disabled={matches.length === 0}
        onClick={() => {
          step(-1);
        }}
      >
        ↑
      </button>
      <button
        type="button"
        className={styles.nav}
        aria-label="Risultato successivo"
        disabled={matches.length === 0}
        onClick={() => {
          step(1);
        }}
      >
        ↓
      </button>
      <button type="button" className={styles.nav} aria-label="Chiudi la ricerca" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}
