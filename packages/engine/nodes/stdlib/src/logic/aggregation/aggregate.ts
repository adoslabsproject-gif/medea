/**
 * AggregateNode — riduce un array a un singolo valore (o per-gruppo).
 *
 * Reducer supportati: count / sum / avg / min / max / concat.
 * Group-by opzionale → output `{ reduced: { [k]: v }, groupCount }`.
 * Senza group-by → output `{ value, itemCount }`.
 *
 * Pattern Strategy: ogni reducer e\` una closure pura `(arr) => value`.
 * Aggiungere un reducer = nuova entry in `REDUCERS`, zero modifiche all'executor.
 */

import type { NodeModule, NodeExecutor } from '../../types.js';
import { getField, numericStats, capItems, groupKeyString } from './helpers.js';

/** Esito di un reducer: il valore + quanti item ha effettivamente processato/skippato. */
interface ReduceResult {
  value: unknown;
  processed: number;
  skipped: number;
}
type Reducer = (arr: readonly unknown[], field: string | undefined) => ReduceResult;

/** Mediana dei valori numerici (più robusta dell'avg in presenza di outlier). */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

// I reducer numerici delegano a `numericStats` (UN passaggio, no spread-args → regge
// 1M+ item) e SKIPPANO i valori non-numerici: `processed` = quanti numeri validi,
// `skipped` = quanti scartati. L'avg divide per i validi, MAI per arr.length (gli 0
// finti falserebbero la media). count/concat/collect operano su tutti gli item.
const REDUCERS: Record<string, Reducer> = {
  count: (arr) => ({ value: arr.length, processed: arr.length, skipped: 0 }),
  sum: (arr, field) => {
    const s = numericStats(arr, field);
    return { value: s.sum, processed: s.count, skipped: s.skipped };
  },
  avg: (arr, field) => {
    const s = numericStats(arr, field);
    return { value: s.count === 0 ? 0 : s.sum / s.count, processed: s.count, skipped: s.skipped };
  },
  min: (arr, field) => {
    const s = numericStats(arr, field);
    return { value: s.count === 0 ? 0 : s.min, processed: s.count, skipped: s.skipped };
  },
  max: (arr, field) => {
    const s = numericStats(arr, field);
    return { value: s.count === 0 ? 0 : s.max, processed: s.count, skipped: s.skipped };
  },
  median: (arr, field) => {
    const s = numericStats(arr, field);
    return { value: median(s.values), processed: s.count, skipped: s.skipped };
  },
  concat: (arr, field) => ({
    value: arr.map((it) => String(getField(it, field) ?? '')).join(','),
    processed: arr.length,
    skipped: 0,
  }),
  collect: (arr, field) => ({
    value: arr.map((it) => getField(it, field)),
    processed: arr.length,
    skipped: 0,
  }),
};

const executor: NodeExecutor = async (config, input) => {
  const startedAt = Date.now();
  const { items, warning } = capItems(input, config.maxItems);
  const reducerName = String(config.reducer ?? 'count');
  const reduce: Reducer = REDUCERS[reducerName] ?? REDUCERS.count!;
  const field = config.field !== undefined ? String(config.field) : undefined;
  const groupByField =
    config.groupBy !== undefined && String(config.groupBy) !== ''
      ? String(config.groupBy)
      : undefined;
  // Precisione decimale per i reducer a media (avg/median): default 2 (€/percentuali).
  const precision = Math.max(0, Math.min(Number(config.precision ?? 2), 12));
  const roundIf = (v: unknown): unknown =>
    (reducerName === 'avg' || reducerName === 'median') &&
    typeof v === 'number' &&
    Number.isFinite(v)
      ? Number(v.toFixed(precision))
      : v;

  let output: unknown;
  if (groupByField) {
    // `Object.create(null)`: la group-key è attacker-controlled. Con `{}`, `__proto__`
    // → `.push` su Object.prototype = crash deterministico (vedi group-by.ts). `reduced`
    // idem: `reduced['__proto__']=…` su `{}` scriverebbe il prototype invece di una own.
    const groups = Object.create(null) as Record<string, unknown[]>;
    for (const item of items) {
      const k = groupKeyString(getField(item, groupByField));
      (groups[k] ??= []).push(item);
    }
    const reduced = Object.create(null) as Record<string, unknown>;
    let skippedNonNumeric = 0;
    for (const [k, v] of Object.entries(groups)) {
      const r = reduce(v, field);
      reduced[k] = roundIf(r.value);
      skippedNonNumeric += r.skipped;
    }
    output = {
      reduced,
      groupCount: Object.keys(groups).length,
      inputCount: items.length,
      skippedNonNumeric,
    };
  } else {
    const r = reduce(items, field);
    output = {
      value: roundIf(r.value),
      itemCount: items.length,
      inputCount: items.length,
      processedCount: r.processed,
      skippedNonNumeric: r.skipped,
    };
  }

  return {
    output,
    durationMs: Date.now() - startedAt,
    ...(warning ? { warnings: [warning] } : {}),
  };
};

