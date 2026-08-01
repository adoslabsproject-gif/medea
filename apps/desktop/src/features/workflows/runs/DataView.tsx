/**
 * Quello che un nodo ha prodotto, in un modo che si legge.
 *
 * Tre viste sugli stessi dati, e si sceglie quella che serve adesso:
 *
 *   ALBERO   un ramo alla volta. Ogni foglia sa dire l'espressione che la
 *            raggiunge — che è la domanda vera davanti a un'uscita: «come ci
 *            arrivo da un altro nodo?»
 *   TABELLA  per gli array di oggetti. Cinquanta righe di JSON diventano una
 *            tabella che si legge in un colpo. Compare solo se ha senso.
 *   GREZZO   il JSON com'è, per quando si vuole copiare tutto.
 */

import { useState } from 'react';

import { asTable, cell, childrenOf, summarize, type Ramo } from './data-view';
import styles from './DataView.module.css';

interface Props {
  /** Il testo che il motore ha registrato: JSON, o quello che è. */
  text: string;
  /** Da dove partono le espressioni copiabili, es. `$node.tizio.json`. */
  basePath?: string;
}

type Vista = 'albero' | 'tabella' | 'grezzo';

export function DataView({ text, basePath }: Props) {
  const [vista, setVista] = useState<Vista>('albero');
  const [copiato, setCopiato] = useState<string | null>(null);

  let valore: unknown;
  let leggibile = true;
  try {
    valore = JSON.parse(text);
  } catch {
    leggibile = false;
  }

  // Quello che non è JSON si mostra e basta: fingere un albero su del testo
  // libero sarebbe una struttura inventata.
  if (!leggibile) return <pre className={styles.raw}>{text}</pre>;

  const tabella = asTable(valore);
  const copia = (path: string) => {
    void navigator.clipboard.writeText(`{{${path}}}`).then(() => {
      setCopiato(path);
      setTimeout(() => {
        setCopiato(null);
      }, 1500);
    });
  };

  return (
    <div className={styles.root}>
      <div className={styles.tabs} role="tablist">
        <ViewTab id="albero" active={vista} onSelect={setVista} label="Albero" />
        {tabella && <ViewTab id="tabella" active={vista} onSelect={setVista} label="Tabella" />}
        <ViewTab id="grezzo" active={vista} onSelect={setVista} label="Grezzo" />
      </div>

      {vista === 'albero' && (
        <ul className={styles.tree}>
          {childrenOf(valore, basePath ?? '').map((ramo) => (
            <TreeRow
              key={ramo.path}
              ramo={ramo}
              depth={0}
              copiabile={Boolean(basePath)}
              copiato={copiato}
              onCopy={copia}
            />
          ))}
        </ul>
      )}

      {vista === 'tabella' && tabella && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {tabella.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tabella.rows.map((riga, i) => (
                <tr key={i}>
                  {tabella.columns.map((c) => (
                    <td key={c}>{cell(riga[c])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {vista === 'grezzo' && <pre className={styles.raw}>{JSON.stringify(valore, null, 2)}</pre>}
    </div>
  );
}

function ViewTab({
  id,
  active,
  onSelect,
  label,
}: {
  id: Vista;
  active: Vista;
  onSelect: (v: Vista) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active === id}
      className={styles.tab}
      data-on={active === id ? 'true' : 'false'}
      onClick={() => {
        onSelect(id);
      }}
    >
      {label}
    </button>
  );
}

function TreeRow({
  ramo,
  depth,
  copiabile,
  copiato,
  onCopy,
}: {
  ramo: Ramo;
  depth: number;
  copiabile: boolean;
  copiato: string | null;
  onCopy: (path: string) => void;
}) {
  // I primi due livelli aperti: è dove sta quasi sempre quello che si cerca,
  // e aprirli a mano ogni volta sarebbe un lavoro inutile.
  const [open, setOpen] = useState(depth < 1);
  const apribile = ramo.kind === 'oggetto' || ramo.kind === 'lista';
  const figli = open && apribile ? childrenOf(ramo.value, ramo.path) : [];

  return (
    <li className={styles.node}>
      <div className={styles.row} style={{ paddingInlineStart: `${String(depth * 12)}px` }}>
        <button
          type="button"
          className={styles.twist}
          disabled={!apribile}
          aria-expanded={apribile ? open : undefined}
          onClick={() => {
            setOpen((v) => !v);
          }}
        >
          {apribile ? (open ? '▾' : '▸') : '·'}
        </button>

        <span className={styles.key}>{ramo.key}</span>
        <span className={styles.value} data-kind={ramo.kind}>
          {summarize(ramo.value, ramo.kind, ramo.size)}
        </span>

        {/* L'espressione che raggiunge QUESTO valore: è la ragione per cui si
            guarda un'uscita, e copiarla a mano dal percorso è dove si sbaglia. */}
        {copiabile && (
          <button
            type="button"
            className={styles.copy}
            title={`Copia {{${ramo.path}}}`}
            onClick={() => {
              onCopy(ramo.path);
            }}
          >
            {copiato === ramo.path ? '✓' : '⧉'}
          </button>
        )}
      </div>

      {figli.length > 0 && (
        <ul className={styles.children}>
          {figli.map((figlio) => (
            <TreeRow
              key={figlio.path}
              ramo={figlio}
              depth={depth + 1}
              copiabile={copiabile}
              copiato={copiato}
              onCopy={onCopy}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
