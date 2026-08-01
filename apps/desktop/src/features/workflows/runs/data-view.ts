/**
 * Come si guarda quello che un nodo ha prodotto.
 *
 * Il JSON indentato va bene per dieci righe. Per una risposta HTTP vera —
 * intestazioni, corpo, un array di cinquanta elementi — è un muro in cui la
 * cosa che si cerca sta a schermata tre.
 *
 * Da qui due modi di leggere gli stessi dati:
 *
 *   ALBERO   si apre un ramo alla volta, e ogni foglia sa dire l'espressione
 *            che la raggiunge — che è la domanda vera: «come ci arrivo da un
 *            altro nodo?»
 *   TABELLA  per gli array di oggetti, dove le chiavi si ripetono: una riga
 *            per elemento, una colonna per chiave. Cinquanta righe di JSON
 *            diventano una tabella che si legge in un colpo.
 *
 * Qui c'è solo la logica: costruire i rami, capire se una tabella ha senso.
 * Il disegno sta nei componenti.
 */

/** Un nodo dell'albero. */
export interface Ramo {
  /** La chiave, o l'indice fra parentesi per gli elementi di un array. */
  key: string;
  /** Il percorso completo da cui nasce l'espressione. */
  path: string;
  value: unknown;
  /** Che tipo di valore è, detto in italiano. */
  kind: 'oggetto' | 'lista' | 'testo' | 'numero' | 'booleano' | 'vuoto';
  /** Quanti figli ha, per i rami che si aprono. */
  size?: number;
}

function kindOf(value: unknown): Ramo['kind'] {
  if (value === null || value === undefined) return 'vuoto';
  if (Array.isArray(value)) return 'lista';
  switch (typeof value) {
    case 'object':
      return 'oggetto';
    case 'number':
      return 'numero';
    case 'boolean':
      return 'booleano';
    default:
      return 'testo';
  }
}

/**
 * I figli diretti di un valore.
 *
 * Un livello per volta: costruire tutto l'albero in anticipo su una risposta
 * grossa vorrebbe dire migliaia di oggetti creati per mostrarne dieci.
 */
function ramo(key: string, path: string, value: unknown): Ramo {
  const size = sizeOf(value);
  return {
    key,
    path,
    value,
    kind: kindOf(value),
    ...(size !== undefined ? { size } : {}),
  };
}

export function childrenOf(value: unknown, basePath: string): Ramo[] {
  if (Array.isArray(value)) {
    return value.map((v, i) => ramo(`[${String(i)}]`, `${basePath}[${String(i)}]`, v));
  }

  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(([key, v]) =>
      // Le chiavi che non sono identificatori vanno fra parentesi quadre,
      // altrimenti l'espressione che si copia non si risolve.
      ramo(
        key,
        /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
          ? `${basePath}.${key}`
          : `${basePath}[${JSON.stringify(key)}]`,
        v,
      ),
    );
  }

  return [];
}

function sizeOf(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return undefined;
}

/** Un valore come lo si legge in una riga sola. */
export function summarize(value: unknown, kind: Ramo['kind'], size?: number): string {
  switch (kind) {
    case 'vuoto':
      return value === null ? 'null' : '—';
    case 'lista':
      return size === 1 ? '1 elemento' : `${String(size ?? 0)} elementi`;
    case 'oggetto':
      return size === 1 ? '1 campo' : `${String(size ?? 0)} campi`;
    case 'testo': {
      const testo = String(value);
      return testo.length > 80 ? `${testo.slice(0, 77)}…` : testo;
    }
    default:
      return String(value);
  }
}

export interface Tabella {
  columns: string[];
  rows: Record<string, unknown>[];
}

/**
 * La tabella, se questi dati ne meritano una.
 *
 * Serve un array di oggetti: una lista di numeri non è una tabella, e un
 * oggetto solo nemmeno. Le colonne sono l'unione delle chiavi — un elemento
 * a cui ne manca una lascia la cella vuota invece di far sparire la colonna.
 */
export function asTable(value: unknown): Tabella | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const righe = value.filter(
    (v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v),
  );
  // Se non sono tutti oggetti, la tabella mentirebbe su cosa c'è nella lista.
  if (righe.length !== value.length) return null;

  const columns: string[] = [];
  for (const riga of righe) {
    for (const key of Object.keys(riga)) if (!columns.includes(key)) columns.push(key);
  }
  return columns.length > 0 ? { columns, rows: righe } : null;
}

/**
 * Il valore di una cella, come si scrive in una tabella.
 *
 * Si elenca cosa si sa stampare, e tutto il resto è un contenitore: srotolare
 * un oggetto dentro una cella la renderebbe illeggibile, e `String()` su di
 * esso scriverebbe «[object Object]», che è peggio di dire che c'è qualcosa.
 */
export function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${String(value.length)}]`;
  return '{…}';
}
