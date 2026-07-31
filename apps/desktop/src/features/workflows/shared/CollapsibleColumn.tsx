/**
 * Una colonna laterale che rientra: da sola quando lo spazio manca, o con un
 * click quando dà fastidio.
 *
 * È il comportamento giusto per l'elenco dei workflow e per il chatter, che
 * servono a momenti e non sempre. Ridimensionarle a mano ogni volta è lavoro
 * che l'utente non dovrebbe fare — e una colonna allargata per sbaglio non
 * deve diventare un problema da risolvere.
 *
 * Rientrata, resta una striscia con l'icona: si riapre da lì, e si vede che
 * c'è. Sparire del tutto vorrebbe dire non farla ritrovare.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import styles from './CollapsibleColumn.module.css';

interface Props {
  /** Dove ricordare se era aperta o chiusa. */
  storageKey: string;
  width: number;
  /** Sotto questa larghezza di finestra la colonna rientra da sola. */
  autoCollapseUnder?: number;
  side: 'start' | 'end';
  /** Cosa mostrare sulla striscia quando è rientrata. */
  icon: ReactNode;
  label: string;
  children: ReactNode;
}

export function CollapsibleColumn({
  storageKey,
  width,
  autoCollapseUnder = 1100,
  side,
  icon,
  label,
  children,
}: Props) {
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(storageKey) === 'collapsed',
  );
  /** Vero quando è rientrata perché lo spazio manca, non perché l'ha chiesto
   *  l'utente: quando lo spazio torna, torna aperta. */
  const auto = useRef(false);

  useEffect(() => {
    const check = () => {
      const tight = window.innerWidth < autoCollapseUnder;
      if (tight && !collapsed) {
        auto.current = true;
        setCollapsed(true);
      } else if (!tight && collapsed && auto.current) {
        auto.current = false;
        setCollapsed(false);
      }
    };
    check();
    window.addEventListener('resize', check);
    return () => {
      window.removeEventListener('resize', check);
    };
  }, [collapsed, autoCollapseUnder]);

  const toggle = () => {
    const next = !collapsed;
    // Una scelta esplicita vince sulla larghezza della finestra: se l'utente
    // la chiude, non deve riaprirsi da sola al primo ridimensionamento.
    auto.current = false;
    setCollapsed(next);
    localStorage.setItem(storageKey, next ? 'collapsed' : 'open');
  };

  if (collapsed) {
    return (
      <button
        type="button"
        className={styles.strip}
        data-side={side}
        title={`Apri ${label.toLowerCase()}`}
        aria-label={`Apri ${label.toLowerCase()}`}
        aria-expanded={false}
        onClick={toggle}
      >
        <span className={styles.stripIcon} aria-hidden="true">
          {icon}
        </span>
        <span className={styles.stripLabel}>{label}</span>
      </button>
    );
  }

  return (
    <div className={styles.column} data-side={side} style={{ inlineSize: `${String(width)}px` }}>
      <button
        type="button"
        className={styles.collapse}
        data-side={side}
        title={`Riduci ${label.toLowerCase()}`}
        aria-label={`Riduci ${label.toLowerCase()}`}
        aria-expanded
        onClick={toggle}
      >
        {side === 'start' ? '‹' : '›'}
      </button>
      {children}
    </div>
  );
}
