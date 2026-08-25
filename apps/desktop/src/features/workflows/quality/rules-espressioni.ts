/**
 * Espressioni che non si risolveranno.
 *
 * Il 2026-08-05 il wizard ha prodotto un workflow con dentro
 * `{{trigger_email.email.id}}` e `{{trigger_email.attachment.base64}}`. A
 * vederle sembrano giuste: nominano un nodo che esiste, hanno la forma di un
 * percorso, stanno fra doppie graffe. A runtime non valgono niente — la
 * convenzione è `{{$node.<id>.json.<campo>}}`, e senza `$node.` l'interprete
 * non sa nemmeno dove andare a guardare.
 *
 * È il tipo di difetto peggiore: passa ogni controllo di forma, passa il gate,
 * si vede sul disegno come un collegamento perfetto, e fallisce alla prima
 * esecuzione con un valore vuoto. Chi guarda dà la colpa alla posta.
 *
 * Qui si controllano tre cose, e solo quelle: che un riferimento a un nodo usi
 * il prefisso giusto, che il nodo nominato esista, e che non punti a sé stesso.
 * Tutto il resto — funzioni, variabili, espressioni di libreria — si lascia
 * passare: questo non è un interprete, ed è meglio tacere che sbagliare.
 *
 * @module features/workflows/quality/rules-espressioni
 */

import { asSearchable, buildAncestors } from './graph';
import type { QualityGateInput, QualityIssue } from './types';

/** Ogni cosa fra doppie graffe, comunque sia scritta dentro. */
const ESPRESSIONE = /\{\{([^}]+)\}\}/g;

/**
 * Un riferimento a un nodo scritto con **una** graffa sola.
 *
 * Il 2026-08-05 il wizard ha prodotto
 * `{$node.cerca.json.rows.map(row => ...)}`: una graffa, e per giunta
 * JavaScript dentro. La regola guardava solo le doppie e non l'ha visto —
 * il difetto è passato proprio attraverso il controllo scritto per fermarlo.
 *
 * Una graffa sola non è mai un'espressione valida: se dentro c'è `$node.` o il
 * nome di un nodo, è una scritta a mano male, non una scelta.
 */
function graffeSingoleConNodo(testo: string): string[] {
  const trovate = new Map<number, string>();
  for (const m of testo.matchAll(/\$node\./g)) {
    const i = m.index;
    // La graffa aperta più vicina a sinistra: è quella che lo racchiude.
    const apertura = testo.lastIndexOf('{', i);
    if (apertura === -1) continue;
    // Doppia, da una parte o dall'altra: è un'espressione regolare, e la
    // guardano i controlli sotto. Qui interessa solo la graffa scompagnata.
    if (testo[apertura - 1] === '{' || testo[apertura + 1] === '{') continue;
    trovate.set(apertura, testo.slice(apertura, apertura + 60));
  }
  return [...trovate.values()];
}

/** La forma buona: `$node.<id>.json.<campo>` (il campo può essere annidato). */
const RIFERIMENTO_BUONO = /^\s*\$node\.([A-Za-z_][\w-]*)\./;

/**
 * I nomi che nello scope esistono davvero: tutto il resto vale vuoto.
 *
 * Sono le radici che l'interprete mette a disposizione (`interpreter.ts`).
 * `$node` e `$` hanno il loro controllo più sotto.
 */
const RADICI_DELLO_SCOPE: ReadonlySet<string> = new Set([
  'input',
  'output',
  'ctx',
  'item',
  'index',
  'loop',
  'vars',
  'secrets',
]);

/** Un identificatore nudo: solo lettere, cifre e trattini bassi, niente altro. */
const IDENTIFICATORE_NUDO = /^\s*([A-Za-z_][\w]*)\s*$/;

/**
 * Chi produce un certo campo, fra i nodi a monte di questo.
 *
 * È la domanda che fino al 2026-08-06 non si poteva porre: senza i contratti
 * di output nessuno sapeva che `tldr` è un campo di `agent_summarizer`, e
 * `{{tldr}}` era indistinguibile da una parola qualsiasi (ADR 0010).
 */
function chiProduce(
  campo: string,
  antenati: ReadonlySet<string>,
  input: QualityGateInput,
): string | undefined {
  for (const altro of input.nodes) {
    if (!antenati.has(altro.id)) continue;
    const campi = input.defs?.get(altro.defId)?.outputContract?.fields ?? [];
    if (campi.some((f) => f.name === campo)) return altro.id;
  }
  return undefined;
}

/**
 * Un riferimento a un nodo scritto senza `$node.`, cioè `<id>.qualcosa` dove
 * `<id>` è un nodo del disegno.
 *
 * Il vincolo «è un nodo del disegno» è ciò che tiene la regola stretta:
 * `{{ now() }}` o `{{ item.nome }}` non nominano nessun nodo e restano fuori.
 */
