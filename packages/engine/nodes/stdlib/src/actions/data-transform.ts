/**
 * Data-transformation nodes — manipolazione strutture dati e CSV, 100% JavaScript
 * puro: ZERO dipendenze esterne, ZERO `node:*` (browser-safe nativamente, quindi
 * niente lazy-import). Coprono ciò che in n8n richiede Set / Edit Fields / Item
 * Lists / Spreadsheet File / Code, qui unificati e "a prova di idiota" con ogni
 * opzione in UI e campi condizionali (showIf).
 *
 *   - action_csv   : parse (CSV→righe) / stringify (righe→CSV), RFC 4180 compliant
 *   - action_array : operazioni su array (unique/sort/group/chunk/flatten/pick/slice)
 *   - action_json  : manipolazione oggetti via dot-path (get/set/pick/omit/merge/flatten)
 */
import { toExecutionItem, lineage, type ExecutionItem } from '@medea/engine-core-schema';
import { neutralizeCsvFormula } from '../lib/csv-formula-guard.js';
import type { NodeModule, NodeExecutor } from '../types.js';

// ── helpers condivisi ──────────────────────────────────────────────────────
function str(v: unknown, fallback = ''): string {
  return v === undefined || v === null ? fallback : String(v);
}
function asArray(input: unknown, config: Record<string, unknown>, key = 'items'): unknown[] {
  const fromCfg = config[key];
  const src = fromCfg !== undefined && fromCfg !== '' ? fromCfg : input;
  if (Array.isArray(src)) return src;
  if (typeof src === 'string' && src.trim() !== '') {
    try {
      const parsed = JSON.parse(src) as unknown;
      if (Array.isArray(parsed)) return parsed;
    } catch { /* non-JSON string → single-item array */ }
    return [src];
  }
  if (src && typeof src === 'object') return [src];
  return [];
}
/** Legge un valore annidato via dot-path: "a.b.0.c". undefined se assente. */
function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(p)];
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[p];
    else return undefined;
  }
  return cur;
}
/** Scrive un valore annidato via dot-path, creando gli oggetti intermedi (immutabile). */
function setPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.');
  if (parts.some((p) => FORBIDDEN_PATH_KEYS.has(p))) return { ...obj }; // no prototype manipulation
  const root: Record<string, unknown> = { ...obj };
  let cur = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const k = parts[i]!;
    const next = cur[k];
    cur[k] = next && typeof next === 'object' && !Array.isArray(next) ? { ...(next as Record<string, unknown>) } : {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
  return root;
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
/** Chiavi che manipolerebbero il prototype (CWE-1321) — vietate in set/merge/flatten. */
const FORBIDDEN_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ════════════════════════════════════════════════════════════════════════
// action_csv — parser/serializer CSV RFC 4180
// ════════════════════════════════════════════════════════════════════════
function parseCsv(text: string, delimiter: string, hasHeader: boolean): { rows: unknown[]; headers: string[] } {
  const rows: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } // escaped quote ""
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) { record.push(field); field = ''; }
    else if (ch === '\n') { record.push(field); rows.push(record); field = ''; record = []; }
    else if (ch === '\r') { /* swallow, \n chiude la riga */ }
    else field += ch;
  }
  if (field !== '' || record.length > 0) { record.push(field); rows.push(record); }
  if (rows.length === 0) return { rows: [], headers: [] };
  if (!hasHeader) return { rows, headers: [] };
  const headers = rows[0]!;
  const out = rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => { obj[h] = r[idx] ?? ''; });
    return obj;
  });
  return { rows: out, headers };
}
function csvCell(v: unknown, delimiter: string): string {
  const isStr = typeof v === 'string';
  let s = v === null || v === undefined ? '' : String(v);
  // CWE-1236: una CELLA STRINGA che inizia con un trigger di formula viene
  // eseguita all'apertura in Excel → prefisso apex (') che la rende literal
  // (SSOT condivisa con logic_convert: lib/csv-formula-guard).
  // Solo le stringhe: i numeri (anche negativi, "-5") NON vanno neutralizzati.
  if (isStr) s = neutralizeCsvFormula(s);
  return /["\n\r]/.test(s) || s.includes(delimiter) ? `"${s.replace(/"/g, '""')}"` : s;
}
function stringifyCsv(items: unknown[], delimiter: string, includeHeader: boolean): string {
  if (items.length === 0) return '';
  const headers = Array.from(items.reduce<Set<string>>((set, it) => {
    if (isPlainObject(it)) Object.keys(it).forEach((k) => set.add(k));
    return set;
  }, new Set<string>()));
  const lines: string[] = [];
  if (includeHeader && headers.length > 0) lines.push(headers.map((h) => csvCell(h, delimiter)).join(delimiter));
  for (const it of items) {
    if (isPlainObject(it)) lines.push(headers.map((h) => csvCell(it[h], delimiter)).join(delimiter));
    else if (Array.isArray(it)) lines.push(it.map((c) => csvCell(c, delimiter)).join(delimiter));
    else lines.push(csvCell(it, delimiter));
  }
  return lines.join('\n');
}
const csvExecutor: NodeExecutor = async (config, input) => {
  const startedAt = Date.now();
  const op = str(config.operation, 'parse');
  const delimiter = (() => { const d = str(config.delimiter, ','); return d === '\\t' ? '\t' : (d || ','); })();
  if (op === 'parse') {
    const text = str(config.text) !== '' ? str(config.text) : str(input);
    const hasHeader = str(config.hasHeader, 'true') !== 'false';
    const { rows, headers } = parseCsv(text, delimiter, hasHeader);
    return { output: { rows, headers, count: rows.length }, durationMs: Date.now() - startedAt };
  }
  const items = asArray(input, config, 'items');
  const includeHeader = str(config.includeHeader, 'true') !== 'false';
  const csv = stringifyCsv(items, delimiter, includeHeader);
  return { output: { csv, count: items.length }, durationMs: Date.now() - startedAt };
};

export const csvNode: NodeModule = {
  def: {
    id: 'action_csv',
    type: 'action',
    label: 'CSV',
    icon: 'table',
    color: '#16a34a',
    description:
      'Nodo CSV bidirezionale conforme a RFC 4180, in JavaScript puro (zero dipendenze, nessuna superficie ' +
      'supply-chain), per convertire tra il formato tabellare universale dei dati aziendali e gli array di oggetti ' +
      'che attraversano il workflow. Due operazioni da dropdown: ' +
      '(1) PARSE — da testo CSV ad array di oggetti: gestisce CORRETTAMENTE i casi che rompono i parser ingenui — ' +
      'campi tra virgolette contenenti il delimitatore, virgolette escapate raddoppiate (""), a-capo dentro un ' +
      'campo quotato, terminatori di riga Windows (\\r\\n) e Unix (\\n); con la prima riga come intestazione ' +
      'mappa ogni colonna sul nome del campo (output array di { colonna: valore }), altrimenti restituisce righe ' +
      'come array di celle; ' +
      '(2) STRINGIFY — da array di oggetti a testo CSV: deduce automaticamente le intestazioni dall\'unione di ' +
      'tutte le chiavi presenti negli oggetti (nessun campo perso anche se gli oggetti hanno chiavi diverse), ' +
      'quota automaticamente solo le celle che lo richiedono ed escapa le virgolette interne. ' +
      'Delimitatore configurabile (virgola, punto e virgola — standard EU/Excel italiano —, tab \\t, pipe). ' +
      'Output PARSE: { rows, headers, count } · STRINGIFY: { csv, count }. ' +
      'Use case: importa il CSV export di un gestionale/banca e processane le righe; trasforma il risultato di una ' +
      'query DB nel CSV da allegare a un\'email; converti il file caricato da un cliente (punto e virgola, Excel ' +
      'IT) in JSON per l\'elaborazione; genera il report CSV settimanale di ordini per la contabilità.',
    configFields: [
      {
        key: 'operation', label: 'Operazione', type: 'select', required: true, defaultValue: 'parse',
        options: ['parse', 'stringify'],
        help: 'parse = CSV testo → array di oggetti · stringify = array → testo CSV.',
      },
      {
        key: 'text', label: 'Testo CSV', type: 'expression', required: false, defaultValue: 'input',
        help: 'Il contenuto CSV da analizzare. Vuoto = usa l\'input del nodo.',
        showIf: { field: 'operation', equals: 'parse' },
      },
      {
        key: 'items', label: 'Array di righe', type: 'expression', required: false, defaultValue: 'input',
        help: 'Array di oggetti da serializzare. Vuoto = usa l\'input del nodo.',
        showIf: { field: 'operation', equals: 'stringify' },
      },
      {
        key: 'delimiter', label: 'Delimitatore', type: 'select', required: false, defaultValue: ',',
        options: [',', ';', '\\t', '|'],
        help: 'Virgola (standard) · punto e virgola (Excel IT) · \\t tab · pipe. ',
      },
      {
        key: 'hasHeader', label: 'Prima riga = intestazione', type: 'boolean', required: false, defaultValue: 'true',
        help: 'Se attivo, la prima riga dà i nomi dei campi (output: array di oggetti).',
        showIf: { field: 'operation', equals: 'parse' },
      },
      {
        key: 'includeHeader', label: 'Includi intestazione', type: 'boolean', required: false, defaultValue: 'true',
        help: 'Scrive la riga di intestazione con i nomi delle colonne.',
        showIf: { field: 'operation', equals: 'stringify' },
      },
    ],
    outputs: ['default'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: csvExecutor,
};

// ════════════════════════════════════════════════════════════════════════
// action_array — operazioni su collezioni
// ════════════════════════════════════════════════════════════════════════
function compareBy(key: string, dir: string): (a: unknown, b: unknown) => number {
  const sign = dir === 'desc' ? -1 : 1;
  return (a, b) => {
    const va = key ? getPath(a, key) : a;
    const vb = key ? getPath(b, key) : b;
    if (va === vb) return 0;
    if (va === undefined || va === null) return 1;
    if (vb === undefined || vb === null) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sign;
    return String(va).localeCompare(String(vb), undefined, { numeric: true }) * sign;
  };
}
const arrayExecutor: NodeExecutor = async (config, input) => {
  const startedAt = Date.now();
  const op = str(config.operation, 'unique');
  const items = asArray(input, config, 'items');
  const key = str(config.key);
  let result: unknown;
  // GAP #2 (paired items): le operazioni che SCARTANO o RIORDINANO tracciano
  // gli indici ORIGINALI by-construction (si lavora sull'array degli indici
  // con le stesse primitive del result → mapping esatto, zero divergenza).
  // `declaredIdx[j]` = indice originale del result[j]; `declaredChunks[j]` =
  // indici originali contenuti nel chunk j (lineage fromMany N→1 per chunk).
  // pick (1:1 same-length) e group (N→1) li copre già l'euristica engine;
  // flatten perde il mapping (annidamento arbitrario) → onesto, nessuna
  // dichiarazione.
  let declaredIdx: number[] | undefined;
  let declaredChunks: number[][] | undefined;
  switch (op) {
    case 'unique': {
      const seen = new Set<string>();
      const keptIdx: number[] = [];
      result = items.filter((it, i) => {
        const v = key ? getPath(it, key) : it;
        const k = typeof v === 'object' ? JSON.stringify(v) : String(v);
        if (seen.has(k)) return false;
        seen.add(k); keptIdx.push(i); return true;
      });
      declaredIdx = keptIdx;
      break;
    }
    case 'sort': {
      // Ordina gli INDICI con lo stesso comparatore (sort stabile ES2019) →
      // result identico a [...items].sort(cmp) + mapping esatto.
      const cmp = compareBy(key, str(config.direction, 'asc'));
      const order = items.map((_, i) => i).sort((ia, ib) => cmp(items[ia], items[ib]));
      result = order.map((i) => items[i]);
      declaredIdx = order;
      break;
    }
    case 'group': {
      const groups: Record<string, unknown[]> = {};
      for (const it of items) {
        const g = String(getPath(it, key) ?? '∅');
        (groups[g] ??= []).push(it);
      }
      result = groups;
      break;
    }
    case 'chunk': {
      const size = Math.max(Number(config.size) || 10, 1);
      const out: unknown[][] = [];
      const chunksIdx: number[][] = [];
      for (let i = 0; i < items.length; i += size) {
        out.push(items.slice(i, i + size));
        chunksIdx.push(items.slice(i, i + size).map((_, j) => i + j));
      }
      result = out;
      declaredChunks = chunksIdx;
      break;
    }
    case 'flatten': {
      const depth = Math.max(Number(config.depth) || 1, 1);
      result = (items).flat(depth);
      break;
    }
    case 'pick': {
      const fields = str(config.fields).split(',').map((s) => s.trim()).filter(Boolean);
      result = items.map((it) => {
        const obj: Record<string, unknown> = {};
        for (const f of fields) obj[f] = getPath(it, f);
        return obj;
      });
      break;
    }
    case 'slice': {
      const start = Number(config.start) || 0;
      const end = config.end !== undefined && config.end !== '' ? Number(config.end) : undefined;
      // slice sugli INDICI con gli stessi argomenti → semantica JS identica
      // (start/end negativi inclusi) + mapping esatto.
      const idxs = items.map((_, i) => i).slice(start, end);
      result = idxs.map((i) => items[i]);
      declaredIdx = idxs;
      break;
    }
    case 'reverse':
      result = [...items].reverse();
      declaredIdx = items.map((_, i) => items.length - 1 - i);
      break;
    default:
      throw new Error(`action_array: operazione sconosciuta "${op}"`);
  }
  const count = Array.isArray(result) ? result.length : Object.keys(result as object).length;

  // Dichiarazione SOLO quando l'array filtrato/riordinato è l'INPUT del nodo
  // (stesso guard di action_filter): con `config.items` (espressione) o input
  // stringa/oggetto gli indici non riferiscono la sorgente — meglio nessuna
  // dichiarazione che un lineage sbagliato. Il pairedItem SOVRASCRIVE sempre
  // eventuali ref trascinati dagli item (autorità sul mapping del PROPRIO input).
  let declaredItems: ExecutionItem[] | undefined;
  if (items === input) {
    if (declaredIdx !== undefined) {
      declaredItems = declaredIdx.map((orig) => ({ ...toExecutionItem(items[orig]), pairedItem: lineage.from(orig) }));
    } else if (declaredChunks !== undefined) {
      declaredItems = declaredChunks.map((idxs) => ({
        ...toExecutionItem(idxs.map((i) => items[i])),
        pairedItem: lineage.fromMany(idxs),
      }));
    }
  }

  return {
    output: { result, count, operation: op },
    durationMs: Date.now() - startedAt,
    ...(declaredItems !== undefined ? { items: declaredItems } : {}),
  };
};

export const arrayNode: NodeModule = {
  def: {
    id: 'action_array',
    type: 'action',
    label: 'Array',
    // Le sue OPERATION reali (sort/unique/slice/…) non sono nei token di
    // id/label — sono i nomi con cui l'utente le chiede.
    searchAliases: ['sort', 'unique', 'dedup', 'reverse', 'slice', 'chunk', 'duplicati', 'lista'],
    icon: 'list',
    color: '#0ea5e9',
    description:
      'Coltellino svizzero per collezioni — otto operazioni su array di elementi in JavaScript puro (zero ' +
      'dipendenze), tutte con supporto al dot-path per lavorare su campi annidati ("cliente.indirizzo.città"). ' +
      'Sostituisce il nodo Item Lists di n8n e l\'uso del nodo Code per le manipolazioni più comuni: ' +
      '(1) UNIQUE — rimuove i duplicati, opzionalmente per un campo-chiave (deduplica gli ordini per email ' +
      'cliente, gli articoli per URL); ' +
      '(2) SORT — ordina per campo e direzione, con confronto numerico-aware (10 dopo 9, non dopo 1) e ' +
      'locale-aware per le stringhe; ' +
      '(3) GROUP — raggruppa per campo restituendo { valore: [elementi] } (ordini per stato, transazioni per ' +
      'mese, lead per fonte); ' +
      '(4) CHUNK — spezza in blocchi di N elementi (per batch API rate-limited, paginazione, invii a lotti); ' +
      '(5) FLATTEN — appiattisce array annidati fino alla profondità scelta; ' +
      '(6) PICK — proietta solo i campi indicati di ogni elemento (riduce il payload, seleziona le colonne); ' +
      '(7) SLICE — estrae una porzione (start/end, indici negativi supportati per "ultimi N"); ' +
      '(8) REVERSE — inverte l\'ordine. ' +
      'L\'input può essere un array nativo o una stringa JSON (parsata automaticamente). ' +
      'Output: { result, count, operation }. ' +
      'Use case: deduplica i lead importati prima di inserirli nel CRM (UNIQUE by email); raggruppa le righe ' +
      'fattura per aliquota IVA (GROUP); spezza 5.000 contatti in blocchi da 100 per l\'API di invio (CHUNK); ' +
      'ordina i prodotti per prezzo decrescente nella newsletter (SORT desc); tieni solo nome+email per il CSV ' +
      'export (PICK).',
    configFields: [
      {
        key: 'operation', label: 'Operazione', type: 'select', required: true, defaultValue: 'unique',
        options: ['unique', 'sort', 'group', 'chunk', 'flatten', 'pick', 'slice', 'reverse'],
        help: 'Cosa fare con l\'array. Ogni operazione mostra solo i suoi parametri.',
      },
      {
        key: 'items', label: 'Array', type: 'expression', required: false, defaultValue: 'input',
        help: 'L\'array su cui operare. Vuoto = usa l\'input del nodo (array o stringa JSON).',
      },
      {
        key: 'key', label: 'Campo chiave (dot-path)', type: 'text', required: false,
        placeholder: 'es. cliente.email',
        help: 'Campo su cui operare (annidato con il punto). UNIQUE/SORT senza chiave usano il valore intero.',
        showIf: { field: 'operation', in: ['unique', 'sort', 'group'] },
      },
      {
        key: 'direction', label: 'Direzione', type: 'select', required: false, defaultValue: 'asc',
        options: ['asc', 'desc'],
        showIf: { field: 'operation', equals: 'sort' },
      },
      {
        key: 'size', label: 'Dimensione blocco', type: 'number', required: false, defaultValue: '10',
        help: 'Quanti elementi per blocco.',
        showIf: { field: 'operation', equals: 'chunk' },
      },
      {
        key: 'depth', label: 'Profondità', type: 'number', required: false, defaultValue: '1',
        help: 'Livelli di annidamento da appiattire.',
        showIf: { field: 'operation', equals: 'flatten' },
      },
      {
        key: 'fields', label: 'Campi da tenere', type: 'text', required: false,
        placeholder: 'nome, email, cliente.città',
        help: 'Elenco separato da virgole dei campi (dot-path) da proiettare.',
        showIf: { field: 'operation', equals: 'pick' },
      },
      {
        key: 'start', label: 'Da indice', type: 'number', required: false, defaultValue: '0',
        help: 'Indice iniziale (negativo = dalla fine).',
        showIf: { field: 'operation', equals: 'slice' },
      },
      {
        key: 'end', label: 'A indice (escluso)', type: 'number', required: false,
        help: 'Indice finale escluso. Vuoto = fino alla fine.',
        showIf: { field: 'operation', equals: 'slice' },
      },
    ],
    outputs: ['default'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: arrayExecutor,
};

// ════════════════════════════════════════════════════════════════════════
// action_json — manipolazione oggetti via dot-path
// ════════════════════════════════════════════════════════════════════════
function flattenObject(obj: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (isPlainObject(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      if (FORBIDDEN_PATH_KEYS.has(k)) continue; // scarta chiavi che manipolano il prototype
      const nk = prefix ? `${prefix}.${k}` : k;
      if (isPlainObject(v)) flattenObject(v, nk, out);
      else out[nk] = v;
    }
  } else if (prefix) out[prefix] = obj;
  return out;
}
function deepMerge(a: unknown, b: unknown): unknown {
  if (isPlainObject(a) && isPlainObject(b)) {
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (FORBIDDEN_PATH_KEYS.has(k)) continue; // scarta chiavi che manipolano il prototype
      out[k] = k in out ? deepMerge(out[k], v) : v;
    }
    return out;
  }
  return b;
}
const jsonExecutor: NodeExecutor = async (config, input) => {
  const startedAt = Date.now();
  const op = str(config.operation, 'get');
  const rawSrc = config.source !== undefined && str(config.source) !== '' ? config.source : input;
  const source: unknown = typeof rawSrc === 'string' ? (() => { try { return JSON.parse(rawSrc) as unknown; } catch { return rawSrc; } })() : rawSrc;
  let result: unknown;
  switch (op) {
    case 'get':
      result = getPath(source, str(config.path));
      break;
    case 'set': {
      const base = isPlainObject(source) ? source : {};
      let value: unknown = str(config.value);
      try { value = JSON.parse(str(config.value)); } catch { /* tieni stringa */ }
      result = setPath(base, str(config.path), value);
      break;
    }
    case 'pick': {
      const paths = str(config.paths).split(',').map((s) => s.trim()).filter(Boolean);
      const obj: Record<string, unknown> = {};
      for (const p of paths) { const v = getPath(source, p); if (v !== undefined) obj[p.split('.').pop()!] = v; }
      result = obj;
      break;
    }
    case 'omit': {
      const drop = new Set(str(config.paths).split(',').map((s) => s.trim()).filter(Boolean));
      const obj: Record<string, unknown> = {};
      if (isPlainObject(source)) for (const [k, v] of Object.entries(source)) if (!drop.has(k)) obj[k] = v;
      result = obj;
      break;
    }
    case 'merge': {
      let other: unknown = {};
      try { other = JSON.parse(str(config.value, '{}')); } catch { throw new Error('action_json: "valore da unire" non è JSON valido'); }
      result = deepMerge(source, other);
      break;
    }
    case 'flatten':
      result = flattenObject(source);
      break;
    case 'keys':
      result = isPlainObject(source) ? Object.keys(source) : [];
      break;
    case 'values':
      result = isPlainObject(source) ? Object.values(source) : [];
      break;
    default:
      throw new Error(`action_json: operazione sconosciuta "${op}"`);
  }
  return { output: { result, operation: op }, durationMs: Date.now() - startedAt };
};

export const jsonNode: NodeModule = {
  def: {
    id: 'action_json',
    type: 'action',
    label: 'JSON',
    icon: 'braces',
    color: '#f59e0b',
    description:
      'Manipolatore di oggetti JSON via dot-path, in JavaScript puro (zero dipendenze) — ciò che in n8n richiede ' +
      'il nodo Set / Edit Fields o sistematicamente il nodo Code. Otto operazioni da dropdown che lavorano su ' +
      'percorsi annidati con la notazione a punti ("cliente.indirizzo.città", "righe.0.totale"): ' +
      '(1) GET — estrae il valore a un percorso (naviga oggetti e array, undefined se assente, mai crash su ' +
      'percorso inesistente); ' +
      '(2) SET — imposta un valore a un percorso creando automaticamente gli oggetti intermedi, in modo ' +
      'immutabile (non muta l\'input); il valore è interpretato come JSON se possibile (numeri, bool, oggetti), ' +
      'altrimenti come stringa; ' +
      '(3) PICK — costruisce un nuovo oggetto con SOLO i percorsi indicati (whitelist di campi, riduzione ' +
      'payload prima di inviarlo a un\'API o loggarlo); ' +
      '(4) OMIT — rimuove i campi indicati (blacklist: togli `password`, `token`, PII prima di un log/webhook); ' +
      '(5) MERGE — fonde in profondità un secondo oggetto su quello in ingresso (i campi annidati si combinano, ' +
      'non si sovrascrivono in blocco) — per applicare default o patch parziali; ' +
      '(6) FLATTEN — appiattisce un oggetto annidato in chiavi dot ({a:{b:1}} → {"a.b":1}) per CSV/colonne DB; ' +
      '(7) KEYS / (8) VALUES — estrae le chiavi o i valori di primo livello. ' +
      'Output: { result, operation }. ' +
      'Use case: estrai `data.user.email` dalla risposta annidata di un\'API (GET); rimuovi i campi sensibili ' +
      'prima di loggare un payload webhook (OMIT password,token); applica valori di default a un oggetto di ' +
      'configurazione parziale (MERGE); appiattisci un ordine annidato per scriverlo come riga DB/CSV (FLATTEN); ' +
      'imposta `status="processed"` su un record senza mutare l\'originale (SET).',
    configFields: [
      {
        key: 'operation', label: 'Operazione', type: 'select', required: true, defaultValue: 'get',
        options: ['get', 'set', 'pick', 'omit', 'merge', 'flatten', 'keys', 'values'],
        help: 'Cosa fare con l\'oggetto. Ogni operazione mostra solo i campi che le servono.',
      },
      {
        key: 'source', label: 'Oggetto sorgente', type: 'expression', required: false, defaultValue: 'input',
        help: 'L\'oggetto/JSON su cui operare. Vuoto = usa l\'input del nodo.',
      },
      {
        key: 'path', label: 'Percorso (dot-path)', type: 'text', required: false,
        placeholder: 'es. data.user.email',
        help: 'Percorso del campo con la notazione a punti.',
        showIf: { field: 'operation', in: ['get', 'set'] },
      },
      {
        key: 'value', label: 'Valore', type: 'expression', required: false,
        help: 'SET: il valore da scrivere (JSON o stringa). MERGE: l\'oggetto JSON da fondere.',
        showIf: { field: 'operation', in: ['set', 'merge'] },
      },
      {
        key: 'paths', label: 'Percorsi (separati da virgola)', type: 'text', required: false,
        placeholder: 'email, cliente.città, totale',
        help: 'PICK: i campi da tenere. OMIT: i campi da rimuovere.',
        showIf: { field: 'operation', in: ['pick', 'omit'] },
      },
    ],
    outputs: ['default'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: jsonExecutor,
};
