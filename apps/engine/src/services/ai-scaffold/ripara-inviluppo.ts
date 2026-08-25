/**
 * Campi dell'inviluppo finiti dentro `nodes`.
 *
 * Il 2026-08-06 il modello ha consegnato ventisei «nodi» con
 * `defId: "tablesToCreate"`. Non è un nodo e non esiste nel catalogo:
 * `tablesToCreate` è un campo di primo livello del JSON, fratello di `nodes` e
 * `edges`. Il modello lo ha scambiato per un tipo di nodo e lo ha ripetuto
 * finché non ha esaurito lo spazio.
 *
 * La causa immediata era nostra: il prompt mostrava quel campo dentro un
 * esempio JSON, l'esempio è stato tolto — faceva scattare la protezione
 * anti-leak del modello — e con lui è sparita l'unica riga che diceva DOVE
 * quel campo vivesse. Il prompt adesso lo dice a parole.
 *
 * Ma un prompt è una richiesta, non una garanzia. Questo modulo ripara lo
 * sbaglio senza chiedere niente a nessuno: è la differenza fra sperare che il
 * modello capisca e fare in modo che l'errore non conti.
 *
 * @module services/ai-scaffold/ripara-inviluppo
 */

/**
 * I nomi dei campi di primo livello del JSON.
 *
 * Nessuno di questi è un `defId`. Se compaiono come tipo di nodo, il modello
 * ha confuso l'involucro con il contenuto.
 */
const CAMPI_DELL_INVILUPPO: ReadonlySet<string> = new Set([
  'tablesToCreate',
  'tables_to_create',
  'nodes',
  'edges',
  'reasoning',
  'description',
]);

/**
 * Un «nodo» che in realtà è un ARCO.
 *
 * Il 2026-08-16 il modello ha consegnato cinquantasei nodi con `defId` come
 * `edge_trigger_cron_community_slack`: aveva messo i collegamenti dentro
 * `nodes`, dando a ciascuno un nome composto da «edge» più i due estremi.
 *
 * Nessun `defId` del catalogo comincia per `edge_`, e nessuno mai lo farà: è
 * il prefisso con cui si nominano i collegamenti, non i nodi. Riconoscerlo
 * costa una riga e salva un workflow intero.
 */
function eUnArco(defId: string): boolean {
  return /^edge[_-]/i.test(defId);
}

interface NodoGrezzo {
  id: string;
  defId: string;
  config: Record<string, unknown>;
}

export interface EsitoRiparazione<T> {
  nodi: T[];
  /** Le tabelle recuperate dai finti nodi, da unire a quelle dichiarate. */
  tabelleRecuperate: { name: string; columns: { name: string; type: string }[] }[];
  /** Quanti finti nodi sono stati tolti. Zero = niente da riparare. */
  tolti: number;
}

/** Una tabella riconoscibile dentro la configurazione di un finto nodo. */
function tabellaDa(config: Record<string, unknown>): {
  name: string;
  columns: { name: string; type: string }[];
} | null {
  const nome = config.name ?? config.table;
  if (typeof nome !== 'string' || nome.trim() === '') return null;

  const grezze = Array.isArray(config.columns) ? config.columns : [];
  const columns = grezze
    .map((c) => {
      if (c === null || typeof c !== 'object') return null;
      const col = c as { name?: unknown; type?: unknown };
      if (typeof col.name !== 'string' || col.name.trim() === '') return null;
      return { name: col.name, type: typeof col.type === 'string' ? col.type : 'text' };
    })
    .filter((c): c is { name: string; type: string } => c !== null);

  // Una tabella senza colonne non si può creare: meglio scartarla che
  // consegnare al server una migrazione che fallirà.
  return columns.length > 0 ? { name: nome, columns } : null;
}

/**
 * Toglie da `nodes` ciò che non è un nodo, e salva il salvabile.
 *
 * Un finto nodo `tablesToCreate` che porta con sé nome e colonne descrive una
 * tabella vera: buttarlo perderebbe un'informazione che il modello ha dato
 * bene, solo nel posto sbagliato.
 */
export function riparaInviluppo<T extends NodoGrezzo>(nodi: readonly T[]): EsitoRiparazione<T> {
  const tenuti: T[] = [];
  const tabelleRecuperate: EsitoRiparazione<T>['tabelleRecuperate'] = [];
  const gia = new Set<string>();

  for (const nodo of nodi) {
    if (!CAMPI_DELL_INVILUPPO.has(nodo.defId) && !eUnArco(nodo.defId)) {
      tenuti.push(nodo);
      continue;
    }
    const tabella = tabellaDa(nodo.config);
    // Ventisei copie dello stesso sbaglio producevano ventisei tabelle uguali.
    if (tabella && !gia.has(tabella.name)) {
      gia.add(tabella.name);
      tabelleRecuperate.push(tabella);
    }
  }

  return { nodi: tenuti, tabelleRecuperate, tolti: nodi.length - tenuti.length };
}
