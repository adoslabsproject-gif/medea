/**
 * action_run_ts — Run TypeScript.
 *
 * Nodo di esecuzione codice TypeScript. Gemello di `action_run_js`: stessa
 * sandbox isolated-vm (isolamento V8, no host API, cap memoria/timeout), ma
 * accetta sorgente TypeScript — i tipi vengono strippati (transpile-only, no
 * type-check) e il JS risultante gira nell'isola. La definizione vive separata
 * da run-code.ts (Python/JS) per modularità: un nodo = un file.
 *
 * @module actions/run-ts
 */
import type { NodeModule } from '../types.js';

export const runTsNode: NodeModule = {
  def: {
    id: 'action_run_ts',
    type: 'action',
    label: 'Run TypeScript',
    icon: 'code-2',
    color: '#3178c6',
    description:
      'Esegue codice TypeScript in sandbox isolated-vm in-process (lo stesso motore battle-tested di ' +
      'action_run_js: isolamento a livello V8, nessun accesso a filesystem/rete/moduli, cap di memoria e ' +
      "timeout applicati dall'isola). Il TypeScript viene transpilato a JavaScript con strip dei soli tipi " +
      '(nessun type-check a runtime → latenza di compilazione < 50ms anche su script da 50KB), quindi ' +
      'annotazioni di tipo, interface, type alias, enum e cast "as" sono supportati e servono solo a ' +
      'scrivere codice più sicuro e leggibile — a runtime spariscono. ' +
      'Sandboxing rigoroso: NO filesystem, NO rete (fetch/http assenti), NO require/import di moduli — ' +
      'solo la standard library JS (Math, JSON, Array, Object, Date, String, RegExp, Number, Map, Set, ' +
      'Promise). Memory cap configurabile (default 128MB, max 512MB), timeout wall-clock (default 5s, max 30s), ' +
      "esecuzione async che NON blocca l'event-loop del container. " +
      'Variabili globali disponibili nello script: `input` (output JSON del nodo precedente), `vars` ' +
      '(workflow variables persistenti), `ctx` (metadata: tenantId, runId, nodeId). ' +
      "Output: il valore restituito con `return <value>` diventa l'output del nodo (deve essere " +
      'JSON-serializable — no funzioni, no riferimenti circolari). ' +
      'Use case: chi preferisce TypeScript a JavaScript per trasformazioni dati custom con tipi espliciti, ' +
      'business logic tipizzata (provvigioni a scaglioni, validazioni multi-campo), reshape di input prima ' +
      'di una chiamata API, algoritmi proprietari del cliente scritti in TS. Per task CPU-intensive o con ' +
      'librerie scientifiche usa action_run_python; per chiamate HTTP usa action_http_request.',
    configFields: [
      {
        key: 'code',
        label: 'Codice TypeScript',
        type: 'code',
        required: true,
        defaultValue:
          '// input = output del nodo precedente\n' +
          '// vars = workflow variables · ctx = { tenantId, runId, nodeId }\n' +
          '\n' +
          'interface Item { amount?: number }\n' +
          'const items: Item[] = (input.items as Item[]) ?? [];\n' +
          'const total: number = items.reduce((s, x) => s + (x.amount ?? 0), 0);\n' +
          'return { total, count: items.length };\n',
        help:
          'Codice TypeScript. Usa "return <value>" per emettere output (JSON-serializable). ' +
          'I tipi vengono strippati a runtime (no type-check). Strict mode. ' +
          'No require/import/fetch/process/eval. Per pattern data-transformation n8n-compat usa logic_transform.',
      },
      {
        key: 'timeoutMs',
        label: 'Timeout (ms)',
        type: 'number',
        required: false,
        defaultValue: '5000',
        help: 'Tempo massimo esecuzione. Min 100, max 30000. Default 5s.',
      },
      {
        key: 'memoryLimitMb',
        label: 'Memory limit (MB)',
        type: 'number',
        required: false,
        defaultValue: '128',
        help: 'Limite memoria isolated-vm. Min 16, max 512. Default 128MB.',
      },
    ],
    // n8n-speak + ricerca: "typescript"/"ts"/"code" devono trovare questo nodo.
    searchAliases: ['typescript', 'ts', 'code', 'function', 'script'],
    outputContract: {
      notes: 'Quello che il codice restituisce sta in `result`, NON al primo livello: a valle si legge `{{$node.<id>.json.result.<campo>}}`.',
      fields: [
        { name: 'result', type: 'object|array|string|number|null', desc: 'Quello che il codice ha restituito, con la forma che gli ha dato.' },
        { name: 'durationMs', type: 'number', desc: 'Quanto e` durata l\'esecuzione.' },
      ],
    },
    vendor: 'flowforge',
    version: '1.0.0',
  },
};
