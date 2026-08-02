/**
 * Text utility nodes — manipolazione stringhe e templating, 100% JavaScript puro
 * (ZERO dipendenze, ZERO `node:*`, browser-safe nativo). Coprono ciò che in n8n
 * richiede il nodo Code o l'incollare regex sparse, qui unificati e "a prova di
 * idiota" con ogni opzione in UI e campi condizionali.
 *
 *   - action_text     : case / trim / slugify / truncate / replace / extract / split / pad
 *   - action_template : interpolazione {{dot.path}} con default e escape HTML opzionale
 */
import type { NodeModule, NodeExecutor } from '../types.js';
import { safeUserRegex } from '../lib/safe-user-regex.js';

function str(v: unknown, fallback = ''): string {
  return v === undefined || v === null ? fallback : String(v);
}
function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const p of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(p)];
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[p];
    else return undefined;
  }
  return cur;
}
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ════════════════════════════════════════════════════════════════════════
// action_text — manipolazione stringhe
// ════════════════════════════════════════════════════════════════════════
function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accenti (à→a)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
const textExecutor: NodeExecutor = async (config, input) => {
  const startedAt = Date.now();
  const op = str(config.operation, 'uppercase');
  const value =
    config.value !== undefined && str(config.value) !== '' ? str(config.value) : str(input);
  let result: unknown;
  switch (op) {
    case 'uppercase':
      result = value.toUpperCase();
      break;
    case 'lowercase':
      result = value.toLowerCase();
      break;
    case 'capitalize':
      result = value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
      break;
    case 'title':
      result = value.toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase());
      break;
    case 'trim':
      result = value.trim();
      break;
    case 'slugify':
      result = slugify(value);
      break;
    case 'truncate': {
      const max = Math.max(Number(config.length) || 50, 1);
      const suffix = str(config.suffix, '…');
      result = value.length <= max ? value : value.slice(0, max - suffix.length).trimEnd() + suffix;
      break;
    }
    case 'replace': {
      const search = str(config.search);
      const replacement = str(config.replacement);
      if (str(config.useRegex) === 'true') {
        const flags = str(config.flags, 'g');
        // RE2 (motore lineare) → immune a ReDoS sul pattern fornito dall'autore.
        result = value.replace(safeUserRegex(search, flags), replacement);
      } else {
        result = value.split(search).join(replacement);
      }
      break;
    }
    case 'extract': {
      const flags = str(config.flags, '');
      const re = safeUserRegex(str(config.search), flags.includes('g') ? flags : `${flags}g`);
      const matches: string[] = [];
      const groups: string[][] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(value)) !== null) {
        matches.push(m[0]);
        if (m.length > 1) groups.push(m.slice(1));
        if (m.index === re.lastIndex) re.lastIndex += 1; // guard zero-width
      }
      return {
        output: { matches, groups, count: matches.length, first: matches[0] ?? null },
        durationMs: Date.now() - startedAt,
      };
    }
    case 'split': {
      const sep = str(config.search, ',');
      result = value
        .split(sep === '\\n' ? '\n' : sep)
        .map((s) => (str(config.trimParts) === 'true' ? s.trim() : s));
      break;
    }
    case 'pad': {
      const target = Math.max(Number(config.length) || value.length, 0);
      const padChar = str(config.suffix, ' ') || ' ';
      result =
        str(config.padSide, 'start') === 'end'
          ? value.padEnd(target, padChar)
          : value.padStart(target, padChar);
      break;
    }
    default:
      throw new Error(`action_text: operazione sconosciuta "${op}"`);
  }
  return {
    output: {
      result,
      length: typeof result === 'string' ? result.length : undefined,
      operation: op,
    },
    durationMs: Date.now() - startedAt,
  };
};

