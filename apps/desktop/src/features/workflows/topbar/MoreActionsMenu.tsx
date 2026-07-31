/**
 * Le azioni che non stanno nella barra.
 *
 * Un menu raggruppato invece di dieci pulsanti in fila: la barra deve
 * mostrare quello che si usa sempre — salva, attiva, assistente — e tenere
 * il resto a un click di distanza, ordinato per argomento.
 */

import { useEffect, useRef, useState } from 'react';

import styles from './MoreActionsMenu.module.css';

export interface MenuItem {
  label: string;
  hint?: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSelect: () => void;
}

export interface MenuGroup {
  label: string;
  items: MenuItem[];
}

interface Props {
  groups: MenuGroup[];
}

export function MoreActionsMenu({ groups }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Un menu che resta aperto quando si clicca altrove è un menu che copre
  // quello che l'utente sta guardando.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Altre azioni"
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        ⋯
      </button>

      {open && (
        <div className={styles.menu} role="menu">
          {groups.map((group) => (
            <div key={group.label} className={styles.group}>
              <span className={styles.groupLabel}>{group.label}</span>
              {group.items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  className={styles.item}
                  data-danger={item.danger ? 'true' : undefined}
                  disabled={item.disabled}
                  title={item.disabled ? item.disabledReason : item.hint}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                >
                  {item.icon && (
                    <span className={styles.icon} aria-hidden="true">
                      {item.icon}
                    </span>
                  )}
                  <span className={styles.itemBody}>
                    <span className={styles.itemLabel}>{item.label}</span>
                    {item.hint && <span className={styles.itemHint}>{item.hint}</span>}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
