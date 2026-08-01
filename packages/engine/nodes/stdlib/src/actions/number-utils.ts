/**
 * Number utility nodes — matematica, formattazione valuta/percentuale e statistiche
 * su collezioni, in JavaScript puro (solo Math + Intl, ZERO dipendenze, ZERO
 * `node:*`, browser-safe). Sostituiscono il nodo Code per i calcoli e la
 * formattazione monetaria italiana/europea.
 *
 *   - action_number    : round/format(valuta EUR)/percent/clamp/parse/abs/...
 *   - action_aggregate : sum/avg/min/max/median/stddev/count su array
 */
import type { NodeModule, NodeExecutor } from '../types.js';

function str(v: unknown, fallback = ''): string {
  return v === undefined || v === null ? fallback : String(v);
}
function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const p of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = Array.isArray(cur) ? cur[Number(p)] : typeof cur === 'object' ? (cur as Record<string, unknown>)[p] : undefined;
  }
  return cur;
}
/**
 * Normalizza il numero di decimali a un intero in [0, 100]: previene sia il NaN di
 * `round` (10 ** decimals enorme = Infinity) sia il RangeError di Intl.NumberFormat
 * ("Invalid digits value") su valori non-numerici/negativi/>100.
 */
function clampDecimals(v: unknown): number {
  const d = Math.trunc(Number(v));
  return Number.isFinite(d) ? Math.min(Math.max(d, 0), 100) : 0;
}
/** Parser numerico robusto: gestisce il formato italiano "1.234,56" e quello US "1,234.56". */
function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  let s = str(v).trim().replace(/[^\d.,-]/g, ''); // via simboli valuta/spazi
  if (s === '') return NaN;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.'); // IT: . migliaia, , decimale
  else s = s.replace(/,/g, ''); // US: , migliaia
  return Number(s);
}

// ════════════════════════════════════════════════════════════════════════
// action_number
// ════════════════════════════════════════════════════════════════════════
const numberExecutor: NodeExecutor = async (config, input) => {
  const startedAt = Date.now();
  const op = str(config.operation, 'round');
  const n = toNumber(config.value !== undefined && str(config.value) !== '' ? config.value : input);
  if (Number.isNaN(n)) throw new Error('action_number: valore non numerico');
  let result: unknown;
  switch (op) {
    case 'round': {
      // Round half-away-from-zero con correzione epsilon SCALATA alla magnitudine
      // (1+EPSILON) → neutralizza il drift di virgola mobile: 1.005→1.01, 8.575→8.58
      // (il naive Math.round(n*f)/f darebbe 1.00 / 8.57). Vedi MDN decimalAdjust.
      const d = clampDecimals(config.decimals); const f = 10 ** d;
      const sign = n < 0 ? -1 : 1;
      result = (sign * Math.round(Math.abs(n) * f * (1 + Number.EPSILON))) / f;
      break;
    }
    case 'floor': result = Math.floor(n); break;
    case 'ceil': result = Math.ceil(n); break;
    case 'abs': result = Math.abs(n); break;
    case 'clamp': {
      const min = config.min !== undefined && config.min !== '' ? toNumber(config.min) : -Infinity;
      const max = config.max !== undefined && config.max !== '' ? toNumber(config.max) : Infinity;
      result = Math.min(Math.max(n, min), max);
      break;
    }
    case 'percent': {
      // n% di total (se total dato) oppure n come frazione → percentuale formattata
      const total = config.total !== undefined && str(config.total) !== '' ? toNumber(config.total) : null;
      result = total !== null ? (n / 100) * total : n * 100;
      break;
    }
    case 'currency': {
      const locale = str(config.locale, 'it-IT') || 'it-IT';
      const currency = str(config.currency, 'EUR') || 'EUR';
      const formatted = new Intl.NumberFormat(locale, { style: 'currency', currency }).format(n);
      return { output: { result: formatted, raw: n, currency }, durationMs: Date.now() - startedAt };
    }
    case 'format': {
      const locale = str(config.locale, 'it-IT') || 'it-IT';
      const decimals = config.decimals !== undefined && str(config.decimals) !== '' ? clampDecimals(config.decimals) : undefined;
      const formatted = new Intl.NumberFormat(locale, decimals !== undefined ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals } : {}).format(n);
      return { output: { result: formatted, raw: n }, durationMs: Date.now() - startedAt };
    }
    case 'parse':
      result = n; // toNumber ha già normalizzato il formato
      break;
    default:
      throw new Error(`action_number: operazione sconosciuta "${op}"`);
  }
  return { output: { result, raw: n, operation: op }, durationMs: Date.now() - startedAt };
};

