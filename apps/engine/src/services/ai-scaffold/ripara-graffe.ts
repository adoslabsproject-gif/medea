/**
 * Espressioni scritte con una graffa sola.
 *
 * `{$node.filtro.json.kept | pluck:'nome' | join:', '}` non è ambiguo: è
 * un'espressione a cui manca una graffa per parte. L'interprete vuole le
 * doppie, e con una sola quel testo finisce nell'email **così com'è scritto**
 * — il destinatario riceve il codice invece dell'elenco.
 *
 * È successo il 2026-08-05, il 2026-08-06 e ancora il 2026-08-07, con
 * obiettivi diversi e dopo aver messo nel prompt l'esempio giusto: il modello
 * legge la forma, la usa, e perde una graffa. A un certo punto ripetere
 * l'istruzione smette di essere una soluzione.
 *
 * Qui non si chiede niente a nessuno. Una graffa singola che contiene
 * `$node.` non è mai una scelta — nel linguaggio delle espressioni non
 * significa nulla — quindi si può correggere senza rischiare di riscrivere
 * qualcosa che qualcuno voleva davvero.
 *
 * @module services/ai-scaffold/ripara-graffe
 */

/** Quante correzioni sono state fatte, e su cosa. */
export interface EsitoGraffe {
  testo: string;
  corrette: number;
}

/**
 * Raddoppia le graffe scompagnate attorno a un riferimento `$node.`.
 *
 * Si lavora sulle posizioni e non con un'espressione regolare: dentro
 * un'espressione possono esserci graffe annidate — `join:'}'`, un template —
 * e una regex golosa mangerebbe la chiusura sbagliata.
 */
export function riparaGraffe(testo: string): EsitoGraffe {
  if (!testo.includes('$node.')) return { testo, corrette: 0 };

  let out = '';
  let i = 0;
  let corrette = 0;

  while (i < testo.length) {
    const apertura = testo.indexOf('{', i);
    if (apertura === -1) {
      out += testo.slice(i);
      break;
    }

    // Già doppia: si salta tutta la coppia senza toccarla.
    if (testo[apertura + 1] === '{') {
      const fine = testo.indexOf('}}', apertura);
      const finePezzo = fine === -1 ? testo.length : fine + 2;
      out += testo.slice(i, finePezzo);
      i = finePezzo;
      continue;
    }

    const chiusura = testo.indexOf('}', apertura);
    const interno = chiusura === -1 ? '' : testo.slice(apertura + 1, chiusura);

    // Si ripara SOLO ciò che è un'espressione e nient'altro: dentro le graffe
    // deve esserci un riferimento a un nodo dall'inizio.
    //
    // «Contiene `$node.`» non basta, ed è costato caro: il 2026-08-10 questa
    // riparazione ha preso la graffa di un OGGETTO JSON —
    // `[{"left":"{{$node.x}}", …}]`, un `conditionRules` scritto BENE — e l'ha
    // raddoppiata, producendo graffe scompagnate dove non ce n'erano. Una
    // riparazione che rompe ciò che era sano è peggio del difetto che cura.
    //
    // Un'espressione comincia con `$node.`; un oggetto JSON comincia con una
    // virgoletta. La distinzione è netta e si legge dal primo carattere.
    if (chiusura === -1 || !/^\s*\$node\./.test(interno)) {
      out += testo.slice(i, apertura + 1);
      i = apertura + 1;
      continue;
    }

    out += `${testo.slice(i, apertura)}{{${interno}}}`;
    i = chiusura + 1;
    corrette += 1;
  }

  return { testo: out, corrette };
}

/** Applica la riparazione a ogni testo di una configurazione, annidati inclusi. */
export function riparaGraffeInConfig(config: Record<string, unknown>): {
  config: Record<string, unknown>;
  corrette: number;
} {
  let corrette = 0;

  const percorri = (valore: unknown): unknown => {
    if (typeof valore === 'string') {
      const esito = riparaGraffe(valore);
      corrette += esito.corrette;
      return esito.testo;
    }
    if (Array.isArray(valore)) return valore.map(percorri);
    if (valore !== null && typeof valore === 'object') {
      return Object.fromEntries(
        Object.entries(valore as Record<string, unknown>).map(([k, v]) => [k, percorri(v)]),
      );
    }
    return valore;
  };

  return { config: percorri(config) as Record<string, unknown>, corrette };
}
