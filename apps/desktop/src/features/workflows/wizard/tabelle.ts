/**
 * Le tabelle che il workflow appena costruito dà per esistenti.
 *
 * Il wizard consegnava il workflow e basta. Le tabelle si creavano più tardi,
 * da un avviso nell'editor che bisognava aprire e premere: chi importava e
 * attivava senza passare di lì si ritrovava un workflow che falliva alla prima
 * esecuzione con un «no such table», e in DB Studio non c'era niente da
 * gestire perché niente era mai stato creato.
 *
 * Qui si prepara il terreno nel momento in cui l'utente accetta il workflow.
 * Il principio non cambia — nessuna modifica a un archivio senza che qualcuno
 * la chieda — perché il tasto «Importa» È la richiesta: si dice prima cosa
 * verrà creato, e si crea solo dopo il consenso.
 *
 * @module features/workflows/wizard/tabelle
 */

import type { QualityDatabase } from '../quality';
import {
  createTables,
  databaseDelWorkflow,
  existingTables,
  missingTables,
  planTables,
} from '../runtime';
import type { PlannedTable } from '../runtime';
import type { ScaffoldOutput } from '../scaffold';
import type { Workflow } from '../types';

/** Cosa è successo alle tabelle, da raccontare a chi ha premuto. */
export interface EsitoTabelle {
  /** Create adesso. */
  create: readonly string[];
  /** C'erano già: non è un problema, è il caso normale al secondo giro. */
  gia: readonly string[];
  /** Non si sono potute creare, una riga per ciascuna col perché. */
  problemi: readonly string[];
  /** L'archivio di questo workflow, per puntarci i nodi che ci scrivono. */
  databaseId?: string;
}

const NIENTE: EsitoTabelle = { create: [], gia: [], problemi: [] };

/**
 * Il piano, arricchito coi tipi che il motore ha dichiarato.
 *
 * Il piano dedotto dal workflow è la fonte affidabile su QUALI tabelle
 * servono: nasce dai nodi che ci scriveranno davvero, quindi non inventa
 * tabelle che nessuno userà. Sui TIPI però è prudente — di fronte a
 * un'espressione sceglie testo, perché non può sapere altro.
 *
 * Il motore, quando c'è, dichiara anche i tipi. Sono due informazioni diverse
 * e si sommano: le tabelle dal workflow, i tipi dal motore dove i nomi
 * combaciano. Prima questo elenco veniva calcolato e buttato via.
 */
export function pianoArricchito(
  workflow: Pick<Workflow, 'nodes'>,
  dalMotore: ScaffoldOutput['tablesToCreate'],
  archiviEsistenti: readonly QualityDatabase[] = [],
): PlannedTable[] {
  // Una tabella che l'utente HA GIÀ non si ricrea altrove.
  //
  // Il 2026-08-10: «inserisci nella tabella ordini», e `ordini` esisteva.
  // Il wizard ne ha creata una seconda, vuota, nell'archivio del workflow — e
  // il nodo ci avrebbe scritto dentro. L'utente avrebbe visto gli ordini
  // arrivare in una tabella e la sua restare ferma, senza capire perché.
  //
  // «Ogni workflow le sue tabelle» vale per quelle che il workflow CREA. Una
  // tabella nominata dall'utente e che esiste già è sua, e va usata: duplicarla
  // significa separargli i dati in silenzio.
  const gia = new Set(
    archiviEsistenti.flatMap((d) => d.tables).map((t) => t.toLowerCase()),
  );
  const piano = planTables(workflow).filter((t) => !gia.has(t.name.toLowerCase()));
  if (!dalMotore || dalMotore.length === 0) return piano;

  const perTabella = new Map<string, { name: string; type: string }[]>(
    dalMotore.map((t) => [
      t.name.toLowerCase(),
      t.columns.map((c) => ({ name: c.name, type: c.type })),
    ]),
  );

  const tipoBuono = (t: string | undefined): PlannedTable['columns'][number]['type'] | null =>
    t !== undefined && TIPI_NOTI.has(t)
      ? (t as PlannedTable['columns'][number]['type'])
      : null;

  return piano.map((tabella) => {
    const dichiarate = perTabella.get(tabella.name);
    if (!dichiarate) return tabella;

    // Prima si affinano i tipi di quello che il workflow già nomina…
    const colonne = tabella.columns.map((colonna) => {
      const tipo = tipoBuono(
        dichiarate.find((c) => c.name.toLowerCase() === colonna.name.toLowerCase())?.type,
      );
      return tipo ? { ...colonna, type: tipo } : colonna;
    });

    // …poi si AGGIUNGONO quelle che solo il motore conosce.
    //
    // Il piano dedotto dal workflow legge le colonne da `rowJson`. Quando un
    // `db_insert` non ce l'ha — perché scrive quello che gli arriva dal nodo
    // prima, che è il modo idiomatico dietro un modulo — di colonne non ne
    // trova nessuna, e la tabella nasceva con il solo `id`. Il 2026-08-16 è
    // successo davvero: `contatti` creata con `id` e basta, mentre il modulo
    // raccoglieva nome ed email. L'inserimento sarebbe fallito con «no such
    // column» alla prima richiesta ricevuta.
    const note = new Set(colonne.map((c) => c.name.toLowerCase()));
    for (const c of dichiarate) {
      if (note.has(c.name.toLowerCase())) continue;
      colonne.push({ name: c.name, type: tipoBuono(c.type) ?? 'text' });
    }

    return { ...tabella, columns: colonne };
  });
}

