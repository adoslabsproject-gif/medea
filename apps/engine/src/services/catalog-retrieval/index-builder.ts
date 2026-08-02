/**
 * Index del catalogo nodi — AUTO-DERIVATO dai NodeDef (single source of truth).
 *
 * Regola di ferro anti-drift (richiesta owner 2026-06-12): l'index NON si
 * scrive a mano. Si genera dai `NodeCatalogEntry` (= buildNodeCatalog, che a
 * sua volta deriva da ALL_NODE_MODULES + community installati del tenant).
 * Aggiungi un nodo → al prossimo build è già qui, keyword/categoria/embedding
 * inclusi. Il test catalog-index.test.ts FALLISCE se un nodo del catalogo non
 * è nell'index → copertura 100% garantita dal CI, niente "ricontrollare a mano".
 *
 * Ogni record è la forma COMPATTA per il retrieval (keyword + 1 frase). La
 * spec COMPLETA (config, description ricca) si recupera on-demand via
 * getNodeSpec — è il pattern "leggi i dettagli solo del nodo che stai
 * valutando" descritto dall'owner.
 *
 * @module services/catalog-retrieval/index-builder
 */

import type { NodeCatalogEntry } from '@/services/ai-scaffold/node-catalog.js';
import type { OutputContract } from '@medea/engine-core-schema';
import { inferCategory, type CatalogCategory } from './category.js';

export interface CatalogRecord {
  defId: string;
  type: string;
  label: string;
  category: CatalogCategory;
  /** Prima frase della description (≤140 char) — la riga del catalogo "breve". */
  shortDesc: string;
  /** Termini estratti per il match lessicale (id, label, categoria, parole chiave desc). */
  keywords: string[];
  /** Testo denso usato per l'embedding semantico e il match lessicale fallback. */
  searchText: string;
  /**
   * Testo per l'EMBEDDING semantico: searchText + sezione "Use case:" della
   * description (le description sono ricche di casi d'uso reali — la prima
   * frase da sola sottousa il segnale semantico). SEPARATO da searchText: il
   * lessicale resta sul testo stretto (golden eval calibrata lì), il
   * semantico beneficia del contesto in più. Content-addressed nello store
   * persistente: cambiare questo testo invalida (correttamente) il vettore.
   */
  embedText: string;
  /**
   * Contratto di output (cosa ritorna + edge-case) — grounding per l'ANALISI dei
   * workflow da parte dell'AI. NON entra in embedText/searchText (serve all'analisi,
   * non alla ricerca → non invalida i vettori). Presente solo per i nodi che lo dichiarano.
   */
  outputContract?: OutputContract;
}

/** Stopword IT+EN: parole troppo comuni per discriminare un nodo. */
const STOPWORDS = new Set([
  'il',
  'lo',
  'la',
  'i',
  'gli',
  'le',
  'un',
  'uno',
  'una',
  'di',
  'a',
  'da',
  'in',
  'con',
  'su',
  'per',
  'tra',
  'fra',
  'e',
  'o',
  'ma',
  'che',
  'come',
  'del',
  'della',
  'dei',
  'delle',
  'al',
  'allo',
  'alla',
  'ai',
  'agli',
  'alle',
  'è',
  'sono',
  'non',
  'si',
  'se',
  'più',
  'ogni',
  'dal',
  'the',
  'a',
  'an',
  'of',
  'to',
  'in',
  'on',
  'for',
  'and',
  'or',
  'with',
  'from',
  'by',
  'as',
  'is',
  'are',
  'be',
  'this',
  'that',
  'it',
  'its',
  'into',
  'via',
  'per',
  'node',
  'nodo',
]);

/**
 * Estrae la sezione "Use case:" dalla description (convenzione dei NodeDef
 * FlowForge: quasi ogni nodo elenca i casi d'uso reali). ≤300 char. Vuoto se
 * assente. Alimenta SOLO l'embedText (segnale semantico).
 */
