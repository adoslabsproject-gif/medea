/**
 * Un numero solo, ovunque.
 *
 * «Quanti nodi ha Medea» è finito scritto a mano in una ventina di posti —
 * README, ADR, note di rilascio, commenti — e i posti si sono separati: 145
 * nella palette, 186 in un ADR, 193 nel catalogo. Nessuno era bugiardo quando
 * è stato scritto; sono invecchiati a velocità diverse.
 *
 * Il numero vero è **uno**: quanti `defId` ci sono in `stdlib-nodes.json`, che
 * è generato dai pacchetti di FlowForge e che `catalog.guard.test.ts` verifica
 * essere lo stesso insieme che il motore dichiara su `/api/v1/nodes`.
 *
 * Qui si controlla che ogni «N nodi» scritto in giro sia quel numero. Le note
 * storiche — «erano 145, adesso sono 193» — sono legittime e stanno
 * nell'elenco delle eccezioni, ognuna col suo perché: un numero vecchio in una
 * frase al passato racconta come si è arrivati qui, ed è diverso da un numero
 * vecchio in una frase al presente, che invece è una bugia.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { QUALITY_RULES } from '../quality/gate';

import { STDLIB_NODES } from './index';

const RADICE = join(import.meta.dirname, '..', '..', '..', '..', '..', '..');

/** Dove si va a guardare: la documentazione e il codice, non i generati. */
const CARTELLE = [
  join(RADICE, 'docs'),
  join(RADICE, 'apps', 'desktop', 'src'),
  join(RADICE, 'scripts'),
];

/**
 * I file sciolti nella radice, che nessuna cartella comprende.
 *
 * Il README è rimasto fuori da questo controllo fino al 2026-08-25, ed è
 * finito com'era prevedibile: diceva «193 nodi» mentre `docs/` ne diceva 194,
 * cioè il documento che tutti leggono per primo era l'unico non sorvegliato.
 */
const FILE_SCIOLTI = [join(RADICE, 'README.md')];

const ESTENSIONI = ['.md', '.ts', '.tsx', '.mjs'];

/**
 * I numeri vecchi che possono restare, e perché.
 *
 * Ognuno è una frase al **passato**: racconta una deriva e come è finita. Se
 * qualcuno la riscrivesse al presente, questa lista non lo salverebbe — il
 * testo esatto deve continuare a combaciare.
 */
const STORICI: { frammento: string; perche: string }[] = [
  {
    frammento: '145 defId estratti contro i 193 che il runtime carica',
    perche: 'ADR 0007: il difetto com’era, seguito dalla riga che lo dichiara risolto.',
  },
  {
    frammento: 'i nodi sono 193, non 186',
    perche: 'ADR 0005: la correzione della prima stesura, che cita il numero sbagliato per dirlo.',
  },
  {
    frammento: '186 nodi',
    perche: 'ADR 0005: la stesura originale, lasciata leggibile perché la correzione la segue.',
  },
  {
    frammento: 'diff deterministico dei 193 NodeDef',
    perche:
      'Audit del 2026-08-01: racconta quanti nodi furono confrontati QUEL giorno. ' +
      'Aggiornarlo falsificherebbe il verbale di una misura già fatta.',
  },
  {
    frammento: '193/193 defId presenti',
    perche: 'Stesso audit: è il risultato di quella misura, non il conteggio di oggi.',
  },
  {
    // Il confronto avviene su testo con gli spazi normalizzati: un frammento
    // con la spaziatura della tabella non combacerebbe mai.
    frammento: '193 nodi | pinning versione morto',
    perche:
      'Stesso audit, tabella delle degradazioni: la portata misurata allora. ' +
      'La cella accanto dice 192, e le due si leggono insieme.',
  },
];

function* filesIn(dir: string): Generator<string> {
  let voci: string[];
  try {
    voci = readdirSync(dir);
  } catch {
    return;
  }
  for (const voce of voci) {
    if (voce === 'node_modules' || voce === 'dist' || voce === 'target' || voce.startsWith('.'))
      continue;
    const percorso = join(dir, voce);
    if (statSync(percorso).isDirectory()) yield* filesIn(percorso);
    else if (ESTENSIONI.some((e) => voce.endsWith(e))) yield percorso;
  }
}

/**
 * «193 nodi», «193 defId», «193 esecutori»: le forme in cui il numero viene
 * citato. Il capo a riga in mezzo è normale nel testo giustificato dei
 * documenti, quindi lo spazio è generico.
 */
const CITAZIONE = /(\d{2,4})\s+(nodi|defId|definizioni|esecutori|NodeDef)\b/g;

/**
 * Non tutti i «N nodi» pretendono di essere il totale.
 *
 * «81 defId con un'icona di marca», «25 nodi in questa tabella»: sono
 * sottoinsiemi, e sono giusti. Un conteggio obsoleto del catalogo intero,
 * invece, resta vicino a quello vero — 145, 186 — perché il catalogo cresce,
 * non raddoppia da un mese all'altro.
 *
 * La soglia è quella: entro un fattore due dal totale vero, in entrambe le
 * direzioni, si sospetta un conteggio rimasto indietro. Più lontano si dà per
 * buono che parli d'altro.
 */