const TIPI_NOTI: ReadonlySet<string> = new Set([
  'text',
  'integer',
  'real',
  'boolean',
  'datetime',
  'json',
]);

/**
 * Crea le tabelle mancanti del workflow.
 *
 * Non solleva: un archivio che non risponde non deve impedire di importare un
 * workflow già costruito. Il problema si racconta, e l'avviso nell'editor
 * resta lì per riprovare.
 */
export async function preparaTabelle(
  workflowId: string | number,
  nomeWorkflow: string,
  piano: readonly PlannedTable[],
): Promise<EsitoTabelle> {
  if (piano.length === 0) return NIENTE;

  try {
    // L'archivio è DI QUESTO workflow: due workflow che nominano una tabella
    // `inbox` non si pestano i piedi, e due con lo stesso nome nemmeno —
    // l'identità è l'id, che non si ripete e non cambia.
    const databaseId = await databaseDelWorkflow(workflowId, nomeWorkflow);
    const presenti = await existingTables(databaseId);
    const mancanti = missingTables(piano, presenti);
    const gia = piano.filter((t) => !mancanti.includes(t)).map((t) => t.name);

    if (mancanti.length === 0) return { create: [], gia, problemi: [], databaseId };

    const report = await createTables(databaseId, mancanti);
    return { create: report.created, gia, problemi: report.problems, databaseId };
  } catch (e) {
    return {
      create: [],
      gia: [],
      problemi: [`non ho potuto parlare con l’archivio: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
}

/**
 * Gli archivi come li vedrà il controllo di qualità DOPO l'importazione.
 *
 * Il gate confronta le tabelle nominate dai nodi con quelle che esistono, e le
 * tabelle che il workflow sta per creare non esistono ancora: il 2026-08-06 il
 * wizard diceva «nuove tabelle richieste: log — verranno create all'import» e
 * due righe sotto bloccava l'attivazione perché «la tabella log non esiste».
 * Due affermazioni vere e incompatibili nella stessa schermata.
 *
 * Il motore questo conto lo faceva già (`augmentedDatabases`); qui no. Le
 * tabelle pianificate si aggiungono a OGNI archivio candidato: quale sarà
 * quello giusto si decide all'importazione, e un controllo che le vede
 * ovunque non bloccherà mai per una tabella che sta per nascere.
 */
export function archiviConLePianificate(
  archivi: readonly QualityDatabase[],
  piano: readonly PlannedTable[],
): QualityDatabase[] {
  if (piano.length === 0) return [...archivi];
  const nomi = piano.map((t) => t.name);
  const colonne = Object.fromEntries(piano.map((t) => [t.name, t.columns.map((c) => c.name)]));
  return archivi.map((d) => ({
    id: d.id,
    tables: [...d.tables, ...nomi],
    columns: { ...(d.columns ?? {}), ...colonne },
  }));
}

/**
 * Fa puntare all'archivio del workflow i nodi che usano le sue tabelle.
 *
 * È la seconda metà di «ogni workflow le sue tabelle», e senza la prima non
 * serve a niente. Il modello sceglie un `databaseId` fra quelli che vede — di
 * norma l'archivio condiviso — ma le tabelle NUOVE nascono nell'archivio del
 * workflow: senza questo passaggio il nodo cercherebbe `log` dove non c'è, e
 * fallirebbe alla prima esecuzione con un «no such table» dopo che il wizard
 * aveva appena annunciato di averla creata.
 *
 * Si toccano SOLO i nodi che nominano una tabella appena creata. Chi legge una
 * tabella preesistente in un altro archivio resta dov'è: non è affare nostro
 * spostarlo.
 */
export function puntaAllArchivio(
  workflow: Workflow,
  databaseId: string,
  create: readonly string[],
): { workflow: Workflow; ripuntati: number } {
  if (create.length === 0) return { workflow, ripuntati: 0 };
  const nomi = new Set(create.map((n) => n.toLowerCase()));

  let ripuntati = 0;
  const nodes = workflow.nodes.map((n) => {
    const tabella = n.config?.table;
    if (typeof tabella !== 'string' || !nomi.has(tabella.trim().toLowerCase())) return n;
    if (n.config?.databaseId === databaseId) return n;
    ripuntati += 1;
    return { ...n, config: { ...n.config, databaseId } };
  });

  return ripuntati === 0 ? { workflow, ripuntati: 0 } : { workflow: { ...workflow, nodes }, ripuntati };
}

/** La frase da mostrare dopo l'importazione. Vuota se non c'era niente da fare. */
export function messaggioTabelle(esito: EsitoTabelle): string {
  const pezzi: string[] = [];
  if (esito.create.length > 0) {
    pezzi.push(
      esito.create.length === 1
        ? `Creata la tabella «${esito.create[0] ?? ''}».`
        : `Create ${String(esito.create.length)} tabelle: ${esito.create.join(', ')}.`,
    );
  }
  if (esito.problemi.length > 0) {
    pezzi.push(`Tabelle non create — ${esito.problemi.join('; ')}.`);
  }
  return pezzi.join(' ');
}
