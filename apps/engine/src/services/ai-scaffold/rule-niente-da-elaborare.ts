/**
 * `NIENTE_DA_ELABORARE` — un nodo che lavora su un contenuto che non arriva.
 *
 * Il 2026-08-06 il wizard ha consegnato «riassunto_serale» così:
 *
 *     trigger_cron → agent_summarizer → slack, database
 *
 * Nessun nodo legge la posta. `trigger_cron` produce `firedAt`,
 * `cronExpression`, `timezone`: un orario. Il riassuntore avrebbe riassunto
 * l'orario in cui è scattato, e l'avrebbe fatto senza errori — un testo
 * plausibile, costruito sul nulla, mandato via email. In un workflow che si
 * chiama «riassunto serale» è il difetto più grave dei tre che aveva, e
 * l'unico che nessun controllo di forma può vedere: il grafo è connesso, i
 * campi obbligatori ci sono, le espressioni sono scritte bene.
 *
 * ── Perché è sicura ──
 *
 * Una regola sul SENSO del flusso rischia di bocciare quello che è solo
 * insolito. Questa non indovina: usa due fatti dichiarati.
 *
 *  1. **Chi lavora su un contenuto che riceve.** Un nodo `ai` che non ha né
 *     `prompt` né `goal` non porta con sé la cosa su cui lavorare — la prende
 *     dall'ingresso. `ai_openai` ha `prompt`, `ai_agent_tool_loop` ha `goal`:
 *     restano fuori. Gli `agent_*` no: `agent_summarizer` ha solo provider e
 *     modello, il testo glielo deve passare qualcuno.
 *  2. **Chi non produce contenuto.** `trigger_cron` dichiara di produrre un
 *     istante e la sua espressione cron. Nient'altro.
 *
 * Scatta solo quando TUTTA la catena a monte è fatta di trigger che non
 * producono contenuto. Basta un `action_http`, un `trigger_imap`, un
 * `db_query` in mezzo — «alle 18 scarica la pagina e riassumila» — e la regola
 * tace, perché lì il contenuto c'è davvero.
 *
 * `trigger_manual` resta fuori di proposito: chi avvia a mano può incollare il
 * testo nella finestra di avvio, e quel payload è contenuto vero.
 *
 * @module services/ai-scaffold/rule-niente-da-elaborare
 */

import { buildNodeCatalog } from '@/services/ai-scaffold/node-catalog.js';
import type { QualityGateInput, QualityIssue } from '@/services/ai-scaffold/quality-gate.js';

/**
 * I campi con cui un nodo si porta dietro la propria materia.
 *
 * `prompt` è il testo su cui il modello lavora; `goal` è l'obiettivo che un
 * agente persegue da sé. Chi ha uno dei due non ha bisogno di ricevere niente.
 * Sono due soli di proposito: `instruction` o `schema` dicono COSA estrarre,
 * non DA COSA — chi li ha il contenuto lo aspetta lo stesso.
 */
const CAMPI_CHE_PORTANO_LA_MATERIA: ReadonlySet<string> = new Set(['prompt', 'goal']);

/**
 * I trigger che non producono niente su cui lavorare.
 *
 * Solo il cron, e solo perché il suo contratto lo dice per esteso: un istante
 * e l'espressione che l'ha fatto scattare. Ogni altro trigger porta un
 * messaggio, un record, un evento — cioè qualcosa.
 */
const TRIGGER_SENZA_CONTENUTO: ReadonlySet<string> = new Set(['trigger_cron']);

/**
 * I campi con cui un nodo dichiara DA DOVE prende la lista su cui lavora.
 *
 * `action_filter` ha `items`, `logic_distinct` e `logic_group_by` hanno
 * `sourceExpression`. Riempiti, dicono dove guardare; VUOTI, il nodo lavora su
 * quello che gli arriva dal nodo prima — ed è allora che un trigger a tempo
 * diventa un problema.
 */
const CAMPI_CHE_INDICANO_LA_SORGENTE: ReadonlySet<string> = new Set([
  'items',
  'sourceExpression',
]);

/** `defId` dei nodi che aspettano il contenuto dall'ingresso. Letto una volta. */
let attesaCache: ReadonlySet<string> | null = null;

