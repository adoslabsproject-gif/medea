/**
 * action_filter — filtra un array di elementi secondo regole multiple combinate
 * (AND/OR), in JavaScript puro (browser-safe; unica dipendenza: i tipi/helper
 * item di core-schema). Sostituisce il nodo Filter / IF di n8n quando devi
 * separare gli elementi di una collezione. Ramificato: espone "kept" (passati)
 * e "removed" (scartati).
 *
 * GAP #2 (paired items): un filtro SCARTA item → l'engine non può dedurre il
 * lineage (cardinalità input ≠ output). L'executor lo DICHIARA via
 * `result.items`: ogni item del ramo che prosegue porta `pairedItem` con
 * l'indice ORIGINALE nell'array di input — è ciò che rende
 * `$('NodoAMonte').item` corretto a valle del filtro (paired, non posizionale).
 */
import { toExecutionItem, lineage, type ExecutionItem } from '@medea/engine-core-schema';
import { safeUserRegex } from '../lib/safe-user-regex.js';
import type { NodeModule, NodeExecutor } from '../types.js';

function str(v: unknown, fallback = ''): string {
  return v === undefined || v === null ? fallback : String(v);
}
function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const p of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = Array.isArray(cur)
      ? cur[Number(p)]
      : typeof cur === 'object'
        ? (cur as Record<string, unknown>)[p]
        : undefined;
  }
  return cur;
}
interface Rule {
  field: string;
  op: string;
  value?: unknown;
}

function evalRule(item: unknown, rule: Rule): boolean {
  const left = getPath(item, rule.field);
  const right = rule.value;
  const ls = str(left);
  switch (rule.op) {
    case 'equals':
      return ls === str(right);
    case 'not_equals':
      return ls !== str(right);
    case 'contains':
      return ls.toLowerCase().includes(str(right).toLowerCase());
    case 'not_contains':
      return !ls.toLowerCase().includes(str(right).toLowerCase());
    case 'starts_with':
      return ls.toLowerCase().startsWith(str(right).toLowerCase());
    case 'ends_with':
      return ls.toLowerCase().endsWith(str(right).toLowerCase());
    case 'gt':
      return Number(left) > Number(right);
    case 'gte':
      return Number(left) >= Number(right);
    case 'lt':
      return Number(left) < Number(right);
    case 'lte':
      return Number(left) <= Number(right);
    case 'exists':
      return left !== undefined && left !== null;
    case 'empty':
      return left === undefined || left === null || ls === '';
    case 'not_empty':
      return left !== undefined && left !== null && ls !== '';
    // RE2 (safeUserRegex): il pattern è attacker-controlled (dati item) → anti-ReDoS.
    case 'regex': {
      try {
        return safeUserRegex(str(right)).test(ls);
      } catch {
        return false;
      }
    }
    case 'in':
      return str(right)
        .split(',')
        .map((s) => s.trim())
        .includes(ls);
    default:
      return false;
  }
}

function parseRules(raw: unknown): { combinator: string; rules: Rule[] } {
  let obj: unknown = raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = null;
    }
  }
  if (obj && typeof obj === 'object' && Array.isArray((obj as { rules?: unknown }).rules)) {
    const o = obj as { combinator?: string; rules: Rule[] };
    return { combinator: (o.combinator ?? 'AND').toUpperCase(), rules: o.rules };
  }
  if (Array.isArray(obj)) return { combinator: 'AND', rules: obj as Rule[] };
  return { combinator: 'AND', rules: [] };
}

