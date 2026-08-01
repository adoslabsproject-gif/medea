/**
 * Gli elenchi veri dietro i campi che si scelgono invece di scrivere.
 *
 * Finora quei campi erano caselle di testo con un segnaposto e la promessa
 * che «l'elenco arriverà quando ci sarà il runtime». Il runtime c'è: i
 * database, le loro tabelle, i workflow e i segreti si possono chiedere, e
 * scriverli a memoria è il modo più facile di sbagliare un nome.
 *
 * Ogni elenco è indipendente e fallisce da solo: se il motore non risponde,
 * il campo torna scrivibile a mano invece di bloccare la configurazione. Un
 * elenco che non si carica non deve impedire di lavorare.
 */

import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

import { workflowApi } from './api';
import { runtimeApi, secretNames } from './runtime';

export interface Scelta {
  value: string;
  label: string;
  /** Un dettaglio secondario: il motore del database, l'indirizzo di posta. */
  hint?: string;
}

interface RuntimeDatabase {
  id: string;
  name: string;
  connection?: { engine?: string };
  tables?: { name: string }[];
}

/** I database che il motore conosce. */
export async function listDatabases(): Promise<Scelta[]> {
  const { databases } = await runtimeApi.get<{ databases: RuntimeDatabase[] }>('/db/databases');
  return databases.map((d) => ({
    value: d.id,
    label: d.name,
    ...(d.connection?.engine ? { hint: d.connection.engine } : {}),
  }));
}

/**
 * Le tabelle di un database.
 *
 * Senza database scelto non si restituisce tutto: si restituisce niente. Un
 * elenco di tabelle di database diversi, mischiate, sarebbe peggio di un
 * elenco vuoto — si sceglierebbe la tabella giusta del database sbagliato.
 */
export async function listTables(databaseId: string | undefined): Promise<Scelta[]> {
  if (!databaseId) return [];
  const { database } = await runtimeApi.get<{ database: RuntimeDatabase }>(
    `/db/databases/${databaseId}`,
  );
  return (database.tables ?? []).map((t) => ({ value: t.name, label: t.name }));
}

/**
 * Gli altri workflow, per i nodi che ne chiamano uno.
 *
 * Il valore è l'identificativo che ha **nel motore**, non quello di Medea: è
 * il motore a far partire il workflow chiamato, e l'id di Medea per lui non
 * vuol dire niente. Chi non è mai stato mandato al motore non compare — non
 * si può chiamare qualcosa che dall'altra parte non esiste — e l'elenco lo
 * dice invece di lasciarlo sparire in silenzio.
 */
export async function listWorkflows(): Promise<Scelta[]> {
  const items = await workflowApi.list();
  const scelte: Scelta[] = [];

  for (const item of items) {
    const record = await workflowApi.get(item.id);
    if (!record?.runtimeId) continue;
    scelte.push({
      value: record.runtimeId,
      label: item.name,
      hint: item.enabled ? 'attivo' : 'non attivo',
    });
  }
  return scelte;
}

/** I segreti definiti, per nome. Il valore non si mostra mai. */
export function listSecrets(): Scelta[] {
  return secretNames().map((name) => ({ value: `{{secrets.${name}}}`, label: name }));
}

interface StoredAccount {
  id: string;
  displayName: string;
  emailAddress: string;
}

/** Gli account di posta configurati in Medea. */
export async function listAccounts(): Promise<Scelta[]> {
  const rows = await invoke<StoredAccount[]>('db_account_list');
  return rows.map((r) => ({
    value: r.id,
    label: r.displayName || r.emailAddress,
    hint: r.emailAddress,
  }));
}

/** Quale elenco serve a quale tipo di campo. */
export function pickerKind(
  type: string,
): 'database' | 'table' | 'workflow' | 'secret' | 'account' | null {
  switch (type) {
    case 'db-picker':
      return 'database';
    case 'db-table-picker':
    case 'db-collection-picker':
      return 'table';
    case 'workflow-picker':
      return 'workflow';
    case 'credential-picker':
      return 'secret';
    case 'account-picker':
    case 'email-account-picker':
      return 'account';
    default:
      return null;
  }
}

export interface ElencoState {
  scelte: Scelta[];
  caricando: boolean;
  /** Vero quando l'elenco non si è potuto caricare: il campo torna a mano. */
  fallito: boolean;
}

/**
 * Carica l'elenco che serve a questo campo.
 *
 * `dipendeDa` è il valore del campo da cui questo dipende — la tabella
 * dipende dal database — e ricaricare quando cambia è l'unica cosa che
 * rende utile la dipendenza.
 */
export function useElenco(type: string, dipendeDa?: string): ElencoState {
  const [state, setState] = useState<ElencoState>({
    scelte: [],
    caricando: true,
    fallito: false,
  });

  useEffect(() => {
    const kind = pickerKind(type);
    if (!kind) {
      setState({ scelte: [], caricando: false, fallito: false });
      return;
    }

    if (kind === 'secret') {
      setState({ scelte: listSecrets(), caricando: false, fallito: false });
      return;
    }

    let vivo = true;
    setState((s) => ({ ...s, caricando: true }));

    const carica =
      kind === 'database'
        ? listDatabases()
        : kind === 'table'
          ? listTables(dipendeDa)
          : kind === 'workflow'
            ? listWorkflows()
            : listAccounts();

    void carica
      .then((scelte) => {
        if (vivo) setState({ scelte, caricando: false, fallito: false });
      })
      .catch(() => {
        // Non è un errore da mostrare in rosso: il campo torna scrivibile e
        // si va avanti.
        if (vivo) setState({ scelte: [], caricando: false, fallito: true });
      });

    return () => {
      vivo = false;
    };
  }, [type, dipendeDa]);

  return state;
}