export const aggregateNode: NodeModule = {
  def: {
    id: 'logic_aggregate',
    type: 'logic',
    label: 'Aggregate',
    icon: 'sigma',
    color: '#f59e0b',
    description:
      'Operatore enterprise di aggregazione (reducer) che collassa un array di N oggetti in un singolo valore ' +
      "aggregato secondo una funzione di reduce configurabile — l'equivalent della funzione SQL aggregate " +
      '(SUM, COUNT, AVG, MIN, MAX, GROUP_CONCAT) applicato in-memory ai workflow business. Sette funzioni di ' +
      'aggregazione coprono il 95% dei use case business analytics e reporting: ' +
      '(1) sum — somma totale dei valori numerici di un campo (es. expectedRevenue di crm.lead per il forecast ' +
      'di pipeline del mese), (2) count — conteggio degli item (con filtro opzionale "count where status=open"), ' +
      '(3) avg — media aritmetica con gestione precision (default 2 decimal places), (4) min/max — estremi del ' +
      "dataset (utile per trovare l'ordine più alto/basso, la fattura più recente/vecchia), (5) concat — " +
      'concatenazione di stringhe con separator configurabile (es. concat di tutti i nomi cliente del segmento ' +
      'separati da virgola per email digest), (6) collect — raccolta in array di tutti i valori di un campo ' +
      "(es. tutti gli email del segmento per bulk send), (7) median — mediana statistica più robusta dell'avg " +
      'in presenza di outlier che distorcono la media. ' +
      "Group-by opzionale potentissimo: oltre all'aggregazione globale sull'intero array, è possibile " +
      'aggregare PER GRUPPO sulla base di un campo discriminante (es. somma amount per customer_id, count ' +
      "orders per region, avg sentiment per source) — l'output diventa una Map { group_key: aggregatedValue, " +
      "... } che è pronta per essere serializzata come tabella di summary report nell'email cliente o nel " +
      'PDF mensile del controlling. Pattern composto group_by + aggregate è il workhorse delle pipeline ETL ' +
      'leggere che evitano di dover scrivere SQL diretto al database. ' +
      'Gestione robusta dei valori non-numeric: per sum/avg/min/max, gli item con valore null/undefined/' +
      'stringa-non-parsabile vengono skipati (non droppano il workflow) e tracciati in skippedNonNumeric ' +
      'output — pattern fail-safe vs naïve Math.sum() che esploderebbe su NaN. ' +
      'Type coercion intelligente: stringhe numerich "42.5" → 42.5, stringhe formato italiano "1.234,56" → ' +
      '1234.56 (gestisce locale italiano con virgola decimale), boolean true/false → 1/0 per sum semantico. ' +
      'Output: { value (single value per aggregazione globale, o Map per group-by), inputCount (size array di ' +
      'partenza), processedCount (effettivamente aggregati dopo skip non-numeric), skippedNonNumeric (count ' +
      'item skipati con motivazione esplicita) }. ' +
      'Use case: KPI dashboard del business (somma fatturato giorno-corrente, count ordini settimanali, avg ' +
      'order value, max ordine del mese) tramite trigger_cron daily + db_query + aggregate; rollup analytics ' +
      'multi-tenant per super_admin che vede aggregato dei KPI per workspace_id; calcoli statistici post-query ' +
      'DB pre-visualizzazione (es. compute della percentile 95th senza dover writing SQL window functions); ' +
      'aggregare result di una loop iteration prima del send-email summary (loop processa 100 ordini → ' +
      'aggregate dei flag success/failed → email digest "85 successful, 15 failed, total amount €12.5k").',
    configFields: [
      {
        key: 'sourceExpression',
        label: 'Array da ridurre',
        type: 'expression',
        required: true,
        defaultValue: 'input',
        placeholder: 'input.records',
        help: 'Espressione JS che ritorna un array. Default = input.',
      },
      {
        key: 'reducer',
        label: 'Funzione di riduzione',
        type: 'select',
        required: true,
        defaultValue: 'count',
        options: ['count', 'sum', 'avg', 'min', 'max', 'median', 'concat', 'collect'],
        help: 'count = quanti item. sum = somma (richiede campo). avg = media. min/max = estremi. median = mediana (robusta agli outlier). concat = concatena i valori del campo come stringa CSV. collect = raccoglie i valori del campo in un array. sum/avg/min/max/median SKIPPANO i valori non-numerici (contati in skippedNonNumeric).',
      },
      {
        key: 'field',
        label: 'Campo (per sum/avg/min/max/median/concat/collect)',
        type: 'text',
        required: false,
        placeholder: 'es. amount, price, quantity',
        help: 'Nome del campo (supporta dot-path: order.amount). Ignorato per count. Se vuoto e gli item sono numeri/primitivi, opera su di essi.',
      },
      {
        key: 'precision',
        label: 'Decimali (avg/median)',
        type: 'number',
        required: false,
        defaultValue: '2',
        help: 'Numero di decimali a cui arrotondare avg e median (default 2, es. importi/percentuali). Max 12. Non tocca sum/min/max.',
      },
      {
        key: 'groupBy',
        label: 'Raggruppa per (opzionale)',
        type: 'text',
        required: false,
        placeholder: 'es. customer_id, region',
        help: 'Se settato, riduce per gruppo e output e` { [valoreCampo]: risultato }. Es. amount sum group-by customer = total per cliente.',
      },
      {
        key: 'maxItems',
        label: 'Max item (cap difensivo)',
        type: 'number',
        required: false,
        defaultValue: '100000',
        help: "Hard cap anti-OOM sul numero di item processati. Se l'input supera questa soglia viene troncato e l'aggregato è calcolato sui primi N (warning emesso). Default 100k, tetto 1M.",
      },
    ],
    outputContract: {
      notes: 'Due forme diverse. SENZA raggruppamento escono `value`, `itemCount`, `inputCount`, `processedCount`, `skippedNonNumeric`. CON raggruppamento escono `reduced`, `groupCount`, `inputCount`, `skippedNonNumeric` — e `value` NON c\'e`.',
      fields: [
        { name: 'value', type: 'number|string', desc: 'Il valore aggregato. Solo senza raggruppamento.' },
        { name: 'itemCount', type: 'number', desc: 'Quanti elementi sono entrati. Solo senza raggruppamento.' },
        { name: 'reduced', type: 'object', desc: 'Il valore aggregato di ogni gruppo, sotto la chiave del gruppo. Solo con raggruppamento.' },
        { name: 'groupCount', type: 'number', desc: 'Quanti gruppi. Solo con raggruppamento.' },
        { name: 'inputCount', type: 'number', desc: 'Quanti elementi sono entrati, in entrambe le forme.' },
        { name: 'processedCount', type: 'number', desc: 'Quanti sono stati davvero aggregati. Solo senza raggruppamento.' },
        { name: 'skippedNonNumeric', type: 'number', desc: 'Quanti sono stati saltati perche` non numerici: se e` alto, il campo indicato non contiene numeri.' },
      ],
    },
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor,
};
