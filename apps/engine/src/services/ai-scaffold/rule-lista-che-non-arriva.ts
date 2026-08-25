/**
 * `LISTA_CHE_NON_ARRIVA` — un filtro puntato su qualcosa che non è una lista.
 *
 * Il 2026-08-16 il wizard ha consegnato «Email con parole chiave» così:
 *
 *     trigger_imap → action_filter → community_telegram
 *
 * Si legge bene e non lo è. `trigger_imap` produce UN messaggio: `subject`,
 * `from`, `text`, `date` — un oggetto, non un elenco. `action_filter` filtra
 * ARRAY: quando l'ingresso non è un array l'esecutore ripiega su `items = []`,
 * e da lì non passa niente perché non c'è niente da far passare.
 *
 * Il risultato non è un errore. È peggio:
 *
 *  - `kept` resta vuoto per ogni messaggio, urgente o no;
 *  - il nodo restituisce `{kept:[], removed:[], total:0}`, che è un output
 *    legittimo, e la corsa prosegue;
 *  - Telegram riceve quell'oggetto e manda l'avviso **per ogni email che
 *    arriva**, comprese quelle che non c'entrano niente.
 *
 * Cioè esattamente il contrario di quello che l'utente aveva chiesto: voleva
 * essere avvisato solo per «urgente» o «scadenza», e sarebbe stato avvisato
 * sempre. Un filtro che non filtra è invisibile finché non se ne guardano i
 * risultati.
 *
 * ── Cosa ci vuole invece ──
 *
 * Per decidere su UN elemento c'è `logic_if`, che valuta una condizione e
 * instrada. `action_filter` serve quando gli elementi sono molti — le righe di
 * una query, gli allegati, gli articoli di un feed.
 *
 * ── Perché non blocca lavoro legittimo ──
 *
 * Non indovina: confronta due cose dichiarate. Da una parte i campi su cui il
 * filtro dice di voler filtrare, dall'altra i campi che il nodo a monte dice
 * di produrre.
 *
 * Il segnale è preciso. Le regole di `action_filter` si applicano agli
 * ELEMENTI dell'array: `field: "subject"` vuol dire «ogni elemento ha un
 * `subject`». Se `subject` è invece un campo di primo livello di chi sta a
 * monte, allora quel nodo produce UN record con quel campo — e il modello ha
 * scambiato il record per l'elenco.
 *
 * Il contrario è altrettanto chiaro: `db_query` dichiara `rows: array`,
 * `rowCount`, `durationMs`. Chi filtra per «totale» o «stato» non tocca
 * nessuno di quei nomi, e la regola tace.
 *
 * Dove non c'è un contratto, o le regole non si leggono, la regola tace.
 *
 * @module services/ai-scaffold/rule-lista-che-non-arriva
 */

import { buildNodeCatalog } from '@/services/ai-scaffold/node-catalog.js';
import type { QualityGateInput, QualityIssue } from '@/services/ai-scaffold/quality-gate.js';

/**
 * I campi con cui un nodo dichiara DOVE prendere la lista.
 *
 * Riempiti, la lista arriva da un'espressione e non dall'ingresso: la regola
 * non ha niente da dire. Vuoti, si lavora su quello che passa dall'edge.
 */
const CAMPI_CHE_INDICANO_LA_SORGENTE: ReadonlySet<string> = new Set(['items', 'sourceExpression']);

/** Chi lavora su liste: dedotto dal catalogo, non scritto a mano. */
let listaioliCache: ReadonlySet<string> | null = null;

function lavoranoSuListe(): ReadonlySet<string> {
  listaioliCache ??= new Set(
    buildNodeCatalog()
      .filter((n) => (n.fields ?? []).some((f) => CAMPI_CHE_INDICANO_LA_SORGENTE.has(f.key)))
      .map((n) => n.defId),
  );
  return listaioliCache;
}

/** I contratti, per `defId`. Chi non ne ha resta assente e fa tacere la regola. */
let contrattiCache: ReadonlyMap<string, { name: string; type: string }[]> | null = null;

function contratti(): ReadonlyMap<string, { name: string; type: string }[]> {
  contrattiCache ??= new Map(
    buildNodeCatalog()
      .filter((n) => n.outputContract !== undefined)
      .map((n) => [
        n.defId,
        (n.outputContract?.fields ?? []).map((f) => ({ name: f.name, type: String(f.type) })),
      ]),
  );
  return contrattiCache;
}