function pretendeDiEssereIlTotale(citato: number, vero: number): boolean {
  return citato * 2 >= vero && vero * 2 >= citato;
}

describe('quanti nodi ha Medea', () => {
  it('è scritto allo stesso modo dappertutto', () => {
    const vero = STDLIB_NODES.length;
    const sbagliati: string[] = [];

    for (const file of [...CARTELLE.flatMap((d) => [...filesIn(d)]), ...FILE_SCIOLTI]) {
      {
        // Questo file parla dei numeri sbagliati per mestiere: contarli qui
        // sarebbe contare le proprie citazioni.
        if (file.endsWith('count.guard.test.ts')) continue;
        const testo = readFileSync(file, 'utf8');
        for (const m of testo.matchAll(CITAZIONE)) {
          const citato = Number(m[1]);
          if (citato === vero || !pretendeDiEssereIlTotale(citato, vero)) continue;
          const intorno = testo.slice(Math.max(0, m.index - 60), m.index + 60).replace(/\s+/g, ' ');
          if (STORICI.some((s) => intorno.includes(s.frammento))) continue;
          sbagliati.push(`${file.slice(RADICE.length + 1)} → «${m[0]}» (sono ${String(vero)})`);
        }
      }
    }

    expect([...new Set(sbagliati)].sort()).toEqual([]);
  });

  it('e il catalogo li ha davvero tutti, uno per defId', () => {
    // Un doppione passerebbe inosservato in un conteggio: `length` conta le
    // righe, non le identità, e due `action_http` farebbero 193 lo stesso.
    const identita = new Set(STDLIB_NODES.map((n) => n.defId));
    expect(identita.size).toBe(STDLIB_NODES.length);
  });
});

/**
 * Lo stesso, per le regole del controllo di qualità.
 *
 * Sono cresciute da 21 a 26 senza che nessun documento se ne accorgesse: il
 * README prometteva «ventuno regole» mentre il gate ne faceva girare
 * ventisei. Un numero scritto a mano invecchia sempre; qui invecchia rumoroso.
 */
describe('quante regole ha il controllo di qualità', () => {
  /** «26 regole», «26 controlli»: le forme in cui il numero viene citato. */
  const CITAZIONE_REGOLE = /(\d{1,3})\s+(regole|controlli)\b/g;

  /** In lettere, come si scrive in prosa. */
  const A_PAROLE: Record<string, number> = {
    quindici: 15,
    sedici: 16,
    diciassette: 17,
    diciotto: 18,
    diciannove: 19,
    venti: 20,
    ventuno: 21,
    ventidue: 22,
    ventitre: 23,
    ventitré: 23,
    ventiquattro: 24,
    venticinque: 25,
    ventisei: 26,
    ventisette: 27,
    ventotto: 28,
    ventinove: 29,
    trenta: 30,
  };
  /**
   * In lettere si accetta solo «regole».
   *
   * «Venti controlli disegnerebbero venti etichette diverse», in
   * `FieldShell.tsx`, parla dei controlli di un modulo: stessa parola, altro
   * mestiere. In cifre l'ambiguità non c'è — nessuno scrive «20 controlli»
   * per intendere le caselle di un campo — e la copertura resta piena.
   */
  const CITAZIONE_A_PAROLE = new RegExp(
    `\\b(${Object.keys(A_PAROLE).join('|')})\\s+regole\\b`,
    'gi',
  );

  /**
   * I documenti che raccontano un momento passato non si aggiornano.
   *
   * Un ADR è il verbale di una decisione presa in una data: riscriverne i
   * numeri falsificherebbe quello che si sapeva allora. Lo stesso vale per un
   * audit, che è la misura di un giorno.
   */
  const IMMUTABILI = ['/adr/', 'audit-'];

  it('è scritto allo stesso modo dappertutto', () => {
    const vero = QUALITY_RULES.length;
    const sbagliati: string[] = [];

    for (const file of [...CARTELLE.flatMap((d) => [...filesIn(d)]), ...FILE_SCIOLTI]) {
      if (file.endsWith('count.guard.test.ts')) continue;
      if (IMMUTABILI.some((frammento) => file.includes(frammento))) continue;
      const testo = readFileSync(file, 'utf8');

      for (const m of testo.matchAll(CITAZIONE_REGOLE)) {
        if (Number(m[1]) === vero) continue;
        sbagliati.push(`${file.slice(RADICE.length + 1)} → «${m[0]}» (sono ${String(vero)})`);
      }
      for (const m of testo.matchAll(CITAZIONE_A_PAROLE)) {
        const citato = A_PAROLE[(m[1] ?? '').toLowerCase()];
        if (citato === undefined || citato === vero) continue;
        sbagliati.push(`${file.slice(RADICE.length + 1)} → «${m[0]}» (sono ${String(vero)})`);
      }
    }

    expect([...new Set(sbagliati)].sort()).toEqual([]);
  });
});