export const numberNode: NodeModule = {
  def: {
    id: 'action_number',
    type: 'action',
    label: 'Numero',
    icon: 'calculator',
    color: '#ca8a04',
    description:
      'Coltellino svizzero numerico in JavaScript puro (Math + Intl, zero dipendenze) con formattazione monetaria ' +
      'e numerica ITALIANA/europea nativa — per non sbagliare mai un arrotondamento o un formato prezzo nei ' +
      'workflow di fatturazione, e-commerce, contabilità. Nove operazioni da dropdown: ' +
      '(1) ROUND — arrotonda a N decimali (totali fattura, prezzi) senza gli errori di virgola mobile; ' +
      '(2) FLOOR / (3) CEIL / (4) ABS — troncamento per difetto/eccesso e valore assoluto; ' +
      '(5) CLAMP — vincola un valore tra un minimo e un massimo (limita sconti, quantità, punteggi); ' +
      '(6) PERCENT — calcola la percentuale di un totale (IVA, sconto, provvigione) o converte una frazione in %; ' +
      '(7) CURRENCY — formatta come valuta con simbolo, separatori e decimali corretti per il locale ' +
      '(1234.5 → "1.234,50 €" in it-IT, "$1,234.50" in en-US) — il formato giusto per email, fatture, UI; ' +
      '(8) FORMAT — formatta un numero con separatore delle migliaia e decimali secondo il locale; ' +
      '(9) PARSE — interpreta una stringa numerica in QUALSIASI formato ("1.234,56 €", "1,234.56", "€ 99") e la ' +
      'normalizza in un numero pulito — fondamentale per importare prezzi da CSV/scraping/form senza rompersi sul ' +
      'separatore decimale. ' +
      'Il parser di ingresso riconosce automaticamente il formato IT (punto migliaia, virgola decimale) e US. ' +
      'Output: { result, raw, operation }. ' +
      'Use case: arrotonda il totale carrello a 2 decimali (ROUND); formatta il prezzo in "1.234,50 €" per ' +
      'l\'email ordine (CURRENCY); calcola il 22% di IVA su un imponibile (PERCENT); importa i prezzi dal CSV ' +
      'fornitore in formato italiano (PARSE); limita lo sconto applicabile a max 50% (CLAMP).',
    configFields: [
      {
        key: 'operation', label: 'Operazione', type: 'select', required: true, defaultValue: 'round',
        options: ['round', 'floor', 'ceil', 'abs', 'clamp', 'percent', 'currency', 'format', 'parse'],
        help: 'Cosa calcolare/formattare. Ogni operazione mostra solo i suoi parametri.',
      },
      {
        key: 'value', label: 'Valore', type: 'expression', required: false, defaultValue: 'input',
        help: 'Il numero (o stringa numerica in qualsiasi formato). Vuoto = usa l\'input del nodo.',
      },
      {
        key: 'decimals', label: 'Decimali', type: 'number', required: false, defaultValue: '2',
        help: 'Numero di cifre decimali.',
        showIf: { field: 'operation', in: ['round', 'format'] },
      },
      {
        key: 'min', label: 'Minimo', type: 'number', required: false,
        showIf: { field: 'operation', equals: 'clamp' },
      },
      {
        key: 'max', label: 'Massimo', type: 'number', required: false,
        showIf: { field: 'operation', equals: 'clamp' },
      },
      {
        key: 'total', label: 'Totale (base %)', type: 'number', required: false,
        help: 'Se valorizzato: risultato = (valore/100) × totale. Vuoto: valore × 100.',
        showIf: { field: 'operation', equals: 'percent' },
      },
      {
        key: 'currency', label: 'Valuta', type: 'select', required: false, defaultValue: 'EUR',
        options: ['EUR', 'USD', 'GBP', 'CHF'],
        showIf: { field: 'operation', equals: 'currency' },
      },
      {
        key: 'locale', label: 'Lingua/formato', type: 'select', required: false, defaultValue: 'it-IT',
        options: ['it-IT', 'en-US', 'en-GB', 'de-DE', 'fr-FR'],
        help: 'Determina separatori delle migliaia e dei decimali.',
        showIf: { field: 'operation', in: ['currency', 'format'] },
      },
    ],
    outputs: ['default'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: numberExecutor,
};

// ════════════════════════════════════════════════════════════════════════
// action_aggregate — statistiche su collezioni
// ════════════════════════════════════════════════════════════════════════
const aggregateExecutor: NodeExecutor = async (config, input) => {
  const startedAt = Date.now();
  const raw = config.items !== undefined && str(config.items) !== '' ? config.items : input;
  const arr: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'string' ? (() => { try { const p: unknown = JSON.parse(raw); return Array.isArray(p) ? (p as unknown[]) : []; } catch { return []; } })() : [];
  const key = str(config.key);
  const nums = arr.map((it) => toNumber(key ? getPath(it, key) : it)).filter((n) => !Number.isNaN(n));
  const count = nums.length;
  const sum = nums.reduce((a, b) => a + b, 0);
  const avg = count ? sum / count : 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const median = count === 0 ? 0 : count % 2 ? sorted[(count - 1) / 2]! : (sorted[count / 2 - 1]! + sorted[count / 2]!) / 2;
  const variance = count ? nums.reduce((a, b) => a + (b - avg) ** 2, 0) / count : 0;
  const stddev = Math.sqrt(variance);
  const op = str(config.operation, 'all');
  const stats = { count, sum, avg, min: count ? sorted[0]! : 0, max: count ? sorted[count - 1]! : 0, median, stddev };
  const result = op === 'all' ? stats : stats[op as keyof typeof stats];
  // I campi flat (count/sum/avg/…) sono SEMPRE al top level — come promette la
  // description "Output: { result, count, sum, … }". Prima erano spread SOLO per le
  // op singole e annidati in `result` per 'all' (il DEFAULT) → drift invertito.
  return { output: { result, ...stats }, durationMs: Date.now() - startedAt };
};

export const aggregateNode: NodeModule = {
  def: {
    id: 'action_aggregate',
    type: 'action',
    label: 'Statistiche',
    icon: 'bar-chart',
    color: '#9333ea',
    description:
      'Calcola statistiche aggregate su un array di numeri (o su un campo numerico di un array di oggetti) in ' +
      'JavaScript puro (zero dipendenze) — ciò che in n8n richiede il nodo Code o Summarize. In un colpo solo ' +
      'restituisce conteggio, somma, media, minimo, massimo, MEDIANA (più robusta della media verso gli outlier) ' +
      'e DEVIAZIONE STANDARD (dispersione dei dati). Puoi richiederle tutte insieme (operazione "all") o ' +
      'selezionarne una sola. Lavora con il dot-path per aggregare un campo annidato di oggetti ' +
      '("ordini[].totale"). Il parser numerico riconosce i formati italiano/US e ignora i valori non numerici ' +
      '(non si rompe su celle vuote o testo). ' +
      'Output: { result, count, sum, avg, min, max, median, stddev }. ' +
      'Use case: totale e media del fatturato mensile dagli ordini (sum/avg su "totale"); valore massimo e minimo ' +
      'di una serie di prezzi; mediana dei tempi di risposta per ignorare i picchi; deviazione standard per ' +
      'rilevare anomalie; conteggio di righe valide importate da un CSV.',
    configFields: [
      {
        key: 'operation', label: 'Statistica', type: 'select', required: true, defaultValue: 'all',
        options: ['all', 'sum', 'avg', 'min', 'max', 'median', 'stddev', 'count'],
        help: '"all" = tutte insieme. Oppure scegline una sola come risultato principale.',
      },
      {
        key: 'items', label: 'Array', type: 'expression', required: false, defaultValue: 'input',
        help: 'Array di numeri o di oggetti. Vuoto = usa l\'input del nodo.',
      },
      {
        key: 'key', label: 'Campo numerico (dot-path)', type: 'text', required: false,
        placeholder: 'es. ordine.totale',
        help: 'Se gli elementi sono oggetti, il campo da aggregare. Vuoto = gli elementi sono già numeri.',
      },
    ],
    outputs: ['default'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: aggregateExecutor,
};
