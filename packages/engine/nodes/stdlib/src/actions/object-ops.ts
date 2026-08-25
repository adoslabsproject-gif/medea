/**
 * Object-shaping nodes — modellazione di oggetti (set/rename/remove di campi) e
 * fallback a catena, in JavaScript puro (ZERO dipendenze, browser-safe).
 * Sostituiscono il nodo Set / Edit Fields di n8n e i ?? a catena nel nodo Code.
 *
 *   - action_set_fields : imposta/rinomina/rimuove più campi in un colpo (dot-path)
 *   - action_coalesce   : primo valore presente tra più sorgenti, con default
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
    cur = Array.isArray(cur)
      ? cur[Number(p)]
      : typeof cur === 'object'
        ? (cur as Record<string, unknown>)[p]
        : undefined;
  }
  return cur;
}
/**
 * SECURITY (CWE-1321 prototype pollution): un dot-path come `__proto__.x` o
 * `constructor.prototype.x` — dal config dell'autore — navigherebbe fino a
 * Object.prototype e ne inquinerebbe il prototype GLOBALE del processo (tutti gli
 * oggetti del runtime tenant). Queste chiavi sono vietate in set/del by-path.
 */
const FORBIDDEN_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  if (parts.some((p) => FORBIDDEN_PATH_KEYS.has(p))) return; // blocca prototype pollution
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const k = parts[i]!;
    if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}
function delPath(obj: Record<string, unknown>, path: string): void {
  const parts = path.split('.');
  if (parts.some((p) => FORBIDDEN_PATH_KEYS.has(p))) return; // blocca prototype pollution
  let cur: unknown = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!cur || typeof cur !== 'object') return;
    cur = (cur as Record<string, unknown>)[parts[i]!];
  }
  if (cur && typeof cur === 'object')
    delete (cur as Record<string, unknown>)[parts[parts.length - 1]!];
}
/** Interpreta una stringa come JSON (numero/bool/oggetto) se possibile, altrimenti la lascia stringa. */
function coerce(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t === '') return v;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  // Zero iniziale (es. CAP "00184", telefono "0612345", P.IVA con padding) → NON
  // convertire: Number() perderebbe lo zero corrompendo l'identificativo. Tieni stringa.
  if (/^-?0\d/.test(t)) return v;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return JSON.parse(t);
    } catch {
      return v;
    }
  }
  return v;
}

// ════════════════════════════════════════════════════════════════════════
// action_set_fields
// ════════════════════════════════════════════════════════════════════════
const setFieldsExecutor: NodeExecutor = async (config, input) => {
  const startedAt = Date.now();
  const base: Record<string, unknown> = (() => {
    const src = config.source !== undefined && str(config.source) !== '' ? config.source : input;
    if (src && typeof src === 'object' && !Array.isArray(src)) {
      // Deep-clone difensivo: un riferimento circolare farebbe lanciare
      // JSON.stringify → fallback a shallow clone (non muta comunque l'input).
      try {
        return JSON.parse(JSON.stringify(src)) as Record<string, unknown>;
      } catch {
        return { ...(src as Record<string, unknown>) };
      }
    }
    if (typeof src === 'string') {
      try {
        const p: unknown = JSON.parse(src);
        return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    }
    return {};
  })();
  const keepOnly = str(config.keepOnly) === 'true';

  // assignments: oggetto { "campo.dot": "valore" }
  let assignments: Record<string, unknown> = {};
  const rawAssign = config.assignments;
  if (rawAssign && typeof rawAssign === 'object')
    assignments = rawAssign as Record<string, unknown>;
  else if (typeof rawAssign === 'string' && rawAssign.trim() !== '') {
    try {
      assignments = JSON.parse(rawAssign) as Record<string, unknown>;
    } catch {
      /* ignora */
    }
  }

  const result: Record<string, unknown> = keepOnly ? {} : base;
  for (const [path, value] of Object.entries(assignments)) {
    setPath(result, path, str(config.coerceTypes, 'true') !== 'false' ? coerce(value) : value);
  }

  // remove: lista di percorsi
  const removeList = str(config.removeFields)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const path of removeList) delPath(result, path);

  // rename: { "vecchio.path": "nuovo.path" }
  let renames: Record<string, string> = {};
  const rawRename = config.renameFields;
  if (rawRename && typeof rawRename === 'object') renames = rawRename as Record<string, string>;
  else if (typeof rawRename === 'string' && rawRename.trim() !== '') {
    try {
      renames = JSON.parse(rawRename) as Record<string, string>;
    } catch {
      /* ignora */
    }
  }
  for (const [from, to] of Object.entries(renames)) {
    const v = getPath(result, from);
    if (v !== undefined) {
      setPath(result, str(to), v);
      delPath(result, from);
    }
  }

  return {
    output: { result, fieldCount: Object.keys(result).length },
    durationMs: Date.now() - startedAt,
  };
};