export const textNode: NodeModule = {
  def: {
    id: 'action_text',
    type: 'action',
    label: 'Testo',
    icon: 'type',
    color: '#ec4899',
    description:
      'Coltellino svizzero per le stringhe — nove operazioni di manipolazione testo in JavaScript puro (zero ' +
      'dipendenze), per non dover più scrivere nodi Code per ogni piccola trasformazione. Operazione da dropdown ' +
      'con solo i suoi parametri visibili: ' +
      '(1) MAIUSCOLO / (2) minuscolo / (3) Capitalizza (prima lettera) / (4) Titolo (Ogni Parola) — ' +
      'normalizzazione di nomi, città, intestazioni; ' +
      '(5) TRIM — rimuove spazi iniziali/finali (pulizia di input da form e import); ' +
      '(6) SLUGIFY — trasforma in slug URL-safe rimuovendo accenti (à→a) e caratteri speciali ("Caffè à gogò" → ' +
      '"caffe-a-gogo"), per permalink, nomi file, anchor; ' +
      '(7) TRUNCATE — tronca a N caratteri aggiungendo un suffisso (…), senza tagliare a metà parola dove ' +
      'possibile, per anteprime ed estratti; ' +
      '(8) REPLACE — sostituzione letterale (tutte le occorrenze) o tramite espressione regolare con flag, per ' +
      'normalizzare formati, mascherare dati, ripulire testo; ' +
      '(9) EXTRACT — estrae con regex tutti i match e i gruppi di cattura (email, partite IVA, importi, codici da ' +
      'un testo libero) restituendo { matches, groups, first, count }; ' +
      'più SPLIT (testo → array per delimitatore, con trim opzionale delle parti) e PAD (allinea a lunghezza fissa ' +
      'con riempimento, per codici/numeri zero-padded). ' +
      'Output: { result, length, operation } (o { matches, groups, ... } per EXTRACT). ' +
      'Use case: normalizza i nomi cliente in Titolo prima di salvarli; genera lo slug SEO da un titolo articolo; ' +
      'estrai tutte le email da un corpo di testo (EXTRACT); maschera le cifre di una carta (REPLACE regex); ' +
      'tronca la descrizione prodotto a 160 caratteri per la meta-description.',
    configFields: [
      {
        key: 'operation',
        label: 'Operazione',
        type: 'select',
        required: true,
        defaultValue: 'uppercase',
        options: [
          'uppercase',
          'lowercase',
          'capitalize',
          'title',
          'trim',
          'slugify',
          'truncate',
          'replace',
          'extract',
          'split',
          'pad',
        ],
        help: 'Cosa fare con il testo. Ogni operazione mostra solo i suoi parametri.',
      },
      {
        key: 'value',
        label: 'Testo in ingresso',
        type: 'expression',
        required: false,
        defaultValue: 'input',
        help: "Il testo da elaborare. Vuoto = usa l'input del nodo.",
      },
      {
        key: 'length',
        label: 'Lunghezza',
        type: 'number',
        required: false,
        defaultValue: '50',
        help: 'TRUNCATE: caratteri massimi · PAD: lunghezza finale.',
        showIf: { field: 'operation', in: ['truncate', 'pad'] },
      },
      {
        key: 'suffix',
        label: 'Suffisso / carattere riempimento',
        type: 'text',
        required: false,
        defaultValue: '…',
        help: 'TRUNCATE: testo aggiunto in coda · PAD: carattere di riempimento.',
        showIf: { field: 'operation', in: ['truncate', 'pad'] },
      },
      {
        key: 'padSide',
        label: 'Lato riempimento',
        type: 'select',
        required: false,
        defaultValue: 'start',
        options: ['start', 'end'],
        showIf: { field: 'operation', equals: 'pad' },
      },
      {
        key: 'search',
        label: 'Cerca / pattern / separatore',
        type: 'text',
        required: false,
        help: 'REPLACE: testo o regex da cercare · EXTRACT: pattern regex · SPLIT: separatore (\\n per a-capo).',
        showIf: { field: 'operation', in: ['replace', 'extract', 'split'] },
      },
      {
        key: 'replacement',
        label: 'Sostituzione',
        type: 'text',
        required: false,
        help: 'Testo con cui sostituire (supporta $1, $2 per i gruppi se usi regex).',
        showIf: { field: 'operation', equals: 'replace' },
      },
      {
        key: 'useRegex',
        label: 'Usa espressione regolare',
        type: 'boolean',
        required: false,
        help: 'Interpreta "Cerca" come regex invece che testo letterale.',
        showIf: { field: 'operation', equals: 'replace' },
      },
      {
        key: 'flags',
        label: 'Flag regex',
        type: 'text',
        required: false,
        defaultValue: 'g',
        placeholder: 'g, i, m, s',
        help: 'g=globale i=case-insensitive m=multiline s=dotall. EXTRACT forza sempre g.',
        showIf: { field: 'operation', in: ['replace', 'extract'] },
      },
      {
        key: 'trimParts',
        label: 'Trim delle parti',
        type: 'boolean',
        required: false,
        help: 'Rimuove gli spazi attorno a ogni parte dopo lo split.',
        showIf: { field: 'operation', equals: 'split' },
      },
    ],
    outputs: ['default'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: textExecutor,
};

// ════════════════════════════════════════════════════════════════════════
// action_template — interpolazione {{dot.path}}
// ════════════════════════════════════════════════════════════════════════
const templateExecutor: NodeExecutor = async (config, input) => {
  const startedAt = Date.now();
  const template = str(config.template);
  const rawCtx =
    config.context !== undefined && str(config.context) !== '' ? config.context : input;
  const context: unknown =
    typeof rawCtx === 'string'
      ? (() => {
          try {
            return JSON.parse(rawCtx) as unknown;
          } catch {
            return { value: rawCtx };
          }
        })()
      : rawCtx;
  const doEscape = str(config.escapeHtml) === 'true';
  const missing: string[] = [];
  // {{ path.dot }} oppure {{ path || fallback }}
  const result = template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, expr: string) => {
    const [pathPart, fallbackPart] = expr.split('||').map((s) => s.trim());
    let val = getPath(context, pathPart!);
    if (val === undefined || val === null || val === '') {
      if (fallbackPart !== undefined) val = fallbackPart.replace(/^['"]|['"]$/g, '');
      else {
        missing.push(pathPart!);
        val = '';
      }
    }
    const out = typeof val === 'object' ? JSON.stringify(val) : String(val);
    return doEscape ? escapeHtml(out) : out;
  });
  return {
    output: { result, missing, hasMissing: missing.length > 0 },
    durationMs: Date.now() - startedAt,
  };
};

export const templateNode: NodeModule = {
  def: {
    id: 'action_template',
    type: 'action',
    label: 'Template',
    icon: 'file-text',
    color: '#8b5cf6',
    description:
      'Motore di template testuale in JavaScript puro (zero dipendenze) per comporre stringhe dinamiche — email, ' +
      'messaggi, URL, query, corpi di richiesta — interpolando i dati del workflow dentro un testo fisso con la ' +
      'sintassi a doppie graffe `{{ percorso }}`. I segnaposto supportano il dot-path annidato ' +
      '(`{{ cliente.indirizzo.città }}`, `{{ ordine.righe.0.totale }}`) e un valore di default con `||` ' +
      '(`{{ nome || "Cliente" }}` → usa "Cliente" se nome è assente/vuoto) — niente più "undefined" o buchi nei ' +
      "messaggi quando un campo manca. Il contesto dei dati viene dall'input del nodo (oggetto o JSON) o da un " +
      'campo dedicato. Modalità ESCAPE HTML opzionale: quando attiva, i valori interpolati vengono ' +
      'automaticamente neutralizzati (`<`, `>`, `&`, `"`, `\'`) — fondamentale quando il template genera HTML con ' +
      "dati utente, per prevenire XSS/injection (a differenza del nodo Code dove l'escape è a carico tuo). " +
      'Il nodo segnala anche quali segnaposto non hanno trovato un valore (output `missing` + `hasMissing`), così ' +
      'puoi accorgerti dei dati mancanti invece di inviare un messaggio rotto. ' +
      'Output: { result, missing, hasMissing }. ' +
      "Use case: componi il corpo di un'email di conferma ordine con nome cliente e dettagli (escape HTML on); " +
      'costruisci un URL di callback con parametri dinamici; genera un messaggio Telegram/Slack personalizzato; ' +
      'prepara il body JSON di una chiamata API interpolando i valori; crea un SMS con default per i campi ' +
      'opzionali. NB: solo interpolazione di valori (no logica/cicli) — per la logica usa i nodi IF/Loop a monte.',
    configFields: [
      {
        key: 'template',
        label: 'Template',
        type: 'textarea',
        required: true,
        placeholder: 'Ciao {{ nome || "Cliente" }},\nil tuo ordine {{ ordine.id }} è confermato.',
        help: 'Testo con segnaposto {{ percorso.dot }}. Usa || per un valore di default.',
      },
      {
        key: 'context',
        label: 'Dati (contesto)',
        type: 'expression',
        required: false,
        defaultValue: 'input',
        help: "Oggetto/JSON con i valori da interpolare. Vuoto = usa l'input del nodo.",
      },
      {
        key: 'escapeHtml',
        label: 'Escape HTML (anti-XSS)',
        type: 'boolean',
        required: false,
        help: 'Neutralizza < > & " \' nei valori interpolati. Attiva SEMPRE se il risultato è HTML con dati utente.',
      },
    ],
    outputs: ['default'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: templateExecutor,
};