/** I campi su cui il nodo dice di filtrare, comunque li abbia scritti. */
function campiDelleRegole(config: Record<string, unknown>): string[] {
  const grezzo = config.conditions ?? config.conditionRules;
  if (typeof grezzo !== 'string' || grezzo.trim() === '') return [];

  let letto: unknown;
  try {
    letto = JSON.parse(grezzo);
  } catch {
    return [];
  }
  const regole = Array.isArray(letto)
    ? letto
    : letto !== null && typeof letto === 'object' && Array.isArray((letto as { rules?: unknown }).rules)
      ? ((letto as { rules: unknown[] }).rules)
      : [];

  const nomi: string[] = [];
  for (const r of regole) {
    if (r === null || typeof r !== 'object') continue;
    const regola = r as { field?: unknown; left?: unknown };
    const grezza = typeof regola.field === 'string' ? regola.field : regola.left;
    if (typeof grezza !== 'string') continue;
    // `subject`, `{{$node.imap.json.subject}}` e `messaggio.subject` puntano
    // tutti allo stesso nome: conta l'ultimo pezzo.
    const pulito = grezza.replace(/[{}]/g, '').trim().split('.').pop();
    if (pulito !== undefined && pulito !== '') nomi.push(pulito);
  }
  return nomi;
}

/** Che cosa dice il nodo a monte: 'sbagliato', 'ok', oppure non si sa. */
function verdettoSuMonte(defId: string, campiRegola: readonly string[]): boolean | null {
  const campi = contratti().get(defId);
  if (campi === undefined) return null; // nessun contratto: non si indovina.

  const perNome = new Map(campi.map((c) => [c.name.toLowerCase(), c.type.toLowerCase()]));

  // Il segnale forte: si filtra sui campi del record stesso. Allora quel che
  // arriva è il record, non un elenco di record.
  if (campiRegola.length > 0) {
    const tuttiSuoi = campiRegola.every((n) => {
      const tipo = perNome.get(n.toLowerCase());
      return tipo !== undefined && !tipo.includes('array');
    });
    if (tuttiSuoi) return false;
  }

  // Altrimenti ci si accontenta: se qualcosa di elencabile lo produce, passi.
  return campi.some((c) => c.type.toLowerCase().includes('array'));
}

/** Vero se il nodo ha detto lui dove prendere la lista. */
function haUnaSorgentePropria(config: Record<string, unknown>): boolean {
  for (const chiave of CAMPI_CHE_INDICANO_LA_SORGENTE) {
    const v = config[chiave];
    // `input` è il valore predefinito e significa «quello che mi arriva»:
    // dichiararlo non cambia niente, e non deve zittire il controllo.
    if (typeof v === 'string' && v.trim() !== '' && v.trim() !== 'input') return true;
  }
  return false;
}

export function checkListaCheNonArriva(input: QualityGateInput): QualityIssue[] {
  const listaioli = lavoranoSuListe();
  const defIdPerNodo = new Map(input.nodes.map((n) => [n.id, n.defId]));
  const issues: QualityIssue[] = [];

  for (const node of input.nodes) {
    if (!listaioli.has(node.defId)) continue;
    if (haUnaSorgentePropria(node.config)) continue;

    const monte = input.edges.filter((e) => e.to === node.id).map((e) => e.from);
    if (monte.length === 0) continue; // scollegato: ha già il suo controllo.

    const campiRegola = campiDelleRegole(node.config);
    const verdetti = monte.map((id) => {
      const defId = defIdPerNodo.get(id);
      return defId === undefined ? null : verdettoSuMonte(defId, campiRegola);
    });
    // Basta un dubbio — o una lista vera — perché la regola taccia.
    if (verdetti.some((v) => v === null || v === true)) continue;

    const nomi = monte.map((id) => `"${id}"`).join(', ');
    issues.push({
      severity: 'critical',
      code: 'LISTA_CHE_NON_ARRIVA',
      nodeId: node.id,
      message:
        `"${node.id}" (${node.defId}) filtra un ARRAY, ma da ${nomi} arriva un solo elemento — ` +
        'i campi su cui filtra sono i campi di quel record, non di un elenco. ' +
        'Il filtro riceverebbe zero elementi, ' +
        'non ne farebbe passare nessuno, e i nodi a valle partirebbero lo stesso — cioè ' +
        'l\'avviso scatterebbe SEMPRE, anche quando la condizione non è vera. ' +
        'Per decidere su un singolo elemento usa `logic_if` con `conditionRules`, e collega il ' +
        'ramo "true" a quello che deve succedere. Tieni `action_filter` per quando gli elementi ' +
        'sono molti (le righe di una query, gli allegati, gli articoli di un feed).',
    });
  }
  return issues;
}

/** Solo per i test: il catalogo si legge una volta e resta. */
export const __test__ = {
  dimentica: (): void => {
    listaioliCache = null;
    contrattiCache = null;
  },
};
