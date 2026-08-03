/**
 * A che punto è la costruzione, detto in una riga.
 *
 * La fase si **deduce da quello che l'agente ha fatto**, non gliela si chiede.
 * Chiederla vorrebbe dire fidarsi che ogni modello dichiari il proprio stato
 * nel formato giusto a ogni passo: quelli addestrati su questo compito lo
 * farebbero, gli altri no — e il pannello resterebbe vuoto proprio con i
 * modelli che hanno più bisogno di essere seguiti.
 *
 * Gli strumenti invece li chiamano tutti allo stesso modo, perché è l'unica
 * cosa che possono fare. Da lì si legge la fase senza chiedere niente.
 *
 * @module features/workflows/scaffold/fasi
 */

/** Le fasi, nell'ordine in cui si attraversano. */
export const FASI = [
  'capire',
  'scegliere',
  'montare',
  'collegare',
  'configurare',
  'verificare',
  'chiudere',
] as const;

export type Fase = (typeof FASI)[number];

/** Cosa sta facendo, detto a chi non conosce i nomi degli strumenti. */
export const ETICHETTA_FASE: Record<Fase, string> = {
  capire: 'Leggo la richiesta',
  scegliere: 'Cerco i nodi adatti',
  montare: 'Monto il workflow',
  collegare: 'Collego i passaggi',
  configurare: 'Compilo i campi',
  verificare: 'Controllo che funzioni',
  chiudere: 'Chiudo il lavoro',
};

/** Quale fase corrisponde a ogni strumento. */
const FASE_DELLO_STRUMENTO: Record<string, Fase> = {
  // La prima strada: scrivere il workflow in una volta sola. Copre le fasi
  // dalla scelta alla configurazione tutte insieme, quindi vale «montare».
  singleshot_generate: 'montare',
  analyze_goal: 'capire',
  search_nodes: 'scegliere',
  get_node_schema: 'scegliere',
  add_node: 'montare',
  delete_node: 'montare',
  connect: 'collegare',
  disconnect: 'collegare',
  set_config: 'configurare',
  validate_workflow: 'verificare',
  finish: 'chiudere',
};

/**
 * La fase corrente, dedotta dagli strumenti usati finora.
 *
 * Si prende la **più avanzata** raggiunta, non l'ultima chiamata: un agente
 * che dopo aver collegato torna indietro a sistemare un campo non sta
 * ricominciando da capo, e mostrare «compilo i campi» dopo «controllo che
 * funzioni» darebbe l'impressione di un lavoro che va avanti e indietro senza
 * arrivare da nessuna parte.
 */
export function faseCorrente(strumentiUsati: readonly string[]): Fase {
  let massima = 0;
  for (const strumento of strumentiUsati) {
    const fase = FASE_DELLO_STRUMENTO[strumento];
    if (!fase) continue;
    massima = Math.max(massima, FASI.indexOf(fase));
  }
  return FASI[massima] ?? 'capire';
}

/** Quanto manca, da zero a uno. Serve alla barra di avanzamento. */
export function avanzamento(strumentiUsati: readonly string[]): number {
  return (FASI.indexOf(faseCorrente(strumentiUsati)) + 1) / FASI.length;
}