function nodoNominatoSenzaPrefisso(
  interno: string,
  idNodi: ReadonlySet<string>,
): string | undefined {
  const m = /^\s*([A-Za-z_][\w-]*)\s*\./.exec(interno);
  if (!m) return undefined;
  const primo = m[1];
  if (primo === undefined || primo === '$node') return undefined;
  return idNodi.has(primo) ? primo : undefined;
}

export function checkEspressioniNonRisolvibili(input: QualityGateInput): QualityIssue[] {
  const idNodi = new Set(input.nodes.map((n) => n.id));
  const issues: QualityIssue[] = [];

  for (const node of input.nodes) {
    for (const [field, val] of Object.entries(node.config)) {
      const testo = asSearchable(val);
      if (!testo.includes('{')) continue;

      for (const pezzo of graffeSingoleConNodo(testo)) {
        issues.push({
          severity: 'critical',
          code: 'ESPRESSIONE_NON_RISOLVIBILE',
          nodeId: node.id,
          field,
          message:
            `Il campo "${field}" usa una graffa sola: \`${pezzo}…\`. ` +
            'Le espressioni vogliono le doppie — `{{$node.<id>.json.<campo>}}` — e non eseguono ' +
            'codice: niente `.map()`, niente funzioni. Così com’è finisce nel testo com’è scritta.',
        });
      }

      if (!testo.includes('{{')) continue;

      for (const m of testo.matchAll(ESPRESSIONE)) {
        const interno = m[1] ?? '';

        // Un campo scritto da solo, senza dire da quale nodo arriva.
        //
        // Il 2026-08-06 il wizard ha prodotto `{{tldr}}` e `{{firedAt}}`: i
        // NOMI erano giusti — `tldr` esce davvero da `agent_summarizer`,
        // `firedAt` da `trigger_cron` — ma senza `$node.` l'interprete non
        // trova niente e mette **stringa vuota**, senza un errore. Il
        // messaggio partiva vuoto e nessuno lo sapeva.
        //
        // La regola accanto non lo prendeva: cerca `nodo.campo`, e pretende un
        // punto che qui non c'è. È la seconda volta che un difetto passa dal
        // controllo scritto per fermarlo, e sempre perché copriva la forma
        // vista invece della classe.
        const nudo = IDENTIFICATORE_NUDO.exec(interno);
        const nomeNudo = nudo?.[1];
        if (nomeNudo !== undefined && !RADICI_DELLO_SCOPE.has(nomeNudo)) {
          const antenati = buildAncestors(node.id, input.edges);
          const produttore = chiProduce(nomeNudo, antenati, input);
          if (produttore !== undefined) {
            issues.push({
              severity: 'critical',
              code: 'ESPRESSIONE_NON_RISOLVIBILE',
              nodeId: node.id,
              field,
              message:
                `Il campo "${field}" usa \`{{${nomeNudo}}}\`: il nome è giusto — lo produce ` +
                `"${produttore}" — ma da solo non si risolve e a runtime resta VUOTO, ` +
                `senza errori. Scrivi \`{{$node.${produttore}.json.${nomeNudo}}}\`.`,
            });
            continue;
          }
        }

        // Manca `$node.` davanti al nome di un nodo che esiste: è il caso che
        // inganna, perché tutto il resto è giusto.
        const senzaPrefisso = nodoNominatoSenzaPrefisso(interno, idNodi);
        if (senzaPrefisso !== undefined) {
          issues.push({
            severity: 'critical',
            code: 'ESPRESSIONE_NON_RISOLVIBILE',
            nodeId: node.id,
            field,
            message:
              `Il campo "${field}" usa \`${m[0]}\`, che a runtime non si risolve: ` +
              `manca il prefisso. Scrivi \`{{$node.${senzaPrefisso}.json.<campo>}}\`.`,
          });
          continue;
        }

        const riferimento = RIFERIMENTO_BUONO.exec(interno);
        if (!riferimento) continue;
        const nominato = riferimento[1];
        if (nominato === undefined) continue;

        // Nomina un nodo che non c'è: il campo resterà vuoto e nessuno lo dirà.
        if (!idNodi.has(nominato)) {
          issues.push({
            severity: 'critical',
            code: 'ESPRESSIONE_NON_RISOLVIBILE',
            nodeId: node.id,
            field,
            message:
              `Il campo "${field}" legge da "${nominato}", che non è un nodo di questo workflow. ` +
              'Il valore arriverà vuoto.',
          });
          continue;
        }

        // Legge da sé stesso: il proprio output non esiste ancora mentre gira.
        if (nominato === node.id) {
          issues.push({
            severity: 'critical',
            code: 'ESPRESSIONE_NON_RISOLVIBILE',
            nodeId: node.id,
            field,
            message:
              `Il campo "${field}" legge dal nodo stesso: mentre "${node.id}" esegue, il suo ` +
              'output non esiste ancora.',
          });
        }
      }
    }
  }
  return issues;
}