export function useCaseSection(description: string, max = 300): string {
  const m = /use case:\s*([^]*?)(?:\n\n|$)/iu.exec(description);
  if (!m?.[1]) return '';
  const text = m[1].trim().replace(/\s+/gu, ' ');
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Prima frase, troncata. Per shortDesc + riga catalogo. */
export function firstSentence(text: string, max = 140): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const sentence = trimmed.split(/(?<=[.!?])\s/u)[0] ?? trimmed;
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Sinonimi IT↔EN canonizzati: ogni termine viene normalizzato alla forma
 * canonica PRIMA del match, su query E documenti — così "nodo codice" e
 * "code node" convergono sugli stessi token. Mappa CURATA e minima (ogni
 * voce sposta il ranking: niente speculazioni). Il bug "creami un nodo code"
 * (2026-06-12) era una CLASSE di problemi bilingue, non un caso singolo.
 */
const SYNONYM_CANON: Record<string, string> = {
  codice: 'code',
  funzione: 'function',
  invia: 'send',
  inviare: 'send',
  manda: 'send',
  mandare: 'send',
  spedisci: 'send',
  filtro: 'filter',
  filtra: 'filter',
  unisci: 'merge',
  ciclo: 'loop',
  cicla: 'loop',
  pianifica: 'schedule',
  pianificato: 'schedule',
  programma: 'schedule',
  ordina: 'sort',
  ordinare: 'sort',
  aspetta: 'wait',
  attendi: 'wait',
  raggruppa: 'group',
  raggruppare: 'group',
  traduci: 'translate',
  riassumi: 'summary',
};

/**
 * Tokenizza in termini normalizzati (lowercase, no accenti, no stopword,
 * ≥2 char, sinonimi canonizzati). Esportato: lo stesso tokenizer va usato su
 * query E documenti, o il match lessicale è incoerente (bug classico dei
 * retriever fatti a metà).
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '') // strip accenti (combining marks)
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map((t) => SYNONYM_CANON[t] ?? t);
}

/** Espande un id snake/camel in parole: `action_send_email` → [send, email]. */
function idWords(defId: string): string[] {
  return defId
    .replace(/^(action|trigger|logic|agent|integration|community|custom|db|ai)_/u, '')
    .split(/[_\s]+/u)
    .filter((w) => w.length >= 2);
}

/** Costruisce un CatalogRecord da una entry del catalogo. Pure. */
export function toRecord(entry: NodeCatalogEntry): CatalogRecord {
  const category = inferCategory(entry.defId, entry.type);
  const shortDesc = firstSentence(entry.description || entry.label);
  // searchText denso: id-words pesano (ripetuti), poi label, categoria, prima
  // frase. È ciò che embeddiamo e su cui facciamo il fallback lessicale.
  const words = idWords(entry.defId);
  // Alias dichiarati dal NodeDef stesso (searchAliases) — la fonte di verità
  // sta accanto al nodo, mantenuta dal suo autore (community inclusi), e il
  // test anti-drift la copre. Vedi NodeDefSchema.searchAliases in core-schema.
  const aliases = entry.searchAliases ?? [];
  const searchText = [
    words.join(' '),
    entry.label,
    category,
    shortDesc,
    // Alias nel searchText: alimentano anche l'embedding semantico.
    aliases.join(' '),
  ]
    .filter(Boolean)
    .join(' — ');
  // keyword set unico = id-words + label-words + categoria + termini desc + alias.
  // Gli alias passano da tokenize: la canonizzazione sinonimi deve valere
  // anche per loro, o un alias italiano non matcherebbe la query canonizzata.
  const keywords = Array.from(
    new Set([
      ...words,
      ...tokenize(entry.label),
      category,
      ...tokenize(shortDesc),
      ...aliases.flatMap((a) => tokenize(a)),
    ]),
  );
  const useCase = useCaseSection(entry.description || '');
  const embedText = useCase ? `${searchText} — Use case: ${useCase}` : searchText;
  const record: CatalogRecord = {
    defId: entry.defId,
    type: entry.type,
    label: entry.label,
    category,
    shortDesc,
    keywords,
    searchText,
    embedText,
  };
  if (entry.outputContract) record.outputContract = entry.outputContract;
  return record;
}

/**
 * Costruisce l'index completo dal catalogo. Deterministico, pure. Ordine
 * preservato (stabile per i test). Un solo record per defId (de-dup difensivo).
 */
export function buildCatalogIndex(entries: readonly NodeCatalogEntry[]): CatalogRecord[] {
  const byDefId = new Map<string, CatalogRecord>();
  for (const e of entries) {
    if (!byDefId.has(e.defId)) byDefId.set(e.defId, toRecord(e));
  }
  return Array.from(byDefId.values());
}

/** Raggruppa i record per categoria, ordine categoria stabile. */
export function groupByCategory(
  records: readonly CatalogRecord[],
): Map<CatalogCategory, CatalogRecord[]> {
  const out = new Map<CatalogCategory, CatalogRecord[]>();
  for (const r of records) {
    const list = out.get(r.category) ?? [];
    list.push(r);
    out.set(r.category, list);
  }
  return out;
}