const filterExecutor: NodeExecutor = async (config, input) => {
  const startedAt = Date.now();
  const raw = config.items !== undefined && str(config.items) !== '' ? config.items : input;
  const items: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? (() => {
          try {
            const p: unknown = JSON.parse(raw);
            return Array.isArray(p) ? (p as unknown[]) : [];
          } catch {
            return [];
          }
        })()
      : [];
  const { combinator, rules } = parseRules(config.conditions);

  const matches = (item: unknown): boolean => {
    if (rules.length === 0) return true;
    return combinator === 'OR'
      ? rules.some((r) => evalRule(item, r))
      : rules.every((r) => evalRule(item, r));
  };

  const kept: unknown[] = [];
  const removed: unknown[] = [];
  const keptIdx: number[] = [];
  const removedIdx: number[] = [];
  items.forEach((it, i) => {
    if (matches(it)) {
      kept.push(it);
      keptIdx.push(i);
    } else {
      removed.push(it);
      removedIdx.push(i);
    }
  });

  const branch = kept.length > 0 ? 'kept' : 'removed';

  // Dichiarazione lineage (GAP #2): SOLO quando filtriamo l'INPUT del nodo
  // così com'è (array) — allora l'indice originale i corrisponde all'item i
  // della vista item della sorgente nel grafo della run. Con `config.items`
  // (espressione) o input non-array gli indici non riferiscono alla sorgente:
  // MEGLIO nessuna dichiarazione che un lineage sbagliato.
  const filteredTheNodeInput = raw === input && Array.isArray(input);
  let declaredItems: ExecutionItem[] | undefined;
  if (filteredTheNodeInput) {
    const branchVals = branch === 'kept' ? kept : removed;
    const branchIdx = branch === 'kept' ? keptIdx : removedIdx;
    declaredItems = branchVals.map((v, j) => {
      const base = toExecutionItem(v);
      const originalIndex = branchIdx[j];
      // Il filtro è AUTORITATIVO sul mapping del proprio input: SOVRASCRIVE
      // sempre un eventuale pairedItem trascinato dall'item. Quel ref
      // riferisce l'input della SORGENTE (un hop più su), non del filtro —
      // preservarlo qui farebbe reinterpretare all'engine quegli indici
      // contro il nodo sbagliato (review fase 4.2).
      return originalIndex === undefined
        ? base
        : { ...base, pairedItem: lineage.from(originalIndex) };
    });
  }

  return {
    output: {
      kept,
      removed,
      keptCount: kept.length,
      removedCount: removed.length,
      total: items.length,
    },
    branch,
    durationMs: Date.now() - startedAt,
    ...(declaredItems !== undefined ? { items: declaredItems } : {}),
  };
};

export const filterNode: NodeModule = {
  def: {
    id: 'action_filter',
    type: 'action',
    label: 'Filtra',
    icon: 'filter',
    color: '#dc2626',
    description:
      'Filtra un array di elementi secondo una o più condizioni combinate con AND/OR, in JavaScript puro (zero ' +
      'dipendenze) — il nodo Filter di n8n, ma con un costruttore visuale di regole "a prova di idiota" e quindici ' +
      'operatori, e con DUE uscite ("kept" = passati, "removed" = scartati) così instradi entrambi i gruppi senza ' +
      'duplicare la logica. Ogni regola è "campo (dot-path) · operatore · valore"; le regole si combinano con ' +
      'TUTTE (AND) o ALMENO UNA (OR). Operatori disponibili: uguale / diverso, contiene / non contiene, inizia ' +
      'con / finisce con, maggiore / minore (e ≥ ≤, con confronto numerico), esiste, vuoto / non vuoto, ' +
      'corrisponde a regex, è tra (lista di valori). Lavora su campi annidati grazie al dot-path. ' +
      'Restituisce i due gruppi con i rispettivi conteggi, così sai subito quanti elementi hai tenuto e scartato. ' +
      'Output: { kept, removed, keptCount, removedCount, total } + branch. ' +
      'Use case: tieni solo gli ordini sopra 100€ e instrada gli altri a un ramo diverso (gt); separa i lead con ' +
      'email aziendale da quelli con email generica (regex / not_contains gmail); filtra i prodotti in stock ' +
      '(exists/gt su quantità); scarta le righe importate senza un campo obbligatorio (empty); seleziona i ' +
      'contatti di una regione (in: "Lazio,Lombardia").',
    configFields: [
      {
        key: 'items',
        label: 'Array da filtrare',
        type: 'expression',
        required: false,
        defaultValue: 'input',
        help: "L'array di elementi. Vuoto = usa l'input del nodo.",
      },
      {
        key: 'conditions',
        label: 'Condizioni',
        type: 'condition-rules',
        required: true,
        help: 'Costruttore visuale: combina più regole "campo · operatore · valore" con AND/OR.',
      },
    ],
    outputs: ['kept', 'removed'],
    outputContract: {
      notes: 'Gli scartati non vengono buttati: restano in `removed`, cosi` si puo` mandarli da un\'altra parte invece di perderli.',
      fields: [
        { name: 'kept', type: 'array', desc: 'Gli elementi che hanno superato il filtro.' },
        { name: 'removed', type: 'array', desc: 'Quelli scartati: ci sono ancora, non sono persi.' },
        { name: 'keptCount', type: 'number', desc: 'Quanti ne sono rimasti.' },
        { name: 'removedCount', type: 'number', desc: 'Quanti ne sono stati scartati.' },
        { name: 'total', type: 'number', desc: 'Quanti erano entrati.' },
      ],
    },
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: filterExecutor,
};
