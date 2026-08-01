/**
 * «Questo workflow scrive su tabelle che non esistono.»
 *
 * Un nodo `db_insert` nomina una tabella e le sue colonne. Finora nessuno
 * guardava: il workflow si salvava, si attivava, e falliva alla prima
 * esecuzione con un «no such table» che non dice niente a chi l'ha disegnato.
 *
 * Le tabelle si creano premendo, non da sole: sono una modifica a un archivio,
 * e in Medea nessuna modifica avviene senza che qualcuno la chieda.
 */

import { useEffect, useMemo, useState } from 'react';

import {
  createTables,
  existingTables,
  missingTables,
  planTables,
  workingDatabase,
} from '../runtime';
import type { PlannedTable } from '../runtime';
import type { Workflow } from '../types';

import styles from './TablesBanner.module.css';

interface Props {
  workflow: Workflow;
}

type State =
  | { kind: 'checking' }
  | { kind: 'none' }
  | { kind: 'missing'; tables: PlannedTable[] }
  | { kind: 'creating'; tables: PlannedTable[] }
  | { kind: 'done'; created: string[] }
  | { kind: 'failed'; message: string };

export function TablesBanner({ workflow }: Props) {
  const [state, setState] = useState<State>({ kind: 'checking' });

  const planned = useMemo(() => planTables(workflow), [workflow]);
  // La firma del piano, non l'oggetto: l'editor ricrea il workflow a ogni
  // tasto premuto, e senza questo si interrogherebbe il runtime a ogni
  // battuta invece che quando cambia davvero qualcosa.
  const signature = planned
    .map((t) => `${t.name}:${t.columns.map((c) => c.name).join('|')}`)
    .join(';');

  useEffect(() => {
    if (planned.length === 0) {
      setState({ kind: 'none' });
      return;
    }

    // Letto da una funzione: altrimenti il compilatore dà per scontato che il
    // valore resti quello del primo controllo.
    const gone = new AbortController();
    const abbandonato = () => gone.signal.aborted;

    void (async () => {
      try {
        const databaseId = await workingDatabase();
        const missing = missingTables(planned, await existingTables(databaseId));
        if (abbandonato()) return;
        setState(missing.length > 0 ? { kind: 'missing', tables: missing } : { kind: 'none' });
      } catch (e) {
        if (abbandonato()) return;
        setState({ kind: 'failed', message: e instanceof Error ? e.message : String(e) });
      }
    })();

    return () => {
      gone.abort();
    };
    // `planned` deriva da `signature`: rimetterlo qui rifarebbe il giro a ogni
    // ridisegno.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  if (state.kind === 'none' || state.kind === 'checking') return null;

  if (state.kind === 'done') {
    return (
      <p className={`${styles.root} ${styles.done}`}>Tabelle create: {state.created.join(', ')}.</p>
    );
  }

  if (state.kind === 'failed') {
    return (
      <p className={`${styles.root} ${styles.failed}`}>
        Non sono riuscito a controllare le tabelle: {state.message}
      </p>
    );
  }

  const busy = state.kind === 'creating';

  return (
    <section className={styles.root}>
      <div className={styles.text}>
        <h3 className={styles.title}>Servono delle tabelle</h3>
        <p className={styles.body}>
          Questo workflow scrive su {state.tables.length === 1 ? 'una tabella' : 'tabelle'} che non
          esiste ancora. Senza, fallisce alla prima esecuzione.
        </p>
        <ul className={styles.list}>
          {state.tables.map((table) => (
            <li key={table.name}>
              <code>{table.name}</code>{' '}
              <span className={styles.columns}>
                ({table.columns.map((c) => c.name).join(', ')})
              </span>
            </li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        className={styles.create}
        disabled={busy}
        onClick={() => {
          const tables = state.tables;
          setState({ kind: 'creating', tables });
          void createTables(tables).then((report) => {
            setState(
              report.problems.length > 0
                ? { kind: 'failed', message: report.problems.join(' · ') }
                : { kind: 'done', created: report.created },
            );
          });
        }}
      >
        {busy ? 'Creo…' : 'Creale'}
      </button>
    </section>
  );
}