export const setFieldsNode: NodeModule = {
  def: {
    id: 'action_set_fields',
    type: 'action',
    label: 'Imposta campi',
    icon: 'edit-3',
    color: '#0891b2',
    description:
      "Modella un oggetto impostando, rinominando e rimuovendo PIÙ campi in un solo nodo — l'equivalente del " +
      'nodo Set / Edit Fields di n8n, in JavaScript puro (zero dipendenze) e con il dot-path per i campi ' +
      'annidati. Quattro leve, tutte in UI: ' +
      '(1) IMPOSTA — un editor chiave/valore dove ogni riga è "percorso → valore": crea o sovrascrive campi anche ' +
      'annidati ("cliente.stato" → "attivo"), creando automaticamente gli oggetti intermedi; con la conversione ' +
      'di tipo opzionale i valori "42", "true", "{\\"a\\":1}" diventano numero/booleano/oggetto invece di restare ' +
      'stringhe; ' +
      '(2) RINOMINA — un editor che sposta un campo da un percorso a un altro (allinea i nomi dei campi tra ' +
      'sistemi: "Email" → "email", "user.mail" → "contatto.email"); ' +
      "(3) RIMUOVI — elenca i campi da eliminare (togli PII, campi tecnici, rumore prima di inviare a un'API o " +
      'salvare); ' +
      '(4) SOLO QUESTI — quando attivo, parte da un oggetto vuoto e tiene esclusivamente i campi che imposti ' +
      '(whitelist totale, payload pulito e prevedibile). ' +
      "Opera su una copia (non muta l'input). Output: { result, fieldCount }. " +
      'Use case: normalizza un lead dal form (rinomina i campi, imposta source="web", rimuovi i campi nascosti); ' +
      'prepara il body esatto per un\'API a valle tenendo solo i campi attesi ("solo questi"); aggiungi metadati ' +
      '(timestamp, stato) a un record; ripulisci un payload webhook dai campi sensibili prima di loggarlo.',
    configFields: [
      {
        key: 'source',
        label: 'Oggetto sorgente',
        type: 'expression',
        required: false,
        defaultValue: 'input',
        help: "L'oggetto da modellare. Vuoto = usa l'input del nodo.",
      },
      {
        key: 'assignments',
        label: 'Imposta campi (percorso → valore)',
        type: 'key-value',
        required: false,
        help: 'Ogni riga crea/sovrascrive un campo (dot-path supportato). Es. cliente.stato → attivo.',
      },
      {
        key: 'coerceTypes',
        label: 'Converti tipi automaticamente',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help: '"42"→numero, "true"→booleano, JSON→oggetto. Disattiva per tenere tutto come stringa.',
      },
      {
        key: 'renameFields',
        label: 'Rinomina campi (da → a)',
        type: 'key-value',
        required: false,
        help: 'Sposta un campo da un percorso a un altro. Es. Email → email.',
      },
      {
        key: 'removeFields',
        label: 'Rimuovi campi',
        type: 'chip-list',
        required: false,
        help: 'Percorsi dei campi da eliminare (separati da virgola).',
      },
      {
        key: 'keepOnly',
        label: 'Tieni solo i campi impostati',
        type: 'boolean',
        required: false,
        help: 'Parte da un oggetto vuoto: il risultato contiene SOLO i campi che imposti (whitelist).',
      },
    ],
    outputs: ['default'],
    outputContract: {
      notes: 'L\'oggetto modificato sta in `result`, NON al primo livello: le espressioni a valle devono passare da li` — `{{$node.<id>.json.result.<campo>}}`. Leggere il campo direttamente sul nodo non trova niente.',
      fields: [
        { name: 'result', type: 'object', desc: 'L\'oggetto con i campi impostati, rinominati o tolti.' },
        { name: 'fieldCount', type: 'number', desc: 'Quanti campi ha l\'oggetto risultante.' },
      ],
    },
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: setFieldsExecutor,
};

// ════════════════════════════════════════════════════════════════════════
// action_coalesce — primo valore presente
// ════════════════════════════════════════════════════════════════════════
const coalesceExecutor: NodeExecutor = async (config, input) => {
  const startedAt = Date.now();
  const src = config.source !== undefined && str(config.source) !== '' ? config.source : input;
  const source: unknown =
    typeof src === 'string'
      ? (() => {
          try {
            return JSON.parse(src) as unknown;
          } catch {
            return src;
          }
        })()
      : src;
  const treatEmptyAsMissing = str(config.treatEmptyAsMissing, 'true') !== 'false';
  const paths = str(config.paths)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  let chosen: unknown;
  let chosenFrom: string | null = null;
  for (const p of paths) {
    const v = getPath(source, p);
    const missing = v === undefined || v === null || (treatEmptyAsMissing && v === '');
    if (!missing) {
      chosen = v;
      chosenFrom = p;
      break;
    }
  }
  if (chosenFrom === null && config.default !== undefined && str(config.default) !== '') {
    chosen = coerce(config.default);
    chosenFrom = '(default)';
  }
  return {
    output: {
      result: chosen ?? null,
      from: chosenFrom,
      found: chosenFrom !== null && chosenFrom !== '(default)',
    },
    durationMs: Date.now() - startedAt,
  };
};

export const coalesceNode: NodeModule = {
  def: {
    id: 'action_coalesce',
    type: 'action',
    label: 'Primo valido',
    icon: 'git-merge',
    color: '#65a30d',
    description:
      'Restituisce il PRIMO valore presente tra più sorgenti, con un valore di default finale — il pattern ' +
      '"fallback a catena" (coalesce) che in SQL è COALESCE() e nel codice sono i ?? concatenati, qui in un nodo ' +
      'a prova di idiota (JavaScript puro, zero dipendenze). Indichi un elenco ordinato di percorsi (dot-path) ' +
      "dell'oggetto in ingresso e il nodo prova il primo, se manca passa al secondo, e così via, fermandosi al " +
      'primo che ha un valore. Con l\'opzione "stringa vuota = mancante" (attiva di default) anche i campi ' +
      'presenti ma vuoti vengono saltati — così non propaghi mai un "" dove ti serviva un dato reale. Se nessuna ' +
      'sorgente ha un valore, usa il default che fornisci. Restituisce anche da QUALE sorgente è arrivato il ' +
      'valore (campo "from"), utile per il debug e l\'audit. ' +
      'Output: { result, from, found }. ' +
      'Use case: nome visualizzato = primo tra nickname, nome+cognome, email, "Cliente" (default); email di ' +
      'contatto = primo tra email_aziendale, email_personale, email_fatturazione; prezzo = primo tra prezzo_scontato ' +
      'e prezzo_listino; lingua = primo tra preferenza_utente, header_accept_language, "it".',
    configFields: [
      {
        key: 'source',
        label: 'Oggetto sorgente',
        type: 'expression',
        required: false,
        defaultValue: 'input',
        help: "L'oggetto da cui leggere. Vuoto = usa l'input del nodo.",
      },
      {
        key: 'paths',
        label: 'Percorsi in ordine di priorità',
        type: 'chip-list',
        required: true,
        placeholder: 'nickname, profilo.nome, email',
        help: 'Elenco ordinato di dot-path: viene scelto il primo che ha un valore.',
      },
      {
        key: 'default',
        label: 'Valore di default',
        type: 'text',
        required: false,
        help: 'Usato se nessuna sorgente ha un valore.',
      },
      {
        key: 'treatEmptyAsMissing',
        label: 'Stringa vuota = mancante',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help: 'Salta anche i campi presenti ma vuoti ("").',
      },
    ],
    outputs: ['default'],
    outputContract: {
      notes: '`found` distingue un valore trovato davvero da uno preso dal ripiego: e` la differenza che serve per non trattare un predefinito come un dato reale.',
      fields: [
        { name: 'result', type: 'object|string|number|null', desc: 'Il primo valore non vuoto fra quelli provati. Null se non ce n\'era nessuno e non c\'era un ripiego.' },
        { name: 'from', type: 'string|null', desc: 'Da quale campo l\'ha preso, oppure \'(default)\' se e` il ripiego. Null se non ha trovato niente.' },
        { name: 'found', type: 'boolean', desc: 'Vero solo se il valore viene da un campo vero e non dal ripiego.' },
      ],
    },
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: coalesceExecutor,
};
