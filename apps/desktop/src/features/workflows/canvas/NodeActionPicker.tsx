/**
 * «Cosa deve fare questo nodo?»
 *
 * Un pacchetto di comunità — Telegram, PDF4Me — è **un** nodo che dichiara
 * fino a settantacinque operazioni. Senza questo, quei nodi si trascinano sul
 * disegno e restano muti: nessun modo di dire quale delle settantacinque.
 *
 * Con quei numeri una lista piatta non serve: si cerca. E quando non si cerca,
 * i gruppi dichiarati dal pacchetto danno almeno un ordine in cui guardare.
 */

import { useMemo, useState } from 'react';

import type { NodeAction, NodeDef } from '../types';

import { ACTION_KEY, currentAction, groupActions } from './node-actions';
import styles from './NodeActionPicker.module.css';

interface Props {
  def: NodeDef;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}

/** Quante operazioni bastano perché cercare valga più che scorrere. */
const SOGLIA_RICERCA = 8;

export function NodeActionPicker({ def, config, onChange }: Props) {
  const [query, setQuery] = useState('');
  // In un `useMemo` a sé: senza, l'espressione crea un array nuovo a ogni
  // disegno e il raggruppamento si rifà anche quando nulla è cambiato.
  const actions = useMemo(() => def.actions ?? [], [def.actions]);
  const scelta = currentAction(def, config);
  const gruppi = useMemo(() => groupActions(actions, query), [actions, query]);

  const scegli = (action: NodeAction) => {
    // Cambiare operazione non cancella quello che si era scritto: i campi
    // condivisi restano, e se si torna indietro il lavoro è ancora lì.
    onChange({ ...config, [ACTION_KEY]: action.id });
  };

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <span className={styles.label}>Operazione</span>
        <span className={styles.count}>
          {actions.length === 1 ? '1 disponibile' : `${String(actions.length)} disponibili`}
        </span>
      </div>

      {actions.length > SOGLIA_RICERCA && (
        <input
          className={styles.search}
          type="search"
          placeholder="Cerca fra le operazioni…"
          aria-label="Cerca fra le operazioni"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
      )}

      <div className={styles.list} role="listbox" aria-label="Operazioni del nodo">
        {gruppi.length === 0 && <p className={styles.empty}>Nessuna operazione con questo nome.</p>}

        {gruppi.map((gruppo) => (
          <div key={gruppo.label || '—'} className={styles.group}>
            {gruppo.label && <span className={styles.groupLabel}>{gruppo.label}</span>}
            {gruppo.actions.map((action) => (
              <button
                key={action.id}
                type="button"
                role="option"
                aria-selected={action.id === scelta?.id}
                className={styles.action}
                data-on={action.id === scelta?.id ? 'true' : 'false'}
                onClick={() => {
                  scegli(action);
                }}
              >
                <span className={styles.actionTop}>
                  {action.aiAction && (
                    <span className={styles.ai} title="Si appoggia a un modello">
                      ✨
                    </span>
                  )}
                  <span className={styles.actionLabel}>{action.label ?? action.id}</span>
                </span>
                {action.description && (
                  <span className={styles.actionHint}>{action.description}</span>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
