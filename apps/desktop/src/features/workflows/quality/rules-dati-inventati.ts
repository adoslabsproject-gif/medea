/**
 * Dati scritti a mano dove dovrebbe scorrere il risultato del nodo precedente.
 *
 * È il difetto che il 2026-08-05 ha superato ogni controllo. Alla richiesta
 * «archivia le newsletter più vecchie di 30 giorni e conta quante ne hai
 * spostate» è uscito un workflow che scriveva un file con dentro:
 *
 *     Newsletter archiviate:
 *     - 2026-07-13
 *     - 2026-07-20
 *     - 2026-07-27
 *
 * e un nodo dopo che contava **quelle stesse tre righe**, scritte una seconda
 * volta nella sua configurazione. Tre nodi, due collegamenti, forma valida,
 * campi obbligatori tutti pieni: il gate ha segnalato soltanto un ramo morto.
 *
 * Eppure il workflow era vuoto. Quelle date non venivano da nessuna parte —
 * nessun nodo a monte le produceva — e il conteggio avrebbe dato `3` per
 * sempre, qualunque cosa fosse successo nella casella.
 *
 * Le altre regole non potevano vederlo: `example.com` e `TODO` sono segnaposto
 * riconoscibili, una data plausibile no. Quello che tradisce l'invenzione non è
 * il singolo valore, è la **forma**: un elenco omogeneo di date, numeri o
 * indirizzi, dentro un nodo che ha qualcuno prima di sé. I dati veri arrivano
 * per espressione, non copiati dentro la configurazione.
 *
 * @module features/workflows/quality/rules-dati-inventati
 */

import { asSearchable } from './graph';
import type { QualityGateInput, QualityIssue } from './types';

/** Quante righe servono perché un valore sia «un elenco» e non una frase. */
const RIGHE_MINIME = 3;

/**
 * Quante righe possono NON essere dati, in un elenco che resta un elenco.
 *
 * Non una percentuale: chi inventa un dataset ci mette quasi sempre un titolo
 * davanti — «Newsletter archiviate:» — e su un elenco di tre voci una riga di
 * intestazione fa già il 25%, sopra qualunque soglia ragionevole. Una riga
 * estranea si tollera sempre; oltre, si scala col numero di righe.
 */
function estraneeTollerate(righe: number): number {
  return Math.max(1, Math.floor(righe * 0.2));
}

/**
 * Le forme che un dato assume quando è un dato e non prosa.
 *
 * Volutamente strette: una riga di testo libero non deve combaciare con
 * nessuna, altrimenti ogni corpo di email diventerebbe un falso allarme.
 */
const FORME: readonly RegExp[] = [
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/, // 2026-07-13
  /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/, // 13/07/2026
  /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/, // indirizzo email
  /^[+-]?\d+(?:[.,]\d+)?\s*%?$/, // numero, eventualmente percentuale
  /^https?:\/\/\S+$/, // indirizzo web
  /^[A-Z]{2,4}-?\d{2,}$/, // codici tipo INV-1042
];

/** Toglie i prefissi da elenco puntato, che non cambiano la natura del dato. */
function nuda(riga: string): string {
  return riga
    .trim()
    .replace(/^[-*•]\s*/, '')
    .replace(/[,;]$/, '')
    .trim();
}

/** Vero se il testo è un elenco di dati omogenei, intestazione a parte. */
export function sembraUnElencoDiDati(testo: string): boolean {
  const righe = testo
    .split('\n')
    .map(nuda)
    .filter((r) => r !== '');
  if (righe.length < RIGHE_MINIME) return false;

  for (const forma of FORME) {
    const combaciano = righe.filter((r) => forma.test(r)).length;
    if (combaciano < RIGHE_MINIME) continue;
    if (righe.length - combaciano <= estraneeTollerate(righe.length)) return true;
  }
  return false;
}

/** Un valore che contiene un'espressione sta leggendo da qualcuno: va bene. */
function haEspressione(testo: string): boolean {
  return /\{\{[^}]+\}\}/.test(testo);
}

/**
 * Elenchi di dati scritti a mano in nodi che hanno qualcuno prima di sé.
 *
 * Il vincolo «ha un predecessore» è ciò che rende la regola sicura: un elenco
 * dentro il primo nodo di un flusso è una configurazione legittima — una lista
 * di destinatari, dei codici da cercare. Lo stesso elenco a valle di un altro
 * nodo, invece, sta occupando il posto di un dato che sarebbe dovuto arrivare.
 */
export function checkDatiInventati(input: QualityGateInput): QualityIssue[] {
  const conPredecessore = new Set(input.edges.map((e) => e.to));
  const issues: QualityIssue[] = [];

  for (const node of input.nodes) {
    if (!conPredecessore.has(node.id)) continue;
    for (const [field, val] of Object.entries(node.config)) {
      const testo = asSearchable(val);
      if (!testo || haEspressione(testo)) continue;
      if (!sembraUnElencoDiDati(testo)) continue;

      issues.push({
        severity: 'critical',
        code: 'DATI_INVENTATI',
        nodeId: node.id,
        field,
        message:
          `Il campo "${field}" del nodo "${node.id}" contiene un elenco di dati scritto a mano, ` +
          'ma il nodo ne ha uno prima di sé: quei valori dovrebbero arrivare da lì. ' +
          'Così com’è darà sempre lo stesso risultato, qualunque cosa produca il nodo precedente. ' +
          'Usa un’espressione tipo `{{$node.<id>.json.<campo>}}` al posto dei valori.',
      });
    }
  }
  return issues;
}
