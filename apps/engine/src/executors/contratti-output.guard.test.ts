/**
 * I contratti di output devono dire il vero, per ogni nodo che ne dichiara uno.
 *
 * Un contratto sbagliato è **peggio di nessun contratto**. Senza, chi genera un
 * workflow indovina i nomi dei campi e a volte azzecca; con un contratto errato
 * scrive espressioni rotte con fiducia — e noi le abbiamo benedette. Lo schema
 * lo dice a chiare lettere: «NON-ASPIRAZIONALE: deve riflettere l'executor
 * REALE».
 *
 * Qui quella frase smette di essere una raccomandazione. Per ogni campo
 * dichiarato si va a vedere se compare nel sorgente che lo produce: aggiungere
 * un campo che l'executor non mette, o rinominarlo da una parte sola, diventa
 * rosso invece di lasciar generare workflow che leggono il vuoto.
 *
 * **Dove sta l'executor non è scritto a mano**: lo dice `registry.ts`, che è
 * l'autorità su chi esegue cosa. Una mappa parallela di 160 righe sarebbe
 * andata fuori sincrono al primo nodo spostato, e un guard fuori sincrono è un
 * guard che non guarda.
 *
 * Il confronto è sul TESTO e non sull'esecuzione: farli girare vorrebbe dire un
 * server IMAP, un broker Kafka e una casella PEC in piedi per controllare
 * l'ortografia di una chiave. La deriva che conta — un nome che cambia da una
 * parte sola — questo la prende.
 *
 * @module executors/contratti-output.guard.test
 */

import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { allNodeDefs, sorgentiExecutor, NON_CONFRONTABILI } from './contratti-output.mappa.js';

function testoDi(percorsi: readonly string[]): string {
  return percorsi
    .filter((p) => existsSync(p))
    .map((p) => readFileSync(p, 'utf8'))
    .join('\n');
}

/**
 * I nodi che possono restare senza contratto, e il motivo.
 *
 * Non è una lista di deroghe comode: è il posto in cui una mancanza diventa una
 * DECISIONE. Un nodo aggiunto domani senza `outputContract` fa diventare rosso
 * il test qui sotto, e chi lo aggiunge deve o dichiarare cosa produce, o
 * scrivere qui perché non può — con la ragione accanto, leggibile dal prossimo.
 */
const SENZA_CONTRATTO_AMMESSI: ReadonlyMap<string, string> = new Map([
  // Vuota, e va tenuta vuota finché si può. L'unica eccezione mai iscritta qui
  // è stata `db_subscribe`, e scriverne la ragione ha fatto capire che la
  // risposta giusta non era esentarlo: un nodo senza executor né watcher non
  // andava documentato, andava tolto dal catalogo (ADR 0010).
]);

describe('contratti di output — devono rispecchiare l’executor', () => {
  const tutti = allNodeDefs();
  const conContratto = tutti.filter((d) => d.outputContract !== undefined);

  it('c’è almeno un contratto da controllare', () => {
    expect(conContratto.length).toBeGreaterThan(0);
  });

  /**
   * La copertura non deve poter arretrare in silenzio.
   *
   * Senza questo, un nodo nuovo entra nel catalogo muto: il modello che genera
   * i workflow non sa cosa produce e ne inventa i campi — che è esattamente il
   * difetto da cui sono nati questi contratti.
   */
  it('ogni nodo dichiara cosa produce, o è un’eccezione motivata', () => {
    const muti = tutti
      .filter((d) => d.outputContract === undefined)
      .map((d) => d.id)
      .filter((id) => !SENZA_CONTRATTO_AMMESSI.has(id));
    expect(muti).toEqual([]);
  });

  /**
   * Un'eccezione che non serve più va tolta, non lasciata a coprire il nulla.
   *
   * Due modi di diventare inutile, e vanno visti entrambi: il nodo ha ottenuto
   * un contratto, oppure il nodo non esiste più. Una deroga rimasta lì a
   * coprire un nodo cancellato è rumore che la prossima persona legge come
   * informazione.
   */
  it('non restano eccezioni per nodi che hanno un contratto o non esistono più', () => {
    const superflue = [...SENZA_CONTRATTO_AMMESSI.keys()].filter(
      (id) => !tutti.some((d) => d.id === id) || conContratto.some((d) => d.id === id),
    );
    expect(superflue).toEqual([]);
  });

  it('ogni contratto dichiarato ha una sorgente da confrontare', () => {
    const orfani = conContratto
      .map((d) => d.id)
      .filter((id) => !NON_CONFRONTABILI.has(id) && sorgentiExecutor(id).length === 0);
    expect(orfani).toEqual([]);
  });

  for (const def of conContratto) {
    if (NON_CONFRONTABILI.has(def.id)) continue;

    it(`${def.id}: ogni campo dichiarato compare nel sorgente che lo produce`, () => {
      const testo = testoDi(sorgentiExecutor(def.id));
      expect(testo.length, `nessun sorgente leggibile per ${def.id}`).toBeGreaterThan(0);

      const mancanti = (def.outputContract?.fields ?? [])
        .map((f) => f.name)
        // I nomi fra parentesi angolari sono segnaposto per chiavi dinamiche.
        .filter((nome) => !nome.startsWith('<'))
        // Le forme in cui una chiave può nascere: `nome,` (shorthand), `nome:`
        // (esplicito), `nome?:` (dichiarata opzionale), `x.nome =` (aggiunta a
        // valle di una condizione), `'nome':` (chiave fra apici).
        .filter((nome) => !new RegExp(`['"\`]?\\b${nome}\\b['"\`]?\\s*\\??\\s*[,:=]`).test(testo));

      expect(mancanti).toEqual([]);
    });
  }
});
