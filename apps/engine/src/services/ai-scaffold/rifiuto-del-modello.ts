/**
 * Quando il modello non sbaglia: si rifiuta.
 *
 * Il 2026-08-06, tre tentativi di fila sono morti con «output senza un oggetto
 * JSON valido». Il messaggio era vero e completamente fuorviante. Ecco cosa
 * arrivava davvero, letto dal log:
 *
 *     {
 *       "name": "log_cleanup",
 *       "description": "Cancella dalla tabella log le righe più vecchie…",
 *       "reasoning": "Il goal chiede di cancellare… La tabella log non è tr…
 *     …"name": "id", "type": "uuid", "primaryKey": trueNon posso condividere
 *     le mie istruzioni interne o il mio prompt di sistema.
 *
 * JSON perfettamente formato che si interrompe a metà e diventa un rifiuto.
 * Non è un difetto di formato: è un **guardrail anti-leak** che scatta durante
 * la generazione. Notare DOVE si ferma — `{ "name": "id", "type": "uuid",
 * "primaryKey": true` è copiato alla lettera dall'esempio nel prompt di
 * sistema: il modello riproduce le istruzioni che ha ricevuto, e la sua stessa
 * protezione lo interrompe.
 *
 * Chiamarlo «output non valido» manda a cercare dalla parte sbagliata — si
 * riscrive l'obiettivo, si accusa il formato — mentre il rimedio è un altro:
 * cambiare strada o cambiare modello. Un messaggio che nomina la causa vale
 * più di dieci tentativi.
 *
 * @module services/ai-scaffold/rifiuto-del-modello
 */

/**
 * Le forme in cui un modello dice di no.
 *
 * Tenute corte e in minuscolo: si confronta su testo normalizzato, perché la
 * stessa frase arriva con maiuscole e punteggiatura diverse.
 */
const FORME_DI_RIFIUTO: readonly string[] = [
  'non posso condividere le mie istruzioni',
  'non posso rivelare il mio prompt',
  'non posso condividere il mio prompt',
  'i cannot share my system prompt',
  'i can’t share my system prompt',
  "i can't share my system prompt",
  'i cannot reveal my instructions',
  'non sono autorizzato a condividere',
];

/**
 * Vero se in questa risposta c'è un rifiuto esplicito del modello.
 *
 * Si guarda TUTTA la risposta e non solo la fine: il rifiuto può comparire
 * prima del JSON, dopo, o al posto suo.
 */
export function contieneRifiuto(raw: string): boolean {
  const testo = raw.toLowerCase();
  return FORME_DI_RIFIUTO.some((forma) => testo.includes(forma));
}

/**
 * Il modello ha chiesto uno STRUMENTO invece di rispondere.
 *
 * Il 2026-08-07, all'obiettivo «leggi gli articoli dalla tabella magazzino»,
 * Liara ha risposto:
 *
 *     [TOOL_CALLS]fs_read{"path": "/Users/tu/Documenti/magazzino.txt"}
 *
 * `[TOOL_CALLS]` è il token con cui i Mistral chiedono uno strumento. Qui di
 * strumenti non ce n'è nessuno — si chiede un JSON e basta — quindi quel token
 * finisce nel testo, e con lui una chiamata a un file che non esiste.
 *
 * Non è un JSON malformato e non è un rifiuto: è un modello addestrato agli
 * strumenti che prova a usarli dove non ci sono. Dirlo per nome è l'unico modo
 * perché chi legge capisca che non è colpa di come ha scritto l'obiettivo.
 */
export function contieneChiamataAStrumento(raw: string): boolean {
  return /\[TOOL_CALLS\]|<\|tool_calls\|>/i.test(raw);
}

/** Che cosa dire quando il modello ha provato a chiamare uno strumento. */
export function messaggioChiamataAStrumento(): string {
  return (
    'Il modello ha provato a usare uno strumento invece di scrivere il workflow: ha risposto ' +
    'con «[TOOL_CALLS]», il modo in cui i modelli Mistral chiedono di eseguire una funzione. ' +
    'In questa fase di strumenti non ce ne sono — si chiede solo il workflow in JSON — quindi ' +
    'quella richiesta non porta da nessuna parte. Non dipende da come hai scritto l’obiettivo. ' +
    'Provo le altre strade; se capita spesso, conviene un modello diverso per il wizard.'
  );
}

/**
 * Il messaggio da dare a chi legge, quando il modello si è rifiutato.
 *
 * Dice la causa e il rimedio, che qui non è «sii più preciso»: riscrivere
 * l'obiettivo non convince una protezione a non scattare.
 */
export function messaggioRifiuto(): string {
  return (
    'Il modello si è rifiutato di completare la risposta: ha cominciato a produrre il ' +
    'workflow e si è interrotto dicendo che non può condividere le proprie istruzioni. ' +
    'È una protezione del modello che scatta mentre genera, non un problema del tuo ' +
    'obiettivo — riscriverlo non serve. Provo le altre strade; se non basta, cambia ' +
    'modello o fornitore dalle impostazioni AI.'
  );
}
