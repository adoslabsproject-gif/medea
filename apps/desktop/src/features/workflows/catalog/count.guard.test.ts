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

import { STDLIB_NODES } from './index';

const RADICE = join(import.meta.dirname, '..', '..', '..', '..', '..', '..');

/** Dove si va a guardare: la documentazione e il codice, non i generati. */
const CARTELLE = [
  join(RADICE, 'docs'),
  join(RADICE, 'apps', 'desktop', 'src'),
  join(RADICE, 'scripts'),
];
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

    for (const dir of CARTELLE) {
      for (const file of filesIn(dir)) {
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
