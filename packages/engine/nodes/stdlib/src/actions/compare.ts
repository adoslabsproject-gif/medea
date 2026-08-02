/**
 * action_diff — confronta due oggetti (deep diff: aggiunti/rimossi/modificati) o
 * due testi (diff per righe), in JavaScript puro (ZERO dipendenze, browser-safe).
 * Sostituisce il nodo Code per rilevare cosa è cambiato tra due stati.
 */
import type { NodeModule, NodeExecutor } from '../types.js';

function str(v: unknown, fallback = ''): string {
  return v === undefined || v === null ? fallback : String(v);
}
function parse(v: unknown): unknown {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}
function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Cap di profondità della ricorsione: un oggetto annidato all'infinito (o molto
// profondo) farebbe esplodere lo stack ("Maximum call stack size") → DoS del run.
// Oltre la soglia confrontiamo i due sottoalberi per valore (stringify) invece di
// continuare a discendere: nessun crash, il diff resta corretto al livello-foglia.
const MAX_DIFF_DEPTH = 64;

function diffObjects(
  a: unknown,
  b: unknown,
  prefix: string,
  acc: {
    added: Record<string, unknown>;
    removed: Record<string, unknown>;
    changed: Record<string, { from: unknown; to: unknown }>;
  },
  depth = 0,
): void {
  if (isObj(a) && isObj(b) && depth < MAX_DIFF_DEPTH) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const path = prefix ? `${prefix}.${k}` : k;
      const inA = k in a;
      const inB = k in b;
      if (inA && !inB) acc.removed[path] = a[k];
      else if (!inA && inB) acc.added[path] = b[k];
      else diffObjects(a[k], b[k], path, acc, depth + 1);
    }
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    acc.changed[prefix] = { from: a, to: b };
  }
}

function diffText(a: string, b: string): { type: 'add' | 'remove' | 'equal'; line: string }[] {
  const la = a.split('\n');
  const lb = b.split('\n');
  const setB = new Set(lb);
  const setA = new Set(la);
  const out: { type: 'add' | 'remove' | 'equal'; line: string }[] = [];
  // diff per righe semplice e leggibile: rimosse (in A non in B), poi comuni/aggiunte secondo B
  for (const line of la) if (!setB.has(line)) out.push({ type: 'remove', line });
  for (const line of lb) out.push({ type: setA.has(line) ? 'equal' : 'add', line });
  return out;
}

const diffExecutor: NodeExecutor = async (config, input) => {
  const startedAt = Date.now();
  const mode = str(config.mode, 'object');
  const a = parse(config.a !== undefined && str(config.a) !== '' ? config.a : input);
  const b = parse(config.b);

  if (mode === 'text') {
    const changes = diffText(str(a), str(b));
    const added = changes.filter((c) => c.type === 'add').length;
    const removed = changes.filter((c) => c.type === 'remove').length;
    return {
      output: { changes, added, removed, equal: added === 0 && removed === 0 },
      durationMs: Date.now() - startedAt,
    };
  }

  const acc = {
    added: {},
    removed: {},
    changed: {} as Record<string, { from: unknown; to: unknown }>,
  };
  diffObjects(a, b, '', acc);
  const equal =
    Object.keys(acc.added).length === 0 &&
    Object.keys(acc.removed).length === 0 &&
    Object.keys(acc.changed).length === 0;
  return {
    output: {
      added: acc.added,
      removed: acc.removed,
      changed: acc.changed,
      equal,
      changeCount:
        Object.keys(acc.added).length +
        Object.keys(acc.removed).length +
        Object.keys(acc.changed).length,
    },
    branch: equal ? 'equal' : 'different',
    durationMs: Date.now() - startedAt,
  };
};

export const diffNode: NodeModule = {
  def: {
    id: 'action_diff',
    type: 'action',
    label: 'Confronta',
    icon: 'git-compare',
    color: '#ea580c',
    description:
      'Confronta due valori e rileva ESATTAMENTE cosa è cambiato, in JavaScript puro (zero dipendenze) — ciò che ' +
      'altrimenti richiede un nodo Code con logica ricorsiva. Due modalità da dropdown: ' +
      '(1) OGGETTO — confronto profondo (deep diff) tra due oggetti/JSON: restituisce i campi AGGIUNTI, quelli ' +
      'RIMOSSI e quelli MODIFICATI (con valore "from" e "to"), ognuno identificato dal suo percorso dot-path anche ' +
      'se annidato — per capire cosa è cambiato tra il record vecchio e quello nuovo (audit, change-detection, ' +
      'sincronizzazioni); ' +
      '(2) TESTO — confronto riga per riga tra due testi: marca ogni riga come aggiunta, rimossa o invariata, per ' +
      'evidenziare le differenze tra due versioni di un documento, una configurazione, una risposta. ' +
      'Il nodo è RAMIFICATO ("equal" / "different") così attivi un flusso solo quando qualcosa è effettivamente ' +
      'cambiato, evitando lavoro inutile. Entrambi gli input accettano oggetti nativi o stringhe JSON/testo. ' +
      'Output OGGETTO: { added, removed, changed, equal, changeCount } · TESTO: { changes, added, removed, equal }. ' +
      'Use case: rileva quali campi di un cliente sono cambiati per aggiornare solo quelli sul CRM (deep diff); ' +
      'attiva un alert solo se la configurazione monitorata è cambiata (branch different); confronta la risposta ' +
      "di un'API con quella precedente per change-detection; mostra le differenze tra due versioni di un testo.",
    configFields: [
      {
        key: 'mode',
        label: 'Modalità',
        type: 'select',
        required: true,
        defaultValue: 'object',
        options: ['object', 'text'],
        help: 'object = deep diff tra oggetti · text = diff riga per riga.',
      },
      {
        key: 'a',
        label: 'Valore A (precedente)',
        type: 'expression',
        required: false,
        defaultValue: 'input',
        help: 'Il primo valore (lo stato "prima"). Vuoto = usa l\'input del nodo.',
      },
      {
        key: 'b',
        label: 'Valore B (nuovo)',
        type: 'expression',
        required: true,
        help: 'Il secondo valore (lo stato "dopo") da confrontare con A.',
      },
    ],
    outputs: ['equal', 'different'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: diffExecutor,
};
