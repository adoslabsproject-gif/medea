/**
 * Attrezzi condivisi dai test dello scaffold: catalogo realistico, output
 * valido di riferimento e provider finti osservabili.
 *
 * Non fa parte dell'API pubblica (`index.ts` non lo esporta): esiste solo
 * perché ogni file di test parli lo stesso linguaggio senza copiarsi i dati.
 */

import type { NodeDef } from '../types';

import type { ScaffoldLlm } from './run';
import type { ScaffoldOutput } from './schema';

/** Accesso a indice che fallisce parlando, invece di un `!` silenzioso. */
export function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`fixture: indice ${i} fuori dai limiti (len ${arr.length})`);
  return v;
}

export const CATALOG: NodeDef[] = [
  {
    defId: 'trigger_cron',
    type: 'trigger',
    label: 'Pianificazione',
    configFields: [{ key: 'cron', type: 'cron-builder', required: true }],
  },
  {
    defId: 'action_http',
    type: 'action',
    label: 'Chiamata HTTP',
    configFields: [
      { key: 'url', type: 'string', required: true },
      {
        key: 'method',
        type: 'select',
        options: ['GET', 'POST', 'PUT', 'DELETE'],
        defaultValue: 'GET',
      },
    ],
  },
  {
    defId: 'action_send_email',
    type: 'action',
    label: 'Invia email',
    configFields: [
      { key: 'to', type: 'string', required: true },
      { key: 'subject', type: 'string', required: true },
      { key: 'body', type: 'rich-text' },
    ],
  },
  {
    defId: 'logic_if',
    type: 'logic',
    label: 'Condizione',
    configFields: [{ key: 'conditionRules', type: 'condition-rules', required: true }],
    outputPorts: ['true', 'false'],
  },
  {
    defId: 'db_insert',
    type: 'action',
    label: 'Inserisci riga',
    configFields: [
      { key: 'databaseId', type: 'db-picker', required: true },
      { key: 'table', type: 'db-table-picker', required: true },
      { key: 'rowJson', type: 'json' },
    ],
  },
  {
    defId: 'action_notes',
    type: 'action',
    label: 'Note',
    configFields: [{ key: 'action', type: 'select', required: true }],
    actions: [{ id: 'note_add' }, { id: 'note_list' }],
  },
];

/** Un output pulito che deve sempre passare: la linea di base di ogni test. */
export function makeValid(): ScaffoldOutput {
  return {
    name: 'Controllo giornaliero',
    reasoning:
      'Il trigger a orario avvia il flusso, la chiamata HTTP recupera i dati e infine parte una email di riepilogo al referente.',
    nodes: [
      { id: 'cron', defId: 'trigger_cron', config: { cron: '0 9 * * *' } },
      {
        id: 'fetch',
        defId: 'action_http',
        config: { url: 'https://esempio.test/dati', method: 'GET' },
      },
      {
        id: 'notify',
        defId: 'action_send_email',
        config: { to: 'team@esempio.test', subject: 'Riepilogo' },
      },
    ],
    edges: [
      { from: 'cron', to: 'fetch' },
      { from: 'fetch', to: 'notify' },
    ],
  };
}

export interface LlmCall {
  system: string;
  user: string;
  schema: object;
}

export type ObservableLlm = ScaffoldLlm & { calls: LlmCall[] };

/** Un provider finto che risponde in sequenza e registra ogni chiamata. */
export function fakeLlm(
  responses: string[],
  opts: Partial<Pick<ScaffoldLlm, 'supportsStructuredOutput' | 'isTuned'>> = {},
): ObservableLlm {
  let i = 0;
  const calls: LlmCall[] = [];
  return {
    supportsStructuredOutput: false,
    ...opts,
    calls,
    complete: (args) => {
      calls.push(args);
      return Promise.resolve(responses[Math.min(i++, responses.length - 1)] ?? '');
    },
  };
}

/** Un provider che fallisce le prime `failures` chiamate, poi risponde. */
export function flakyLlm(failures: number, responses: string[]): ObservableLlm {
  let i = 0;
  const calls: LlmCall[] = [];
  return {
    supportsStructuredOutput: false,
    calls,
    complete: (args) => {
      calls.push(args);
      if (calls.length <= failures) {
        return Promise.reject(new Error('rete giù'));
      }
      return Promise.resolve(responses[Math.min(i++, responses.length - 1)] ?? '');
    },
  };
}