function aspettanoContenuto(): ReadonlySet<string> {
  attesaCache ??= new Set(
    buildNodeCatalog()
      .filter((n) => {
        const campi = n.fields ?? [];
        // Un nodo AI che non porta con sé la materia su cui lavorare.
        if (n.type === 'ai') {
          return !campi.some((f) => CAMPI_CHE_PORTANO_LA_MATERIA.has(f.key));
        }
        // Un nodo che TRASFORMA una lista: la prende dall'ingresso quando il
        // campo che indica la sorgente resta vuoto. È il caso del 2026-08-07
        // — cron → action_filter → email, senza niente che procurasse gli
        // articoli: il filtro avrebbe filtrato un orario.
        return campi.some((f) => CAMPI_CHE_INDICANO_LA_SORGENTE.has(f.key));
      })
      .map((n) => n.defId),
  );
  return attesaCache;
}

/** Vero se il nodo ha detto DOVE prendere la lista: allora non aspetta niente. */
function haUnaSorgentePropria(config: Record<string, unknown>): boolean {
  for (const chiave of CAMPI_CHE_INDICANO_LA_SORGENTE) {
    const v = config[chiave];
    if (typeof v === 'string' && v.trim() !== '') return true;
  }
  return false;
}

/**
 * Che cosa l'utente ha davvero, detto per nome.
 *
 * «Metti il nodo che procura il contenuto» è un consiglio che non si può
 * seguire senza sapere da dove: chi legge non conosce a memoria le proprie
 * tabelle, e il modello non può inventarle — l'ultima volta che ci ha provato
 * ha prodotto un `action_http` puntato a un indirizzo immaginario, che è
 * peggio di un nodo mancante perché sembra giusto.
 *
 * Elencare le tabelle che esistono trasforma un rimprovero in una domanda a
 * cui si può rispondere.
 */
function cosaCE(input: QualityGateInput): string {
  const tabelle = (input.databases ?? []).flatMap((d) => d.tables);
  if (tabelle.length === 0) {
    return 'Nel tuo archivio non c\'è ancora nessuna tabella: di\' da dove leggere i dati (una ' +
      'tabella da creare, un indirizzo web, la posta) e il workflow si completa.';
  }
  const elenco = tabelle
    .slice(0, 8)
    .map((t) => `«${t}»`)
    .join(', ');
  return (
    `Le tabelle che hai sono ${elenco}${tabelle.length > 8 ? ' e altre' : ''}: ` +
    'se i dati stanno in una di queste dillo nell\'obiettivo, altrimenti indica dove ' +
    'prenderli (un indirizzo web, la posta) o chiedi di creare la tabella.'
  );
}

/** Tutti i nodi che possono aver girato prima di questo. */
function antenati(nodeId: string, edges: QualityGateInput['edges']): Set<string> {
  const entranti = new Map<string, string[]>();
  for (const e of edges) entranti.set(e.to, [...(entranti.get(e.to) ?? []), e.from]);

  const visti = new Set<string>();
  const coda = [...(entranti.get(nodeId) ?? [])];
  while (coda.length > 0) {
    const corrente = coda.pop();
    if (corrente === undefined || visti.has(corrente)) continue;
    visti.add(corrente);
    coda.push(...(entranti.get(corrente) ?? []));
  }
  return visti;
}

export function checkNienteDaElaborare(input: QualityGateInput): QualityIssue[] {
  const inAttesa = aspettanoContenuto();
  const defIdPerNodo = new Map(input.nodes.map((n) => [n.id, n.defId]));
  const issues: QualityIssue[] = [];

  for (const node of input.nodes) {
    if (!inAttesa.has(node.defId)) continue;
    // Ha dichiarato lui da dove prendere la lista: non aspetta l'ingresso.
    if (haUnaSorgentePropria(node.config)) continue;

    const monte = antenati(node.id, input.edges);
    // Nessun antenato è un caso diverso — un nodo scollegato — e ha già il suo
    // controllo. Qui interessa chi è collegato a qualcosa che non gli serve.
    if (monte.size === 0) continue;

    const tuttiSterili = [...monte].every((id) => {
      const defId = defIdPerNodo.get(id);
      return defId !== undefined && TRIGGER_SENZA_CONTENUTO.has(defId);
    });
    if (!tuttiSterili) continue;

    issues.push({
      severity: 'critical',
      code: 'NIENTE_DA_ELABORARE',
      nodeId: node.id,
      message:
        `"${node.id}" (${node.defId}) lavora sul contenuto che riceve, ma a monte c'è solo un ` +
        'trigger a tempo, che produce un istante e nient\'altro: elaborerebbe l\'orario in cui è ' +
        'scattato, e lo farebbe senza errori. ' +
        `Manca il nodo che procura i dati, e va detto DOVE stanno. ${cosaCE(input)}`,
    });
  }
  return issues;
}

/** Solo per i test: il catalogo si legge una volta e resta. */
export const __test__ = {
  dimentica: (): void => {
    attesaCache = null;
  },
};
